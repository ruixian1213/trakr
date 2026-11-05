import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'
import { MarketUnavailable, createMarket, num, rocToIso, type Fetcher } from './market.ts'

// Trimmed copies of real TWSE OpenAPI responses (2026-11-02).
const FIXTURES: Record<string, unknown> = {
  '/exchangeReport/STOCK_DAY_ALL': [
    { Date: '1151102', Code: '2330', Name: '台積電', TradeVolume: '41165068', TradeValue: '95950896264', OpeningPrice: '2310.00', HighestPrice: '2345.00', LowestPrice: '2310.00', ClosingPrice: '2330.00', Change: '-40.0000', Transaction: '298087' },
    { Date: '1151102', Code: '2409', Name: '友達', TradeVolume: '221130229', TradeValue: '6700000000', OpeningPrice: '29.20', HighestPrice: '31.25', LowestPrice: '29.10', ClosingPrice: '30.75', Change: '0.1000', Transaction: '78889' },
    { Date: '1151102', Code: '00625K', Name: '測試停牌', TradeVolume: '0', TradeValue: '0', OpeningPrice: '', HighestPrice: '', LowestPrice: '', ClosingPrice: '', Change: '0.0000', Transaction: '0' },
  ],
  '/exchangeReport/MI_INDEX20': [
    { Date: '20261102', Rank: '1', Code: '00406A', Name: '主動中信台灣收益', TradeVolume: '1016797756', Transaction: '145364', OpeningPrice: '8.47', HighestPrice: '8.67', LowestPrice: '8.41', ClosingPrice: '8.58', Dir: '-', Change: '0.02' },
    { Date: '20261102', Rank: '2', Code: '2409', Name: '友達', TradeVolume: '221130229', Transaction: '78889', OpeningPrice: '29.20', HighestPrice: '31.25', LowestPrice: '29.10', ClosingPrice: '30.75', Dir: '+', Change: '0.10' },
  ],
  '/exchangeReport/FMTQIK': [{ Date: '1151102', TradeVolume: '10422514115', TradeValue: '799687507911', Transaction: '4104242', TAIEX: '44920.14', Change: '-291.69' }],
  '/exchangeReport/MI_INDEX': [
    { 日期: '1151102', 指數: '寶島股價指數', 收盤指數: '49639.77', 漲跌: '-', 漲跌點數: '310.14', 漲跌百分比: '-0.62' },
    { 日期: '1151102', 指數: '發行量加權股價指數', 收盤指數: '44920.14', 漲跌: '-', 漲跌點數: '291.69', 漲跌百分比: '-0.65' },
    { 日期: '1151102', 指數: '臺灣50指數', 收盤指數: '31000.50', 漲跌: '+', 漲跌點數: '120.25', 漲跌百分比: '0.39' },
    { 日期: '1151102', 指數: '半導體類指數', 收盤指數: '9000.00', 漲跌: '-', 漲跌點數: '50.00', 漲跌百分比: '-0.55' },
  ],
}

function counting(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = []
  const fetcher: Fetcher = async (path) => {
    calls.push(path)
    const data = path in overrides ? overrides[path] : FIXTURES[path]
    if (data instanceof Error) throw data
    return data
  }
  return { calls, fetcher }
}

test('ROC dates and TWSE number strings parse', () => {
  assert.equal(rocToIso('1151102'), '2026-11-02')
  assert.equal(rocToIso('20261102'), null) // MI_INDEX20 uses a Gregorian date; callers handle it separately
  assert.equal(num('1,005.50'), 1005.5)
  assert.equal(num(''), null)
  assert.equal(num('--'), null)
  assert.equal(num(undefined), null)
})

test('overview: TAIEX, market totals and only the featured indices that exist', async () => {
  const m = createMarket(counting().fetcher)
  const { overview, asOf } = await m.overview()
  assert.equal(asOf, '2026-11-02')
  assert.equal(overview.taiex.close, 44920.14)
  assert.equal(overview.taiex.change, -291.69)
  assert.equal(overview.taiex.changePct, -0.65)
  assert.equal(overview.market.value, 799687507911)
  assert.deepEqual(overview.indices.map((i) => i.name), ['臺灣50指數', '半導體類指數'])
  assert.equal(overview.indices[0]!.change, 120.25, '+ direction keeps the sign positive')
})

