import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

function setup() {
  let clock = Date.parse('2026-11-03T01:00:00.000Z')
  const app = buildApp(openDb(':memory:'), { now: () => clock })
  async function register(handle: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    return String(r.headers['set-cookie']).split(';')[0]!
  }
  const put = (cookie: string | undefined, payload: object) =>
    app.inject({ method: 'PUT', url: '/api/me/profile', payload, headers: cookie ? { cookie } : {} })
  const get = async (url: string, cookie?: string) => (await app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })).json() as any
  const report = (cookie: string, handle: string) =>
    app.inject({ method: 'POST', url: '/api/report', payload: { type: 'profile', handle }, headers: { cookie } })
  return { app, register, put, get, report, advance: (ms: number) => (clock += ms) }
}

test('a bio and links are saved, and the public page shows addresses built by the server', async () => {
  const s = setup()
  const a = await s.register('alice')
  const r = await s.put(a, {
    bio: '全職交易人，專注半導體。\n不構成投資建議。',
    links: [
      { platform: 'instagram', handle: 'https://www.instagram.com/john.doe/?hl=zh-tw' },
      { platform: 'threads', handle: '@alice_t' },
      { platform: 'line', handle: 'alice-line' },
    ],
  })
  assert.equal(r.statusCode, 200)

  const pub = await s.get('/api/traders/alice') // no login needed
  assert.equal(pub.bio, '全職交易人，專注半導體。\n不構成投資建議。')
  assert.deepEqual(
    pub.links.map((l: any) => [l.platform, l.handle, l.url]),
    [
      ['instagram', 'john.doe', 'https://www.instagram.com/john.doe/'],
      ['threads', 'alice_t', 'https://www.threads.com/@alice_t'],
      ['line', 'alice-line', 'https://line.me/ti/p/~alice-line'],
    ],
  )
  assert.equal(pub.links[0].label, 'Instagram')
  assert.equal((await s.get('/api/me', a)).links.length, 3)
})

test('saving requires a login', async () => {
  const s = setup()
  assert.equal((await s.put(undefined, { bio: 'hi' })).statusCode, 401)
})

test('the bio is limited in length and lines, and stored as plain text', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.put(a, { bio: '字'.repeat(160) })).statusCode, 200)
  assert.equal((await s.put(a, { bio: '字'.repeat(161) })).statusCode, 400)
  assert.equal((await s.put(a, { bio: 'a\nb\nc\nd\ne' })).statusCode, 400)
  assert.equal((await s.put(a, { bio: 'a\nb\nc\nd' })).statusCode, 200)
  assert.equal((await s.put(a, { bio: 42 })).statusCode, 400)

  const r = await s.put(a, { bio: '  <script>alert(1)</script>\u0000\u0007 hi  ' })
  assert.equal(r.json().bio, '<script>alert(1)</script> hi', 'markup kept as text, control characters removed')
})

test('only recognised account names are accepted as links', async () => {
  const s = setup()
  const a = await s.register('alice')
  const bad = async (platform: string, handle: unknown) => (await s.put(a, { links: [{ platform, handle }] })).statusCode
  assert.equal(await bad('instagram', 'https://evil.com/john'), 400)
  assert.equal(await bad('instagram', 'https://instagram.com.evil.com/john'), 400)
  assert.equal(await bad('instagram', 'javascript:alert(1)'), 400)
  assert.equal(await bad('line', 'https://line.me/ti/g/AbCdEfGh12'), 400, 'LINE group invites are refused')
  assert.equal(await bad('telegram', 'https://t.me/+AbCdEf123456'), 400, 'Telegram private invites are refused')
  assert.equal(await bad('myspace', 'tom'), 400)
  assert.equal(await bad('__proto__', 'tom'), 400)
  assert.equal(await bad('instagram', 'has space'), 400)
  assert.equal(await bad('instagram', 123), 400)
  const msg = (await s.put(a, { links: [{ platform: 'x', handle: 'a'.repeat(30) }] })).json().error
  assert.match(msg, /X/, 'the error names the platform')
})

