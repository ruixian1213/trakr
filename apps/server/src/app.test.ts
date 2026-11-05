import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

// Tuesday 2026-11-03 01:00Z = 09:00 Taipei.
const T0 = Date.parse('2026-11-03T01:00:00.000Z')
const MIN = 60_000

function setup() {
  let clock = T0
  const app = buildApp(openDb(':memory:'), { now: () => clock, minClosedTrades: 1, minSnapshots: 2 })
  const advance = (ms: number) => (clock += ms)
  const iso = (ms = clock) => new Date(ms).toISOString()

  /** A signed-in user: a browser session cookie plus an agent key. Ingest uses the key, everything else the cookie. */
  interface User {
    cookie: string
    key: string
  }
  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who?: User, payload?: unknown) {
    const headers: Record<string, string> = {}
    if (who) {
      if (url === '/api/ingest') headers.authorization = `Bearer ${who.key}`
      else headers.cookie = who.cookie
    }
    const res = await app.inject({ method, url, payload: payload as object | undefined, headers })
    return { status: res.statusCode, body: res.json() as any }
  }
  async function register(handle: string): Promise<User> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' },
    })
    const cookie = String(r.headers['set-cookie']).split(';')[0]!
    const k = await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })
    return { cookie, key: k.json().key }
  }
  const fp = (n: string) => n.padEnd(32, 'x')
  const pos = (symbol: string, qty: number, price = 100) => ({ symbol, qty, avgPrice: price, lastPrice: price })
  return { app, call, register, advance, iso, fp, pos, now: () => clock }
}

const creds = (email: string, password = 'correct-horse-1') => ({ email, password })

test('delay hides fresh trades from others but not from the owner', async () => {
  const s = setup()
  const tok = await s.register('alice')
  const r = await s.call('POST', '/api/ingest', tok, {
    broker: 'shioaji',
    accountFingerprint: s.fp('acct-a'),
    trades: [{ brokerTradeId: 'o1:1', symbol: '2330', side: 'buy', qty: 1000, price: 600, executedAt: s.iso() }],
    snapshot: { takenAt: s.iso(), cash: 400_000, positions: [s.pos('2330', 1000, 600)] },
  })
  assert.equal(r.body.accepted, 1)

  assert.equal((await s.call('GET', '/api/traders/alice/trades')).body.trades.length, 0)
  assert.equal((await s.call('GET', '/api/traders/alice/trades', tok)).body.trades.length, 1)

  s.advance(4 * MIN)
  assert.equal((await s.call('GET', '/api/traders/alice/trades')).body.trades.length, 0)
  s.advance(1 * MIN)
  assert.equal((await s.call('GET', '/api/traders/alice/trades')).body.trades.length, 1)
})

test('delay cannot be set below 3 minutes', async () => {
  const s = setup()
  const tok = await s.register('alice')
  const r = await s.call('PUT', '/api/me/settings', tok, { delaySec: 5 })
  assert.equal(r.body.delaySec, 180)
})

test('rejects backfill, dedupes, and locks the account', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bob')
  const base = { broker: 'shioaji', accountFingerprint: s.fp('acct-a') }

  s.advance(10 * MIN)
  const old = { brokerTradeId: 'x', symbol: '2330', side: 'buy', qty: 1000, price: 600, executedAt: new Date(T0 - MIN).toISOString() }
  const fresh = { ...old, brokerTradeId: 'y', executedAt: s.iso() }

  const first = await s.call('POST', '/api/ingest', a, { ...base, trades: [fresh] })
  // The bind happens at T0+10m, so a trade at T0-1m is before it.
  const back = await s.call('POST', '/api/ingest', a, { ...base, trades: [old] })
  assert.equal(first.body.accepted, 1)
  assert.equal(back.body.rejected, 1)

  const dup = await s.call('POST', '/api/ingest', a, { ...base, trades: [fresh] })
  assert.equal(dup.body.duplicates, 1)

  assert.equal((await s.call('POST', '/api/ingest', b, base)).status, 409) // same broker account, other user
  assert.equal((await s.call('POST', '/api/ingest', a, { ...base, accountFingerprint: s.fp('acct-z') })).status, 409)
})

test('hash chain verifies after several ingests', async () => {
  const s = setup()
  const a = await s.register('alice')
  const base = { broker: 'shioaji', accountFingerprint: s.fp('acct-a') }
  for (let i = 0; i < 3; i++) {
    s.advance(MIN)
    await s.call('POST', '/api/ingest', a, {
      ...base,
      trades: [{ brokerTradeId: `t${i}`, symbol: '2330', side: 'buy', qty: 1000, price: 600 + i, executedAt: s.iso() }],
    })
  }
  const r = await s.call('GET', '/api/traders/alice/integrity')
  assert.equal(r.body.chain.ok, true)
  assert.equal(r.body.trades, 3)
})