test('top volume: Dir decides the sign and the percentage is computed from the previous close', async () => {
  const m = createMarket(counting().fetcher)
  const { rows } = await m.topVolume()
  assert.equal(rows[0]!.change, -0.02)
  assert.equal(rows[0]!.changePct, -0.23) // -0.02 / 8.60
  assert.equal(rows[1]!.change, 0.1)
  assert.equal(rows[1]!.rank, 2)
  assert.equal(rows[1]!.volume, 221130229)
})

test('quotes: change percentage, and suspended stocks report nulls instead of zeros', async () => {
  const m = createMarket(counting().fetcher)
  const { quote } = await m.quote('2330')
  assert.equal(quote!.close, 2330)
  assert.equal(quote!.change, -40)
  assert.equal(quote!.changePct, -1.69)
  const halted = (await m.quote('00625K')).quote!
  assert.equal(halted.close, null)
  assert.equal(halted.change, null)
  assert.equal(halted.changePct, null)
  assert.equal((await m.quote('9999')).quote, null)
})

test('search ranks an exact code first, then prefixes, then names', async () => {
  const m = createMarket(counting().fetcher)
  assert.deepEqual((await m.search('2330')).map((s) => s.code), ['2330'])
  assert.deepEqual((await m.search('友')).map((s) => s.code), ['2409'])
  assert.deepEqual((await m.search('00')).map((s) => s.code), ['00625K'])
  assert.deepEqual(await m.search('   '), [])
})

test('one upstream request serves many readers, and concurrent first requests share it', async () => {
  let clock = 0
  const { calls, fetcher } = counting()
  const m = createMarket(fetcher, { now: () => clock, ttlMs: 10 * 60_000 })
  await Promise.all([m.quote('2330'), m.quote('2409'), m.search('台')])
  await m.quote('2330')
  // Listed and OTC datasets are each fetched once, however many readers ask at the same time.
  const twse = () => calls.filter((c) => c === '/exchangeReport/STOCK_DAY_ALL').length
  const otc = () => calls.filter((c) => c.startsWith('https://')).length
  assert.equal(twse(), 1)
  assert.equal(otc(), 1)
  clock += 11 * 60_000
  await m.quote('2330')
  assert.equal(twse(), 2, 'refreshes after the TTL')
  assert.equal(otc(), 2, 'OTC refreshes after the TTL too')
})

test('when TWSE fails the last good copy is served and marked stale; with no copy it is unavailable', async () => {
  let clock = 0
  let down = false
  const fetcher: Fetcher = async (path) => {
    if (down) throw new Error('boom')
    return FIXTURES[path]
  }
  const m = createMarket(fetcher, { now: () => clock, ttlMs: 60_000 })
  assert.equal((await m.quote('2330')).stale, false)
  down = true
  clock += 120_000
  const r = await m.quote('2330')
  assert.equal(r.stale, true)
  assert.equal(r.quote!.close, 2330)

  const cold = createMarket(async () => {
    throw new Error('boom')
  })
  await assert.rejects(() => cold.quote('2330'), MarketUnavailable)
})

test('a malformed upstream response is treated as unavailable, not as empty data', async () => {
  const m = createMarket(counting({ '/exchangeReport/STOCK_DAY_ALL': { message: 'maintenance' } }).fetcher)
  await assert.rejects(() => m.quote('2330'), MarketUnavailable)
})

// ---------- HTTP layer ----------

function setup(fetcher: Fetcher = counting().fetcher) {
  const app = buildApp(openDb(':memory:'), { marketFetcher: fetcher })
  async function register(handle: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    return String(r.headers['set-cookie']).split(';')[0]!
  }
  const call = async (method: 'GET' | 'PUT' | 'DELETE', url: string, cookie?: string) => {
    const res = await app.inject({ method, url, headers: cookie ? { cookie } : {} })
    return { status: res.statusCode, body: res.json() as any, headers: res.headers }
  }
  return { app, register, call }
}