test('one link per platform and at most six links', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.put(a, { links: [{ platform: 'x', handle: 'one' }, { platform: 'x', handle: 'two' }] })).statusCode, 400)
  const seven = ['threads', 'instagram', 'x', 'facebook', 'youtube', 'tiktok', 'telegram'].map((platform) => ({ platform, handle: 'validname' }))
  assert.equal((await s.put(a, { links: seven })).statusCode, 400)
  assert.equal((await s.put(a, { links: seven.slice(0, 6) })).statusCode, 200)
  assert.equal((await s.put(a, { links: 'nope' })).statusCode, 400)
})

test('omitted fields are left alone, an empty list clears, and a bad request changes nothing', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.put(a, { bio: 'first', links: [{ platform: 'x', handle: 'alice' }] })

  await s.put(a, { bio: 'second' }) // links omitted
  let me = await s.get('/api/me', a)
  assert.equal(me.bio, 'second')
  assert.equal(me.links.length, 1)

  await s.put(a, { links: [{ platform: 'threads', handle: 'alice' }] }) // bio omitted
  me = await s.get('/api/me', a)
  assert.equal(me.bio, 'second')
  assert.deepEqual(me.links.map((l: any) => l.platform), ['threads'], 'links are replaced, not merged')

  const bad = await s.put(a, { bio: 'third', links: [{ platform: 'instagram', handle: 'https://evil.com/x' }] })
  assert.equal(bad.statusCode, 400)
  me = await s.get('/api/me', a)
  assert.equal(me.bio, 'second', 'a rejected link must not let the bio half-save')
  assert.equal(me.links.length, 1)

  await s.put(a, { links: [] })
  assert.equal((await s.get('/api/me', a)).links.length, 0)
})

test('profiles are per user', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bobby')
  await s.put(a, { bio: 'alice here', links: [{ platform: 'x', handle: 'alice' }] })
  const other = await s.get('/api/traders/bobby')
  assert.equal(other.bio, '')
  assert.deepEqual(other.links, [])
  await s.put(b, { bio: 'bobby here' })
  assert.equal((await s.get('/api/traders/alice')).bio, 'alice here')
})

test('three reports hide a profile from everyone but its owner; duplicates and self-reports do not count', async () => {
  const s = setup()
  const owner = await s.register('spammer')
  const r1 = await s.register('rep1x')
  const r2 = await s.register('rep2x')
  const r3 = await s.register('rep3x')
  await s.put(owner, { bio: '加我 LINE 帶你賺', links: [{ platform: 'line', handle: 'scam-id' }] })

  assert.equal((await s.report(owner, 'spammer')).statusCode, 400, 'cannot report yourself')
  assert.equal((await s.report(r1, 'nobody')).statusCode, 404)
  assert.equal((await s.app.inject({ method: 'POST', url: '/api/report', payload: { type: 'profile', handle: 'spammer' } })).statusCode, 401)

  await s.report(r1, 'spammer')
  await s.report(r1, 'spammer') // same reporter twice is one report
  await s.report(r2, 'spammer')
  assert.equal((await s.get('/api/traders/spammer')).bio, '加我 LINE 帶你賺', 'two reports are not enough')

  await s.report(r3, 'spammer')
  const hidden = await s.get('/api/traders/spammer')
  assert.equal(hidden.bio, '')
  assert.deepEqual(hidden.links, [])
  assert.equal(hidden.profileHidden, true)
  assert.equal(hidden.handle, 'spammer', 'the account itself is not removed')

  const own = await s.get('/api/me', owner)
  assert.equal(own.bio, '加我 LINE 帶你賺', 'the owner can still see and fix their own text')
  assert.equal(own.profileHidden, true)
})

test('profile updates are rate limited', async () => {
  const s = setup()
  const a = await s.register('alice')
  for (let i = 0; i < 30; i++) assert.equal((await s.put(a, { bio: `v${i}` })).statusCode, 200)
  assert.equal((await s.put(a, { bio: 'one too many' })).statusCode, 429)
  s.advance(61 * 60_000)
  assert.equal((await s.put(a, { bio: 'ok again' })).statusCode, 200)
})