test('holdings honour visibility mode and delay', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.call('POST', '/api/ingest', a, {
    broker: 'shioaji',
    accountFingerprint: s.fp('acct-a'),
    snapshot: { takenAt: s.iso(), cash: 0, positions: [s.pos('2330', 1000, 75), s.pos('2317', 1000, 25)] },
  })
  s.advance(6 * MIN)

  let h = (await s.call('GET', '/api/traders/alice/holdings')).body
  assert.equal(h.mode, 'public')
  assert.equal(h.holdings[0].qty, 1000)

  await s.call('PUT', '/api/me/settings', a, { holdingsVisibility: 'ratio' })
  h = (await s.call('GET', '/api/traders/alice/holdings')).body
  assert.equal(h.holdings[0].weight, 0.75)
  assert.equal(h.holdings[0].qty, undefined)

  await s.call('PUT', '/api/me/settings', a, { holdingsVisibility: 'hidden' })
  h = (await s.call('GET', '/api/traders/alice/holdings')).body
  assert.deepEqual(h.holdings, [])
  // The owner still sees their own book.
  assert.equal((await s.call('GET', '/api/traders/alice/holdings', a)).body.holdings.length, 2)
})

test('leaderboard ranks eligible traders and ignores deposits', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bob')
  const run = async (tok: Awaited<ReturnType<typeof s.register>>, acct: string, endCash: number, deposit = 0) => {
    const base = { broker: 'shioaji', accountFingerprint: s.fp(acct) }
    await s.call('POST', '/api/ingest', tok, { ...base, snapshot: { takenAt: s.iso(), cash: 1_000_000, positions: [] } })
    s.advance(MIN)
    await s.call('POST', '/api/ingest', tok, {
      ...base,
      trades: [
        { brokerTradeId: 'b', symbol: '2330', side: 'buy', qty: 1000, price: 500, executedAt: s.iso() },
        { brokerTradeId: 's', symbol: '2330', side: 'sell', qty: 1000, price: 600, executedAt: s.iso(s.now() + 1) },
      ],
      snapshot: { takenAt: s.iso(s.now() + 2), cash: endCash + deposit, positions: [] },
    })
    s.advance(MIN)
  }
  // Alice nets ~+10% (sale proceeds net of fee/tax simplified by server tolerance), Bob deposits 1M and gains the same.
  await run(a, 'acct-a', 1_099_000)
  await run(b, 'acct-b', 1_099_000, 1_000_000)

  const lb = (await s.call('GET', '/api/leaderboard')).body
  assert.equal(lb.entries.length, 2)
  const [first, second] = lb.entries
  assert.ok(Math.abs(first.totalReturn - second.totalReturn) < 0.002, 'deposit must not inflate return')
  assert.ok(first.totalReturn > 0.09)
})

test('silence during market hours creates a gap and removes the trader from the board', async () => {
  const s = setup()
  const a = await s.register('alice')
  const base = { broker: 'shioaji', accountFingerprint: s.fp('acct-a') }
  const send = (cash: number, withTrades: boolean) =>
    s.call('POST', '/api/ingest', a, {
      ...base,
      trades: withTrades
        ? [
            { brokerTradeId: `b${s.now()}`, symbol: '2330', side: 'buy', qty: 1000, price: 100, executedAt: s.iso() },
            { brokerTradeId: `s${s.now()}`, symbol: '2330', side: 'sell', qty: 1000, price: 110, executedAt: s.iso(s.now() + 1) },
          ]
        : [],
      snapshot: { takenAt: s.iso(s.now() + 2), cash, positions: [] },
    })
  await send(1_000_000, false)
  s.advance(MIN)
  await send(1_009_000, true)
  assert.equal((await s.call('GET', '/api/leaderboard')).body.entries.length, 1)

  s.advance(2 * 3600_000) // agent offline for 2h inside the trading session
  await send(1_009_000, false)
  assert.equal((await s.call('GET', '/api/leaderboard')).body.entries.length, 0)
  assert.equal((await s.call('GET', '/api/traders/alice/integrity')).body.gaps.length, 1)
})

test('holdings that disagree with trades are flagged', async () => {
  const s = setup()
  const a = await s.register('alice')
  const base = { broker: 'shioaji', accountFingerprint: s.fp('acct-a') }
  await s.call('POST', '/api/ingest', a, { ...base, snapshot: { takenAt: s.iso(), cash: 1_000_000, positions: [] } })
  s.advance(MIN)
  // Reports 1000 shares with no matching buy trade.
  const r = await s.call('POST', '/api/ingest', a, {
    ...base,
    snapshot: { takenAt: s.iso(), cash: 900_000, positions: [s.pos('2330', 1000)] },
  })
  assert.equal(r.body.reconciled, false)
})

test('follow and feed respect the trader delay', async () => {
  const s = setup()
  const a = await s.register('alice')
  const f = await s.register('fan')
  await s.call('POST', '/api/traders/alice/follow', f)
  await s.call('POST', '/api/ingest', a, {
    broker: 'shioaji',
    accountFingerprint: s.fp('acct-a'),
    trades: [{ brokerTradeId: 'o', symbol: '2330', side: 'buy', qty: 1000, price: 600, executedAt: s.iso() }],
  })
  assert.equal((await s.call('GET', '/api/feed', f)).body.trades.length, 0)
  s.advance(5 * MIN)
  assert.equal((await s.call('GET', '/api/feed', f)).body.trades.length, 1)
  assert.equal((await s.call('POST', '/api/traders/fan/follow', f)).status, 400)
})