test('every market response carries the licence attribution', async () => {
  const s = setup()
  for (const url of ['/api/market/overview', '/api/market/top-volume', '/api/market/stocks/2330']) {
    const r = await s.call('GET', url)
    assert.equal(r.status, 200, url)
    assert.equal(r.body.source.agency, '臺灣證券交易所', url)
    assert.equal(r.body.source.licenseUrl, 'https://data.gov.tw/license', url)
    assert.match(r.body.source.licenseName, /政府資料開放授權條款/, url)
  }
})

test('shared market data is publicly cacheable, but anything personalised is not', async () => {
  const s = setup()
  assert.equal((await s.call('GET', '/api/market/overview')).headers['cache-control'], 'public, max-age=60')
  assert.equal((await s.call('GET', '/api/market/top-volume')).headers['cache-control'], 'public, max-age=60')
  // The stock page includes the viewer's own "watching" flag, and the watchlist is private.
  assert.equal((await s.call('GET', '/api/market/stocks/2330')).headers['cache-control'], 'no-store')
  const a = await s.register('alice')
  assert.equal((await s.call('GET', '/api/me/watchlist', a)).headers['cache-control'], 'no-store')
})

test('market endpoints validate input and report an outage as 503', async () => {
  const s = setup()
  assert.equal((await s.call('GET', '/api/market/stocks/bad%20code')).status, 400)
  assert.equal((await s.call('GET', '/api/market/stocks/9999')).status, 404)

  const down = setup(async () => {
    throw new Error('boom')
  })
  assert.equal((await down.call('GET', '/api/market/overview')).status, 503)
})

test('the watchlist needs a login, validates codes, and returns live quotes', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.call('GET', '/api/me/watchlist')).status, 401)
  assert.equal((await s.call('PUT', '/api/me/watchlist/2330')).status, 401)

  assert.equal((await s.call('PUT', '/api/me/watchlist/9999', a)).status, 404)
  assert.equal((await s.call('PUT', '/api/me/watchlist/bad%20code', a)).status, 400)
  assert.equal((await s.call('PUT', '/api/me/watchlist/2330', a)).status, 200)
  assert.equal((await s.call('PUT', '/api/me/watchlist/2330', a)).status, 200) // idempotent
  assert.equal((await s.call('PUT', '/api/me/watchlist/2409', a)).status, 200)

  const list = (await s.call('GET', '/api/me/watchlist', a)).body
  assert.deepEqual(list.items.map((i: any) => i.code), ['2409', '2330'], 'newest first')
  assert.equal(list.items[1].quote.close, 2330)
  assert.equal(list.source.agency, '臺灣證券交易所')

  assert.equal((await s.call('GET', '/api/market/stocks/2330', a)).body.watching, true)
  assert.equal((await s.call('GET', '/api/market/stocks/2330')).body.watching, false)

  await s.call('DELETE', '/api/me/watchlist/2330', a)
  assert.equal((await s.call('GET', '/api/me/watchlist', a)).body.items.length, 1)
})

test('watchlists are private to each user', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bobby')
  await s.call('PUT', '/api/me/watchlist/2330', a)
  assert.equal((await s.call('GET', '/api/me/watchlist', b)).body.items.length, 0)
  await s.call('DELETE', '/api/me/watchlist/2330', b)
  assert.equal((await s.call('GET', '/api/me/watchlist', a)).body.items.length, 1)
})

