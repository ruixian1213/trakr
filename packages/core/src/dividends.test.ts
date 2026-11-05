import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adjustedFlows, type DividendEvent, type FlowInput } from './dividends.ts'
import { twr } from './performance.ts'
import { tradeCashEffect } from './flow.ts'
import type { Trade } from './types.ts'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-03T02:00:00.000Z')
const EX = Date.parse('2026-11-10T01:00:00.000Z')
const EVENT: DividendEvent = { symbol: '2330', exMs: EX, cashPerShare: 5 }

// 1000 shares at 100 = 100,000. The ex-date drops the price to 95 and the 5 NT$ dividend lands as cash.
const before: FlowInput = { takenMs: T0, cash: 0, equity: 100_000, positions: [{ symbol: '2330', qty: 1000, avgPrice: 100, lastPrice: 100 }] }
const after: FlowInput = { takenMs: EX + DAY / 24, cash: 5_000, equity: 100_000, positions: [{ symbol: '2330', qty: 1000, avgPrice: 100, lastPrice: 95 }] }

test('a dividend paid in cash is income, not a deposit', () => {
  const flows = adjustedFlows([before, after], [], [EVENT])
  assert.deepEqual(flows, [0, 0])
  // Price fell 5 and cash rose 5 a share: the return is zero, as it should be.
  assert.equal(twr([{ takenAt: '', cash: 0, equity: 100_000, positions: [], flow: flows[0]! }, { takenAt: '', cash: 0, equity: 100_000, positions: [], flow: flows[1]! }]).totalReturn, 0)
})

test('without the dividend step the same cash would look like a deposit', () => {
  const naive = after.cash - before.cash
  assert.equal(naive, 5_000)
})

test('a real deposit on top of a dividend is still counted as a deposit', () => {
  const deposited: FlowInput = { ...after, cash: 25_000, equity: 120_000 }
  const flows = adjustedFlows([before, deposited], [], [EVENT])
  assert.equal(flows[1], 20_000)
})

test('shares sold before the ex-date earn no dividend; the same cash is a deposit', () => {
  const sold: Trade = { brokerTradeId: 's', symbol: '2330', side: 'sell', qty: 1000, price: 99, fee: 0, executedAt: new Date(T0 + DAY).toISOString() }
  // Everything was sold before ex-date. Cash now holds the sale proceeds plus the 5000, with nothing left to earn it.
  const proceeds = tradeCashEffect(sold)
  const soldAfter: FlowInput = { takenMs: after.takenMs, cash: proceeds + 5_000, equity: proceeds + 5_000, positions: [] }
  const flows = adjustedFlows([before, soldAfter], [sold], [EVENT])
  assert.equal(flows[1], 5_000)
})

test('expected dividends that never arrive expire', () => {
  const late: FlowInput = { takenMs: EX + 200 * DAY, cash: 0, equity: 100_000, positions: [{ symbol: '2330', qty: 1000, avgPrice: 100, lastPrice: 95 }] }
  const cashLater: FlowInput = { ...late, takenMs: late.takenMs + DAY, cash: 5_000, equity: 100_000 }
  // The dividend was never received inside the window, so this later cash is a deposit.
  const flows = adjustedFlows([before, after, late, cashLater], [], [EVENT])
  assert.equal(flows[3], 5_000)
})

test('other stocks’ dividends are ignored', () => {
  const flows = adjustedFlows([before, after], [], [{ ...EVENT, symbol: '2409' }])
  assert.equal(flows[1], 5_000)
})
