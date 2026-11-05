import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const MIN = 60_000

// Stock names come from TWSE. Serve a fixed list so the test never depends on the live site.
const fixtureMarket = async (path: string) => {
  if (path === '/exchangeReport/STOCK_DAY_ALL') {
    return [
      { Date: '1151103', Code: '2330', Name: '台積電', ClosingPrice: '600', Change: '0' },
      { Date: '1151103', Code: '2317', Name: '鴻海', ClosingPrice: '120', Change: '0' },
      { Date: '1151103', Code: '2454', Name: '聯發科', ClosingPrice: '100', Change: '0' },
    ]
  }
  throw new Error('no fixture for ' + path)
}

function setup() {
  let clock = Date.parse('2026-11-03T01:00:00.000Z') // Tue 09:00 Taipei
  const app = buildApp(openDb(':memory:'), { now: () => clock, minClosedTrades: 1, minSnapshots: 1, marketFetcher: fixtureMarket })
  const advance = (ms: number) => (clock += ms)

  async function register(handle: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    const cookie = String(r.headers['set-cookie']).split(';')[0]!
    const k = await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })
    return { cookie, key: k.json().key as string }
  }
  const snap = (cookie: string, asOf: string, csv: string) =>
    app.inject({ method: 'POST', url: '/api/me/holdings-import', headers: { cookie }, payload: { asOf, csv } })
  const trades = (cookie: string, csv: string) =>
    app.inject({ method: 'POST', url: '/api/me/csv-import', headers: { cookie }, payload: { csv } })
  const holdings = async (handle: string, cookie?: string) =>
    (await app.inject({ method: 'GET', url: `/api/traders/${handle}/holdings`, headers: cookie ? { cookie } : {} })).json() as any
  const byCode = (h: any) => Object.fromEntries(h.holdings.map((x: any) => [x.symbol, x.qty]))
  return { app, advance, register, snap, trades, holdings, byCode, clock: () => clock }
}

const HOLD = '股票代號,股數,均價\n2330,2000,580\n2317,1000,120'
const TRADES = 'time,symbol,side,qty,price\n2026-11-02 10:00,2330,sell,1000,600\n2026-11-02 10:30,2454,buy,1000,100'

test('a holdings snapshot plus later trades gives the current position; earlier trades are ignored', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.snap(a.cookie, '2026-10-30', HOLD)).statusCode, 200)
  // Before the snapshot: already reflected in it, so it must not be applied again.
  await s.trades(a.cookie, 'time,symbol,side,qty,price\n2026-10-29 10:00,2317,buy,500,118')
  await s.trades(a.cookie, TRADES)

  const own = await s.holdings('alice', a.cookie)
  assert.equal(own.source, 'csv')
  assert.equal(own.asOf, '2026-10-30T05:30:00.000Z')
  assert.deepEqual(s.byCode(own), { '2317': 1000, '2330': 1000, '2454': 1000 })
  assert.equal(own.holdings.find((h: any) => h.symbol === '2330').name, '台積電', 'names come from TWSE data as for any holding')
})

test('others see the position only with the trader\'s delay applied, and see it catch up later', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.snap(a.cookie, '2026-10-30', HOLD)
  await s.trades(a.cookie, TRADES)
  // 08:58 Taipei is 00:58Z: inside the five-minute delay at 01:00Z, so others must not see it yet.
  await s.trades(a.cookie, 'time,symbol,side,qty,price\n2026-11-03 08:58,2330,sell,500,600')

  assert.equal(s.byCode(await s.holdings('alice', a.cookie))['2330'], 500, 'owner sees everything at once')
  assert.equal(s.byCode(await s.holdings('alice'))['2330'], 1000, 'others do not yet')
  s.advance(10 * MIN)
  assert.equal(s.byCode(await s.holdings('alice'))['2330'], 500, 'others see it once the delay has passed')
})

test('a second snapshot is checked against the first plus the trades in between', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.snap(a.cookie, '2026-10-30', HOLD)
  await s.trades(a.cookie, TRADES)
  const ok = await s.snap(a.cookie, '2026-11-02', '股票代號,股數\n2330,1000\n2317,1000\n2454,1000')
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().reconciledWith, '2026-10-30')
  assert.deepEqual(ok.json().mismatches, [], 'the snapshot agrees with the trades')
})