test('a watchlist is capped at 50 stocks', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ Date: '1151102', Code: String(1000 + i), Name: `股${i}`, TradeVolume: '1', TradeValue: '1', OpeningPrice: '10', HighestPrice: '10', LowestPrice: '10', ClosingPrice: '10', Change: '0', Transaction: '1' }))
  const s = setup(counting({ '/exchangeReport/STOCK_DAY_ALL': many }).fetcher)
  const a = await s.register('alice')
  for (let i = 0; i < 50; i++) assert.equal((await s.call('PUT', `/api/me/watchlist/${1000 + i}`, a)).status, 200)
  assert.equal((await s.call('PUT', '/api/me/watchlist/1050', a)).status, 400)
  assert.equal((await s.call('PUT', '/api/me/watchlist/1000', a)).status, 200) // re-adding an existing one is fine
})

test('the watchlist still lists codes when prices cannot be fetched', async () => {
  const db = openDb(':memory:')
  const app = buildApp(db, {
    marketFetcher: async () => {
      throw new Error('TWSE is down')
    },
  })
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'alice@example.test', handle: 'alice', password: 'correct-horse-1' } })
  const cookie = String(r.headers['set-cookie']).split(';')[0]!
  // Adding needs live data, so seed the list directly: this is the state after an earlier, successful session.
  const uid = (db.prepare('SELECT id FROM users WHERE handle = ?').get('alice') as { id: number }).id
  db.prepare('INSERT INTO watchlist (user_id, code, added_ms) VALUES (?, ?, ?)').run(uid, '2330', 1)

  const res = await app.inject({ method: 'GET', url: '/api/me/watchlist', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().unavailable, true)
  assert.deepEqual(res.json().items, [{ code: '2330', quote: null }])

  const add = await app.inject({ method: 'PUT', url: '/api/me/watchlist/2409', headers: { cookie } })
  assert.equal(add.statusCode, 503, 'adding while the data source is down fails cleanly')
})

// ---------- value ranking and stock names ----------

const withValues = [
  { Date: '1151102', Code: '1101', Name: '台泥', TradeVolume: '5000000', TradeValue: '200000000', OpeningPrice: '40', HighestPrice: '41', LowestPrice: '39', ClosingPrice: '40.00', Change: '0.5000', Transaction: '900' },
  { Date: '1151102', Code: '2330', Name: '台積電', TradeVolume: '41165068', TradeValue: '95950896264', OpeningPrice: '2310', HighestPrice: '2345', LowestPrice: '2310', ClosingPrice: '2330.00', Change: '-40.0000', Transaction: '298087' },
  { Date: '1151102', Code: '2454', Name: '聯發科', TradeVolume: '3000000', TradeValue: '49628000000', OpeningPrice: '1600', HighestPrice: '1700', LowestPrice: '1590', ClosingPrice: '1650.00', Change: '10.0000', Transaction: '50000' },
  { Date: '1151102', Code: '2409', Name: '友達', TradeVolume: '221130229', TradeValue: '6700000000', OpeningPrice: '29.2', HighestPrice: '31.25', LowestPrice: '29.1', ClosingPrice: '30.75', Change: '0.1000', Transaction: '78889' },
  { Date: '1151102', Code: '00625K', Name: '停牌', TradeVolume: '0', TradeValue: '0', OpeningPrice: '', HighestPrice: '', LowestPrice: '', ClosingPrice: '', Change: '0.0000', Transaction: '0' },
]

test('the value ranking sorts by trade value, not volume, and leaves out stocks that did not trade', async () => {
  const m = createMarket(counting({ '/exchangeReport/STOCK_DAY_ALL': withValues }).fetcher)
  const { rows, asOf } = await m.topValue()
  assert.equal(asOf, '2026-11-02')
  // 友達 has by far the most shares traded but ranks third by value: that is the whole point of the second list.
  assert.deepEqual(rows.map((r) => [r.rank, r.code, r.name]), [
    [1, '2330', '台積電'],
    [2, '2454', '聯發科'],
    [3, '2409', '友達'],
    [4, '1101', '台泥'],
  ])
  assert.equal(rows[0]!.value, 95950896264)
  assert.equal(rows[0]!.changePct, -1.69)
})

