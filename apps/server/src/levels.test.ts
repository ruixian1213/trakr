import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const T0 = Date.parse('2026-11-03T01:00:00.000Z') // Tue 09:00 Taipei
const MIN = 60_000

function setup() {
  let clock = T0
  const app = buildApp(openDb(':memory:'), { now: () => clock, minClosedTrades: 1, minSnapshots: 1 })
  const advance = (ms: number) => (clock += ms)
  const iso = (ms = clock) => new Date(ms).toISOString()

  async function register(handle: string) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' },
    })
    const cookie = String(r.headers['set-cookie']).split(';')[0]!
    const k = await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })
    return { cookie, key: k.json().key as string }
  }
  const importCsv = (cookie: string | undefined, csv: string) =>
    app.inject({ method: 'POST', url: '/api/me/csv-import', headers: cookie ? { cookie } : {}, payload: { csv } })
  const get = async (url: string, cookie?: string) => {
    const r = await app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })
    return r.json() as any
  }
  return { app, register, importCsv, get, advance, iso }
}

// Executed well before "now" so the 5-minute display delay has long passed.
const CSV = [
  'time,symbol,side,qty,price,fee',
  '2026-11-02 09:15,2330,buy,1000,600,855',
  '2026-11-02 10:30,2330,sell,1000,650,925',
].join('\n')

test('a CSV upload makes the user Level 1 and shows the trades as unverified', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.get('/api/traders/alice')).level, 0)

  const r = await s.importCsv(a.cookie, CSV)
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().imported, 2)

  const t = await s.get('/api/traders/alice')
  assert.equal(t.level, 1)
  assert.equal(t.csvTrades, 2)
  const trades = (await s.get('/api/traders/alice/trades')).trades
  assert.equal(trades.length, 2)
  assert.ok(trades.every((x: any) => x.verified === false))
})

test('Level 1 never reaches the verified leaderboard, however good the record', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.importCsv(a.cookie, CSV)
  const t = await s.get('/api/traders/alice')
  assert.equal(t.eligible, false)
  assert.ok(t.ineligibleReasons.includes('no_account'))
  assert.equal((await s.get('/api/leaderboard')).entries.length, 0)
})

test('re-importing the same file adds nothing', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.importCsv(a.cookie, CSV)
  const again = (await s.importCsv(a.cookie, CSV)).json()
  assert.equal(again.imported, 0)
  assert.equal(again.duplicates, 2)
  assert.equal((await s.get('/api/traders/alice')).csvTrades, 2)
})

test('bad files are rejected with line-level errors; good rows in a mixed file still import', async () => {
  const s = setup()
  const a = await s.register('alice')
  const bad = await s.importCsv(a.cookie, 'foo,bar\n1,2')
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().errors[0].message, /找不到欄位/)

  const mixed = (await s.importCsv(a.cookie, CSV + '\nnot-a-date,2330,buy,1000,600,0')).json()
  assert.equal(mixed.imported, 2)
  assert.equal(mixed.rejected, 1)
  assert.equal(mixed.errors[0].line, 4)
})

test('future-dated rows are refused', async () => {
  const s = setup()
  const a = await s.register('alice')
  const r = (await s.importCsv(a.cookie, 'time,symbol,side,qty,price\n2027-01-01 09:00,2330,buy,1000,600')).json()
  assert.equal(r.imported, 0)
  assert.equal(r.rejected, 1)
  assert.equal((await s.get('/api/traders/alice')).csvTrades, 0)
})

test('importing requires a login', async () => {
  const s = setup()
  assert.equal((await s.importCsv(undefined, CSV)).statusCode, 401)
})

test('linking a broker makes the user Level 2 without letting CSV rows touch the verified record', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.importCsv(a.cookie, CSV)

  // Broker sync starts now: one verified round trip.
  s.advance(10 * MIN)
  const bearer = { authorization: `Bearer ${a.key}` }
  const fp = 'acct-alice'.padEnd(32, 'x')
  await s.app.inject({ method: 'POST', url: '/api/ingest', headers: bearer, payload: { broker: 'shioaji', accountFingerprint: fp, snapshot: { takenAt: s.iso(), cash: 1_000_000, positions: [] } } })
  s.advance(MIN)
  const res = await s.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: bearer,
    payload: {
      broker: 'shioaji',
      accountFingerprint: fp,
      trades: [
        { brokerTradeId: 'b', symbol: '2317', side: 'buy', qty: 1000, price: 100, executedAt: s.iso() },
        { brokerTradeId: 's', symbol: '2317', side: 'sell', qty: 1000, price: 110, executedAt: s.iso(Date.parse(s.iso()) + 1) },
      ],
      snapshot: { takenAt: s.iso(Date.parse(s.iso()) + 2), cash: 1_009_000, positions: [] },
    },
  })
  assert.equal(res.json().accepted, 2)

  const t = await s.get('/api/traders/alice')
  assert.equal(t.level, 2)
  assert.equal(t.csvTrades, 2)
  assert.equal(t.closedTrades, 1, 'the 2330 CSV round trip must not count')

  const integrity = await s.get('/api/traders/alice/integrity')
  assert.equal(integrity.chain.ok, true)
  assert.equal(integrity.trades, 2, 'CSV rows stay outside the hash chain')

  s.advance(10 * MIN)
  const all = (await s.get('/api/traders/alice/trades')).trades
  assert.equal(all.length, 4)
  assert.equal(all.filter((x: any) => x.verified).length, 2)
})

test('the user can clear their CSV rows', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.importCsv(a.cookie, CSV)
  const del = await s.app.inject({ method: 'DELETE', url: '/api/me/csv-import', headers: { cookie: a.cookie } })
  assert.equal(del.json().removed, 2)
  assert.equal((await s.get('/api/traders/alice')).level, 0)
})
