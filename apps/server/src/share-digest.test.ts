import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'
import { unsubscribeToken } from './digest.ts'

const T0 = Date.parse('2026-11-03T02:00:00.000Z')
const SECRET = 'test-secret-value-long-enough'

function harness(sent: { to: string; subject: string; text: string }[], failSend = false) {
  let clock = T0
  const mailer = {
    async send(to: string, subject: string, text: string) {
      if (failSend) throw new Error('provider down')
      sent.push({ to, subject, text })
    },
  }
  const app = buildApp(openDb(':memory:'), {
    now: () => clock,
    minClosedTrades: 1,
    minSnapshots: 1,
    publicUrl: 'https://trakr.test',
    digest: { secret: SECRET, mailer },
  })
  const register = async (handle: string) => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!
    const key = (await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })).json().key as string
    return { cookie, key }
  }
  return { app, register, setClock: (ms: number) => (clock = ms) }
}

test('share pages carry preview tags and a real HTML body; unknown traders get a 404', async () => {
  const h = harness([])
  await h.register('alice')
  const page = await h.app.inject({ method: 'GET', url: '/t/alice' })
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /property="og:title" content="alice · Trakr"/)
  assert.match(page.body, /canonical" href="https:\/\/trakr\.test\/t\/alice"/)
  assert.equal((await h.app.inject({ method: 'GET', url: '/t/nobody' })).statusCode, 404)
})

test('robots.txt points at the sitemap; the sitemap is valid XML', async () => {
  const h = harness([])
  const robots = await h.app.inject({ method: 'GET', url: '/robots.txt' })
  assert.match(robots.body, /Sitemap: https:\/\/trakr\.test\/sitemap\.xml/)
  const sitemap = await h.app.inject({ method: 'GET', url: '/sitemap.xml' })
  assert.match(sitemap.body, /^<\?xml/)
  assert.match(sitemap.body, /<urlset /)
})

test('digest: opt-in only, one email per new trade, unsubscribe works, bad tokens are refused', async () => {
  const sent: { to: string; subject: string; text: string }[] = []
  const h = harness(sent)
  const alice = await h.register('alice')
  const bob = await h.register('bob')
  await h.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${alice.key}` },
    payload: {
      broker: 'shioaji',
      accountFingerprint: 'acct-a'.padEnd(32, 'x'),
      trades: [{ brokerTradeId: 'o1:1', symbol: '2330', side: 'buy', qty: 1000, price: 600, executedAt: new Date(T0).toISOString() }],
      snapshot: { takenAt: new Date(T0).toISOString(), cash: 0, positions: [{ symbol: '2330', qty: 1000, avgPrice: 600, lastPrice: 600 }] },
    },
  })
  await h.app.inject({ method: 'POST', url: '/api/traders/alice/follow', headers: { cookie: bob.cookie } })

  // Bob has not opted in yet: nothing is sent.
  h.setClock(T0 + 60 * 60_000)
  await (h.app as unknown as { runDigest(): Promise<void> }).runDigest()
  assert.equal(sent.length, 0)

  // Opt in, then the trade (visible after alice's 5 minute delay) is sent once.
  assert.equal((await h.app.inject({ method: 'PUT', url: '/api/me/settings', headers: { cookie: bob.cookie }, payload: { emailDigest: true } })).statusCode, 200)
  await (h.app as unknown as { runDigest(): Promise<void> }).runDigest()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.to, 'bob@example.test')
  assert.match(sent[0]!.text, /2330/)
  assert.match(sent[0]!.text, /不構成任何投資建議/)
  const link = sent[0]!.text.match(/取消訂閱：(\S+)/)![1]!
  assert.match(link, /^https:\/\/trakr\.test\/api\/digest\/unsubscribe\?u=\d+&t=[0-9a-f]{64}$/)

  // Nothing new since, so no second email.
  await (h.app as unknown as { runDigest(): Promise<void> }).runDigest()
  assert.equal(sent.length, 1)

  // A forged token is refused; the real one switches the digest off.
  const bobId = Number(new URL(link).searchParams.get('u'))
  const forged = await h.app.inject({ method: 'GET', url: `/api/digest/unsubscribe?u=${bobId}&t=${'0'.repeat(64)}` })
  assert.equal(forged.statusCode, 400)
  const real = await h.app.inject({ method: 'GET', url: `/api/digest/unsubscribe?u=${bobId}&t=${unsubscribeToken(bobId, SECRET)}` })
  assert.equal(real.statusCode, 200)
  const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: bob.cookie } })
  assert.equal(me.json().emailDigest, false)
})

test('a failed send is retried on the next run, not dropped', async () => {
  const sent: { to: string; subject: string; text: string }[] = []
  const failing = harness(sent, true)
  const alice = await failing.register('alice')
  const bob = await failing.register('bob')
  await failing.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${alice.key}` },
    payload: {
      broker: 'shioaji',
      accountFingerprint: 'acct-a'.padEnd(32, 'x'),
      trades: [{ brokerTradeId: 'o1:1', symbol: '2330', side: 'buy', qty: 1000, price: 600, executedAt: new Date(T0).toISOString() }],
      snapshot: { takenAt: new Date(T0).toISOString(), cash: 0, positions: [] },
    },
  })
  await failing.app.inject({ method: 'POST', url: '/api/traders/alice/follow', headers: { cookie: bob.cookie } })
  await failing.app.inject({ method: 'PUT', url: '/api/me/settings', headers: { cookie: bob.cookie }, payload: { emailDigest: true } })
  failing.setClock(T0 + 60 * 60_000)
  await (failing.app as unknown as { runDigest(): Promise<void> }).runDigest()
  assert.equal(sent.length, 0, 'the provider failed, so nothing was recorded as sent')
})
