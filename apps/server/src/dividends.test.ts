import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'
import type { Fetcher } from './market.ts'

const T0 = Date.parse('2026-11-03T02:00:00.000Z')
const EX_DAY = Date.parse('2026-11-10T02:00:00.000Z')

// 2330 goes ex-dividend on 2026-11-10 (ROC 1151110) with a 5 NT$ cash dividend.
const TWT48U = [{ Date: '1151110', Code: '2330', Name: '台積電', Exdividend: '息', CashDividend: '5', StockDividendRatio: '' }]

test('a cash dividend lifts cash without counting as a deposit, so the return is not understated', async () => {
  let clock = T0
  const fetcher: Fetcher = async (path) => {
    if (path === '/exchangeReport/TWT48U_ALL') return TWT48U
    throw new Error('no fixture for ' + path)
  }
  const app = buildApp(openDb(':memory:'), { now: () => clock, marketFetcher: fetcher })
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@example.test', handle: 'alice', password: 'correct-horse-1' } })
  const cookie = String(reg.headers['set-cookie']).split(';')[0]!
  const key = (await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })).json().key as string
  const ingest = (takenAt: string, cash: number, lastPrice: number) =>
    app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        broker: 'shioaji',
        accountFingerprint: 'acct-a'.padEnd(32, 'x'),
        trades: [],
        snapshot: { takenAt, cash, positions: [{ symbol: '2330', qty: 1000, avgPrice: 100, lastPrice }] },
      },
    })

  // Before ex-date: 1000 shares at 100 = 100,000.
  assert.equal((await ingest(new Date(T0).toISOString(), 0, 100)).statusCode, 200)
  // Ex-date passed: price 95 and the 5,000 dividend in cash. Equity is unchanged.
  clock = EX_DAY + 60 * 60_000
  assert.equal((await ingest(new Date(EX_DAY).toISOString(), 5_000, 95)).statusCode, 200)

  const res = await app.inject({ method: 'GET', url: '/api/traders/alice' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().totalReturn, 0)
})

function harness(rows: Record<string, unknown>[]) {
  let clock = T0
  const fetcher: Fetcher = async (path) => {
    if (path === '/exchangeReport/TWT48U_ALL') return rows
    throw new Error('no fixture for ' + path)
  }
  const app = buildApp(openDb(':memory:'), { now: () => clock, marketFetcher: fetcher })
  const register = async (handle: string) => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!
    const key = (await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })).json().key as string
    return { cookie, key }
  }
  return { app, register, setClock: (ms: number) => (clock = ms) }
}

test('a held stock with a stock dividend keeps the trader off the leaderboard until it is verified', async () => {
  const h = harness([{ Date: '1151110', Code: '2330', Name: '台積電', Exdividend: '權息', CashDividend: '5', StockDividendRatio: '1' }])
  const alice = await h.register('alice')
  const ingest = (takenAt: string, cash: number, lastPrice: number) =>
    h.app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { authorization: `Bearer ${alice.key}` },
      payload: { broker: 'shioaji', accountFingerprint: 'acct-a'.padEnd(32, 'x'), trades: [], snapshot: { takenAt, cash, positions: [{ symbol: '2330', qty: 1000, avgPrice: 100, lastPrice }] } },
    })
  await ingest(new Date(T0).toISOString(), 0, 100)
  h.setClock(EX_DAY + 60 * 60_000)
  await ingest(new Date(EX_DAY).toISOString(), 5_000, 95)
  const res = await h.app.inject({ method: 'GET', url: '/api/traders/alice' })
  assert.ok(res.json().ineligibleReasons.includes('stock_dividend_unverified'))
})

test('uploaded holdings never appear in the followed-holders list', async () => {
  const h = harness([])
  const alice = await h.register('alice')
  const bob = await h.register('bob')
  const carol = await h.register('carol')
  await h.app.inject({ method: 'POST', url: '/api/traders/alice/follow', headers: { cookie: bob.cookie } })
  await h.app.inject({ method: 'POST', url: '/api/traders/carol/follow', headers: { cookie: bob.cookie } })
  await h.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${alice.key}` },
    payload: { broker: 'shioaji', accountFingerprint: 'acct-a'.padEnd(32, 'x'), trades: [], snapshot: { takenAt: new Date(T0 - 10 * 60_000).toISOString(), cash: 0, positions: [{ symbol: '2330', qty: 1000, avgPrice: 100, lastPrice: 100 }] } },
  })
  const up = await h.app.inject({
    method: 'POST',
    url: '/api/me/holdings-import',
    headers: { cookie: carol.cookie },
    payload: { asOf: '2026-11-02', csv: '股票代號,股數\n2330,5000' },
  })
  assert.equal(up.statusCode, 200)
  const r = await h.app.inject({ method: 'GET', url: '/api/market/stocks/2330/followed-holders', headers: { cookie: bob.cookie } })
  assert.deepEqual(r.json().holders.map((x: { handle: string }) => x.handle), ['alice'])
})

test('your own trades stay out of the follow feed; you can find any trader by ID prefix', async () => {
  const h = harness([])
  const alice = await h.register('alice')
  await h.register('alina')
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
  const feed = await h.app.inject({ method: 'GET', url: '/api/feed', headers: { cookie: alice.cookie } })
  assert.equal(feed.json().trades.length, 0, 'not followed, so not in the feed')
  const mine = await h.app.inject({ method: 'GET', url: '/api/traders/alice/trades', headers: { cookie: alice.cookie } })
  assert.equal(mine.json().trades.length, 1, 'owner sees their own trades without delay')

  const found = await h.app.inject({ method: 'GET', url: '/api/traders/search?q=AL' })
  assert.deepEqual(found.json().results.map((r: { handle: string }) => r.handle), ['alice', 'alina'])
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/traders/search?q=a%25' })).json().results, [], 'wildcards are not searched')
})
