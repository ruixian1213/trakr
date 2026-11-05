import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'
import { archiveHolders, holderHistory, parseTdcc, summarize, tdccDate } from './holders.ts'
import type { Fetcher } from './market.ts'

// Tuesday 2026-11-03 01:00Z = 09:00 Taipei.
const T0 = Date.parse('2026-11-03T01:00:00.000Z')
const MIN = 60_000

/** One TDCC week for one stock. Levels 12–15 carry the given percentages; level 17 is the total. */
function tdccWeek(date: string, code: string, big: { p12: number; p13: number; p14: number; p15: number; n15: number }): string[] {
  const lines: string[] = []
  for (let level = 1; level <= 17; level++) {
    const pct = level === 12 ? big.p12 : level === 13 ? big.p13 : level === 14 ? big.p14 : level === 15 ? big.p15 : 0
    const people = level === 15 ? big.n15 : level === 17 ? 1000 : 1
    const shares = level === 17 ? 1_000_000 : Math.round(pct * 10_000)
    lines.push(`${date},${code},${level},${people},${shares},${level === 17 ? '100.00' : pct.toFixed(2)}`)
  }
  return lines
}
const TDCC_HEADER = '資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%'
const csvOf = (...lines: string[][]) => '﻿' + [TDCC_HEADER, ...lines.flat()].join('\n') + '\n'

const WEEK1 = { p12: 5, p13: 3, p14: 2, p15: 10, n15: 40 }
const WEEK2 = { p12: 6, p13: 3, p14: 2, p15: 12, n15: 45 }

test('TDCC dates and rows parse; bad rows are skipped and counted, not guessed', () => {
  assert.equal(tdccDate('20261030'), '2026-10-30')
  assert.equal(tdccDate('2026-10-30'), null)
  const { rows, skipped } = parseTdcc(csvOf(tdccWeek('20261030', '2330', WEEK2), ['20261030,2330,99,1,1,0.00', '20261030,2330,3,x,1,0.00']))
  assert.equal(rows.length, 17)
  assert.equal(skipped, 2)
  assert.equal(rows[0]!.asOf, '2026-10-30')
})

test('TDCC pads codes with trailing spaces ("0050  "); those rows must still parse', () => {
  const padded = csvOf(tdccWeek('20261030', '0050  ', WEEK2))
  const { rows, skipped } = parseTdcc(padded)
  assert.equal(skipped, 0)
  assert.equal(rows[0]!.code, '0050')
})

test('summary: 400-lot and 1000-lot shares and holder counts', () => {
  const { rows } = parseTdcc(csvOf(tdccWeek('20261030', '2330', WEEK2)))
  const s = summarize(rows)!
  assert.equal(s.asOf, '2026-10-30')
  assert.equal(s.totalPeople, 1000)
  assert.equal(s.pct400, 23)
  assert.equal(s.pct1000, 12)
  assert.equal(s.people1000, 45)
})

test('archive keeps each week once, and history shows the latest week against the one before', async () => {
  const db = openDb(':memory:')
  await archiveHolders(db, async () => csvOf(tdccWeek('20261023', '2330', WEEK1)))
  const r = await archiveHolders(db, async () => csvOf(tdccWeek('20261023', '2330', WEEK1), tdccWeek('20261030', '2330', WEEK2)))
  assert.equal(r.weeks, 2)
  const h = holderHistory(db, '2330')
  assert.equal(h.current!.asOf, '2026-10-30')
  assert.equal(h.previous!.asOf, '2026-10-23')
  assert.equal(h.current!.pct400 - h.previous!.pct400, 3, 'big-holder share rose by three points')
  assert.equal(h.current!.people1000 - h.previous!.people1000, 5)
  // Re-running with the same week stores nothing new: 17 levels × 2 weeks.
  await archiveHolders(db, async () => csvOf(tdccWeek('20261030', '2330', WEEK2)))
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM holder_weeks').get() as { n: number }).n, 34)
})

test('history reports no trend until a second week exists', async () => {
  const db = openDb(':memory:')
  await archiveHolders(db, async () => csvOf(tdccWeek('20261030', '2330', WEEK2)))
  const h = holderHistory(db, '2330')
  assert.ok(h.current)
  assert.equal(h.previous, null)
})

// ---------- app-level behaviour ----------

function setup() {
  let clock = T0
  const holderText = { value: csvOf(tdccWeek('20261030', '2330', WEEK2)) }
  const marketData: Record<string, unknown> = {
    '/exchangeReport/MI_MARGN': [{ 股票代號: '2330', 股票名稱: '台積電', 融資前日餘額: '1000', 融資今日餘額: '1200', 融券前日餘額: '50', 融券今日餘額: '40' }],
    '/exchangeReport/TWT48U_ALL': [
      { Date: '1151110', Code: '2330', Name: '台積電', Exdividend: '息', CashDividend: '6.0', StockDividendRatio: '' },
      { Date: '1151110', Code: '2409', Name: '友達', Exdividend: '權', CashDividend: '', StockDividendRatio: '0.5' },
    ],
  }
  const fetcher: Fetcher = async (path) => {
    if (path in marketData) return marketData[path]
    throw new Error('no fixture for ' + path)
  }
  const app = buildApp(openDb(':memory:'), {
    now: () => clock,
    marketFetcher: fetcher,
    holderFetcher: async () => holderText.value,
    minClosedTrades: 1,
    minSnapshots: 2,
  })
  const advance = (ms: number) => (clock += ms)
  const iso = (ms = clock) => new Date(ms).toISOString()

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie?: string, payload?: unknown) {
    const res = await app.inject({ method, url, payload: payload as object | undefined, headers: cookie ? { cookie } : {} })
    return { status: res.statusCode, body: res.json() as any }
  }
  async function register(handle: string): Promise<{ cookie: string; key: string }> {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    const cookie = String(r.headers['set-cookie']).split(';')[0]!
    const k = await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })
    return { cookie, key: k.json().key }
  }
  const fp = (n: string) => n.padEnd(32, 'x')
  const pos = (symbol: string, qty: number, price = 100) => ({ symbol, qty, avgPrice: price, lastPrice: price })
  return { app, call, register, advance, iso, fp, pos, holderText, now: () => clock }
}

