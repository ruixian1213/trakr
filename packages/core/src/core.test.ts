import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GENESIS_HASH,
  clampDelay,
  inferFlow,
  isVisible,
  overlapsMarketHours,
  ratioHoldings,
  reconcile,
  tradeHash,
  tradeStats,
  twr,
  verifyChain,
  type Snapshot,
  type Trade,
} from './index.ts'

const t = (id: string, side: 'buy' | 'sell', qty: number, price: number, at: string, symbol = '2330'): Trade => ({
  brokerTradeId: id,
  symbol,
  side,
  qty,
  price,
  executedAt: at,
})

const snap = (takenAt: string, equity: number, flow = 0): Snapshot => ({ takenAt, equity, flow, cash: equity, positions: [] })

test('hash chain verifies and detects tampering', () => {
  const a = t('1', 'buy', 1000, 100, '2026-11-03T01:00:00.000Z')
  const b = t('2', 'sell', 1000, 110, '2026-11-03T02:00:00.000Z')
  const ha = tradeHash(GENESIS_HASH, a)
  const hb = tradeHash(ha, b)
  const rows = [
    { trade: a, prevHash: GENESIS_HASH, hash: ha },
    { trade: b, prevHash: ha, hash: hb },
  ]
  assert.deepEqual(verifyChain(rows), { ok: true })
  rows[0]!.trade = { ...a, price: 90 }
  assert.deepEqual(verifyChain(rows), { ok: false, brokenAt: 0 })
})

test('twr ignores deposits', () => {
  // +10% on 100k, then a 100k deposit, then flat: TWR is still 10%.
  const r = twr([snap('2026-11-01T00:00:00Z', 100_000), snap('2026-11-02T00:00:00Z', 110_000), snap('2026-11-03T00:00:00Z', 210_000, 100_000)])
  assert.ok(Math.abs(r.totalReturn - 0.1) < 1e-9)
})

test('twr max drawdown', () => {
  const r = twr([snap('2026-11-01T00:00:00Z', 100), snap('2026-11-02T00:00:00Z', 120), snap('2026-11-03T00:00:00Z', 90)])
  assert.ok(Math.abs(r.maxDrawdown - 0.25) < 1e-9)
})

test('tradeStats uses FIFO and counts each closing sell', () => {
  const s = tradeStats([
    t('1', 'buy', 1000, 100, '2026-11-02T01:00:00Z'),
    t('2', 'buy', 1000, 120, '2026-11-02T02:00:00Z'),
    t('3', 'sell', 1500, 110, '2026-11-03T01:00:00Z'), // 1000@100 (+10k) + 500@120 (-5k) = +5k
    t('4', 'sell', 500, 100, '2026-11-03T02:00:00Z'), // 500@120 => -10k
  ])
  assert.equal(s.closedTrades, 2)
  assert.equal(s.wins, 1)
  assert.equal(s.winRate, 0.5)
  assert.equal(s.realizedPnl, -5000)
})

test('inferFlow separates trades from deposits', () => {
  const buy = t('1', 'buy', 1000, 100, '2026-11-03T01:00:00Z')
  assert.equal(inferFlow(500_000, 400_000, [buy], 500_000), 0)
  assert.equal(inferFlow(500_000, 900_000, [buy], 600_000), 500_000)
  assert.equal(inferFlow(500_000, 100_000, [], 500_000), -400_000)
})

test('reconcile flags drift', () => {
  const base = [{ symbol: '2330', qty: 1000, avgPrice: 100, lastPrice: 100 }]
  const trades = [t('1', 'buy', 2000, 100, '2026-11-03T01:00:00Z', '2317')]
  assert.deepEqual(reconcile(base, trades, [{ symbol: '2330', qty: 1000, avgPrice: 0, lastPrice: 0 }, { symbol: '2317', qty: 2000, avgPrice: 0, lastPrice: 0 }]), [])
  assert.equal(reconcile(base, trades, [{ symbol: '2330', qty: 1000, avgPrice: 0, lastPrice: 0 }]).length, 1)
})

test('delay clamps to 3-30 minutes and gates visibility', () => {
  assert.equal(clampDelay(0), 180)
  assert.equal(clampDelay(300), 300)
  assert.equal(clampDelay(99999), 1800)
  assert.equal(isVisible(1000, 300, 1000 + 299_000), false)
  assert.equal(isVisible(1000, 300, 1000 + 300_000), true)
})

test('ratioHoldings hides share counts', () => {
  const r = ratioHoldings([
    { symbol: 'A', qty: 1, avgPrice: 1, lastPrice: 75 },
    { symbol: 'B', qty: 1, avgPrice: 1, lastPrice: 25 },
  ])
  assert.deepEqual(r, [{ symbol: 'A', weight: 0.75 }, { symbol: 'B', weight: 0.25 }])
})

test('overlapsMarketHours', () => {
  // Tue 2026-11-03 00:00Z..00:30Z is before the 01:00Z open; 01:00Z..02:00Z is inside.
  assert.equal(overlapsMarketHours(Date.parse('2026-11-03T00:00:00Z'), Date.parse('2026-11-03T00:30:00Z')), false)
  assert.equal(overlapsMarketHours(Date.parse('2026-11-03T01:10:00Z'), Date.parse('2026-11-03T02:00:00Z')), true)
  // Saturday only.
  assert.equal(overlapsMarketHours(Date.parse('2026-11-07T00:00:00Z'), Date.parse('2026-11-07T23:00:00Z')), false)
})