test('a disagreeing snapshot is accepted but the difference is recorded on the account', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.snap(a.cookie, '2026-10-30', HOLD)
  await s.trades(a.cookie, TRADES)
  const r = await s.snap(a.cookie, '2026-11-02', '股票代號,股數\n2330,1000\n2317,1000\n2454,900')
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.json().mismatches, [{ symbol: '2454', expected: 1000, reported: 900 }])

  const listed = (await s.app.inject({ method: 'GET', url: '/api/me/holdings-import', headers: { cookie: a.cookie } })).json().snapshots
  assert.equal(listed[0].asOf, '2026-11-02')
  assert.equal(listed[0].mismatches.length, 1)
})

test('an empty snapshot is valid and means nothing is held that day', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.snap(a.cookie, '2026-10-30', HOLD)
  const empty = await s.snap(a.cookie, '2026-11-02', '')
  assert.equal(empty.statusCode, 200)
  assert.equal((await s.holdings('alice', a.cookie)).holdings.length, 0)
})

test('a broker-verified snapshot newer than the uploaded one takes over', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.snap(a.cookie, '2026-10-30', HOLD)
  s.advance(MIN)
  await s.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${a.key}` },
    payload: {
      broker: 'shioaji',
      accountFingerprint: 'acct-alice'.padEnd(32, 'x'),
      snapshot: { takenAt: new Date(s.clock()).toISOString(), cash: 1000, positions: [{ symbol: '2330', qty: 777, avgPrice: 600, lastPrice: 600 }] },
    },
  })
  const own = await s.holdings('alice', a.cookie)
  assert.equal(own.source, undefined, 'the broker snapshot, not the uploaded one')
  assert.deepEqual(s.byCode(own), { '2330': 777 })
})

test('under ratio visibility others get no quantities from an uploaded snapshot', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.snap(a.cookie, '2026-10-30', HOLD)
  await s.app.inject({ method: 'PUT', url: '/api/me/settings', headers: { cookie: a.cookie }, payload: { holdingsVisibility: 'ratio' } })
  const others = await s.holdings('alice')
  assert.deepEqual(others.holdings, [])
  assert.equal(others.note, 'ratio_unavailable', 'without market values a weight cannot be computed honestly')
  assert.equal((await s.holdings('alice', a.cookie)).holdings.length, 2)
})

test('a trade that would sell more than was held is flagged', async () => {
  const s = setup()
  const a = await s.register('alice')
  await s.snap(a.cookie, '2026-10-30', '股票代號,股數\n2330,1000')
  await s.trades(a.cookie, 'time,symbol,side,qty,price\n2026-11-02 10:00,2330,sell,1500,600')
  const own = await s.holdings('alice', a.cookie)
  assert.deepEqual(own.negative, ['2330'])
  assert.equal(own.note, 'negative_holdings')
})

test('validation: login, date, future date, bad rows and duplicate days', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.app.inject({ method: 'POST', url: '/api/me/holdings-import', payload: { asOf: '2026-10-30', csv: HOLD } })).statusCode, 401)
  assert.equal((await s.snap(a.cookie, '10/30/2026', HOLD)).statusCode, 400, 'only YYYY-MM-DD is accepted')
  assert.equal((await s.snap(a.cookie, '2027-01-01', HOLD)).statusCode, 400, 'future snapshots are refused')

  const bad = await s.snap(a.cookie, '2026-10-30', '股票代號,股數\nxx-bad,100\n2330,1000')
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().errors[0].line, 2)

  assert.equal((await s.snap(a.cookie, '2026-10-30', HOLD)).statusCode, 200)
  assert.equal((await s.snap(a.cookie, '2026-10-30', HOLD)).statusCode, 409, 'one snapshot per day')
})

test('a snapshot can be deleted by its owner only', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bobby')
  await s.snap(a.cookie, '2026-10-30', HOLD)
  const id = (await s.app.inject({ method: 'GET', url: '/api/me/holdings-import', headers: { cookie: a.cookie } })).json().snapshots[0].id
  const other = await s.app.inject({ method: 'DELETE', url: `/api/me/holdings-import/${id}`, headers: { cookie: b.cookie } })
  assert.equal(other.statusCode, 404)
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/me/holdings-import/${id}`, headers: { cookie: a.cookie } })).statusCode, 200)
  assert.equal((await s.holdings('alice', a.cookie)).asOf, null)
})