test('notifications: a followed trade appears only after the trader’s delay has passed', async () => {
  const s = setup()
  const alice = await s.register('alice')
  const bob = await s.register('bob')
  await s.call('POST', '/api/traders/alice/follow', bob.cookie)
  // Bob's first visit starts the clock; nothing older counts as new.
  assert.equal((await s.call('GET', '/api/me/notifications', bob.cookie)).body.unread, 0)

  await s.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${alice.key}` },
    payload: {
      broker: 'shioaji',
      accountFingerprint: s.fp('acct-a'),
      trades: [{ brokerTradeId: 'o1:1', symbol: '2330', side: 'buy', qty: 1000, price: 600, executedAt: s.iso() }],
      snapshot: { takenAt: s.iso(), cash: 400_000, positions: [s.pos('2330', 1000, 600)] },
    },
  })
  assert.equal((await s.call('GET', '/api/me/notifications', bob.cookie)).body.unread, 0, 'still inside the delay')

  s.advance(5 * MIN)
  const n = await s.call('GET', '/api/me/notifications', bob.cookie)
  assert.equal(n.body.unread, 1)
  assert.equal(n.body.trades[0].symbol, '2330')

  assert.equal((await s.call('POST', '/api/me/notifications/seen', bob.cookie)).status, 200)
  assert.equal((await s.call('GET', '/api/me/notifications', bob.cookie)).body.unread, 0)
})

test('followed holders: a hidden holding never appears, and an unfollowed trader is not listed', async () => {
  const s = setup()
  const alice = await s.register('alice')
  const carol = await s.register('carol')
  const bob = await s.register('bob')
  await s.call('POST', '/api/traders/alice/follow', bob.cookie)
  await s.call('POST', '/api/traders/carol/follow', bob.cookie)
  await s.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${alice.key}` },
    payload: { broker: 'shioaji', accountFingerprint: s.fp('acct-a'), trades: [], snapshot: { takenAt: s.iso(s.now() - 10 * MIN), cash: 1, positions: [s.pos('2330', 1000, 600)] } },
  })
  await s.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${carol.key}` },
    payload: { broker: 'shioaji', accountFingerprint: s.fp('acct-c'), trades: [], snapshot: { takenAt: s.iso(s.now() - 10 * MIN), cash: 1, positions: [s.pos('2330', 500, 600)] } },
  })
  // Bob follows both. Carol keeps her holding hidden, so Bob must not see it.
  await s.call('PUT', '/api/me/settings', carol.cookie, { holdingsVisibility: 'hidden' })

  const r = await s.call('GET', '/api/market/stocks/2330/followed-holders', bob.cookie)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.holders.map((h: { handle: string }) => h.handle), ['alice'])
  assert.equal(r.body.holders[0].qty, 1000)
  assert.equal(r.body.holders[0].level, 2)

  assert.equal((await s.call('GET', '/api/market/stocks/2330/followed-holders')).status, 401)
})

test('details: TDCC holders, margin, and ex-dividend, each reported on its own', async () => {
  const s = setup()
  const r = await s.call('GET', '/api/market/stocks/2330/details')
  assert.equal(r.status, 200)
  assert.equal(r.body.holders.source.datasets, '集保戶股權分散表')
  assert.equal(r.body.holders.current.pct400, 23)
  assert.equal(r.body.margin.row.margin, 1200)
  assert.equal(r.body.margin.row.short, 40)
  assert.equal(r.body.exDividend.rows.length, 1, 'only this stock’s announcements')
  assert.equal(r.body.exDividend.rows[0].cashDividend, 6)
  assert.equal(r.body.exDividend.rows[0].date, '2026-11-10')

  assert.equal((await s.call('GET', '/api/market/stocks/!!/details')).status, 400)
})

test('details: when TDCC is down the rest of the page still loads', async () => {
  const app = buildApp(openDb(':memory:'), {
    now: () => T0,
    marketFetcher: async (p) => {
      if (p === '/exchangeReport/MI_MARGN') return []
      throw new Error('down')
    },
    holderFetcher: async () => {
      throw new Error('tdcc down')
    },
  })
  const res = await app.inject({ method: 'GET', url: '/api/market/stocks/2330/details' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().holders, null)
  assert.equal(res.json().exDividend, null)
  assert.equal(res.json().margin.row, null, 'no margin row for this stock')
})