test('the value ranking is capped at 20 rows', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...withValues[0]!, Code: String(2000 + i), Name: `股${i}`, TradeValue: String(1_000_000 + i) }))
  const m = createMarket(counting({ '/exchangeReport/STOCK_DAY_ALL': many }).fetcher)
  const { rows } = await m.topValue()
  assert.equal(rows.length, 20)
  assert.equal(rows[0]!.code, '2039')
})

test('stock names resolve, unknown codes are skipped, and an outage yields an empty map instead of throwing', async () => {
  const m = createMarket(counting().fetcher)
  const names = await m.names(['2330', '2409', '9999'])
  assert.equal(names.get('2330'), '台積電')
  assert.equal(names.has('9999'), false)

  const down = createMarket(async () => {
    throw new Error('boom')
  })
  assert.equal((await down.names(['2330'])).size, 0)
})

test('GET /api/market/top-value carries the attribution and is publicly cacheable', async () => {
  const s = setup(counting({ '/exchangeReport/STOCK_DAY_ALL': withValues }).fetcher)
  const r = await s.call('GET', '/api/market/top-value')
  assert.equal(r.status, 200)
  assert.equal(r.body.rows[0].code, '2330')
  assert.equal(r.body.source.licenseUrl, 'https://data.gov.tw/license')
  assert.equal(r.headers['cache-control'], 'public, max-age=60')
  const down = setup(async () => {
    throw new Error('boom')
  })
  assert.equal((await down.call('GET', '/api/market/top-value')).status, 503)
})

/** A signed-in user with two imported trades, well in the past so the display delay is irrelevant. */
async function userWithTrades(s: ReturnType<typeof setup>) {
  const cookie = await s.register('alice')
  const csv = ['time,symbol,side,qty,price', '2020-01-02 09:15,2330,buy,1000,300', '2020-01-02 10:00,7777,sell,1000,50'].join('\n')
  const r = await s.app.inject({ method: 'POST', url: '/api/me/csv-import', headers: { cookie }, payload: { csv } })
  assert.equal(r.statusCode, 200)
  return cookie
}

test('trade lists include the stock name, and null for a code TWSE does not list', async () => {
  const s = setup()
  await userWithTrades(s)
  const { trades } = (await s.call('GET', '/api/traders/alice/trades')).body
  const byCode = Object.fromEntries(trades.map((t: any) => [t.symbol, t.name]))
  assert.equal(byCode['2330'], '台積電')
  assert.equal(byCode['7777'], null)
})

test('trade lists still load, just without names, when TWSE is down', async () => {
  const s = setup(async () => {
    throw new Error('TWSE is down')
  })
  await userWithTrades(s)
  const r = await s.call('GET', '/api/traders/alice/trades')
  assert.equal(r.status, 200)
  assert.equal(r.body.trades.length, 2)
  assert.ok(r.body.trades.every((t: any) => t.name === null))
})

test('the followed-traders feed includes stock names', async () => {
  const s = setup()
  await userWithTrades(s)
  const fan = await s.register('fanuser')
  await s.call('PUT', '/api/me/watchlist/2330', fan) // unrelated: proves the shared cache serves both
  await s.app.inject({ method: 'POST', url: '/api/traders/alice/follow', headers: { cookie: fan } })
  const feed = (await s.call('GET', '/api/feed', fan)).body.trades
  assert.equal(feed.find((t: any) => t.symbol === '2330').name, '台積電')
})

test('holdings include stock names', async () => {
  const s = setup()
  const cookie = await s.register('alice')
  const key = (await s.app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })).json().key as string
  const res = await s.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${key}` },
    payload: {
      broker: 'shioaji',
      accountFingerprint: 'acct-alice'.padEnd(32, 'x'),
      snapshot: { takenAt: new Date().toISOString(), cash: 100000, positions: [{ symbol: '2330', qty: 1000, avgPrice: 2300, lastPrice: 2330 }] },
    },
  })
  assert.equal(res.statusCode, 200)
  const h = (await s.call('GET', '/api/traders/alice/holdings', cookie)).body
  assert.equal(h.holdings[0].symbol, '2330')
  assert.equal(h.holdings[0].name, '台積電')
})
