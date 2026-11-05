import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTrades, compareLines, parseHoldingsCsv, type HoldingLine, type Trade } from './index.ts'

const t = (side: 'buy' | 'sell', symbol: string, qty: number, at: string): Trade => ({
  brokerTradeId: `${symbol}-${at}`,
  symbol,
  side,
  qty,
  price: 100,
  executedAt: at,
})

test('a snapshot with a header and rows parses to shares and optional cost', () => {
  const r = parseHoldingsCsv('股票代號,股數,均價\n2330,2000,580.5\n2317,"1,000",120')
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.lines, [
    { symbol: '2330', qty: 2000, avgPrice: 580.5 },
    { symbol: '2317', qty: 1000, avgPrice: 120 },
  ])
})

test('lots are converted to shares', () => {
  const r = parseHoldingsCsv('code,lots\n2330,2')
  assert.deepEqual(r.lines, [{ symbol: '2330', qty: 2000, avgPrice: null }])
})

test('an empty file or a header alone is a valid snapshot of nothing held', () => {
  assert.deepEqual(parseHoldingsCsv(''), { lines: [], errors: [] })
  assert.deepEqual(parseHoldingsCsv('股票代號,股數\n'), { lines: [], errors: [] })
})

test('bad rows are reported with line numbers and the rest still parses', () => {
  const r = parseHoldingsCsv('股票代號,股數\n2330,1000\nxx-bad,1000\n2317,-5\n2454,1000\n2454,500')
  assert.deepEqual(r.lines.map((l) => l.symbol), ['2330', '2454'])
  assert.deepEqual(r.errors.map((e) => e.line), [3, 4, 6])
})

test('a file without the required columns is refused with a plain explanation', () => {
  const r = parseHoldingsCsv('foo,bar\n1,2')
  assert.equal(r.lines.length, 0)
  assert.match(r.errors[0]!.message, /找不到欄位/)
})

test('trades move a snapshot forward; a sold-out position disappears; a touched cost becomes unknown', () => {
  const start: HoldingLine[] = [
    { symbol: '2330', qty: 2000, avgPrice: 580 },
    { symbol: '2317', qty: 1000, avgPrice: 120 },
  ]
  const r = applyTrades(start, [t('sell', '2330', 2000, '2026-11-02 10:00'), t('buy', '2454', 1000, '2026-11-02 10:30')])
  assert.deepEqual(r.negative, [])
  assert.deepEqual(r.lines, [
    { symbol: '2317', qty: 1000, avgPrice: 120 },
    { symbol: '2454', qty: 1000, avgPrice: null },
  ])
})

test('a position that would go negative is reported, not silently clipped', () => {
  const r = applyTrades([{ symbol: '2330', qty: 1000, avgPrice: 500 }], [t('sell', '2330', 1500, '2026-11-02 10:00')])
  assert.deepEqual(r.negative, ['2330'])
  assert.deepEqual(r.lines, [])
})

test('trades are applied in time order regardless of input order', () => {
  const r = applyTrades([], [t('sell', '2330', 500, '2026-11-02 11:00'), t('buy', '2330', 1000, '2026-11-02 10:00')])
  assert.deepEqual(r.lines, [{ symbol: '2330', qty: 500, avgPrice: null }])
})

test('reconciliation lists only the symbols that disagree, in both directions', () => {
  const expected: HoldingLine[] = [
    { symbol: '2330', qty: 1000, avgPrice: null },
    { symbol: '2454', qty: 1000, avgPrice: null },
  ]
  assert.deepEqual(compareLines(expected, expected), [])
  assert.deepEqual(compareLines(expected, [{ symbol: '2330', qty: 1000, avgPrice: null }, { symbol: '2454', qty: 900, avgPrice: null }]), [
    { symbol: '2454', expected: 1000, reported: 900 },
  ])
  assert.deepEqual(compareLines([], [{ symbol: '9999', qty: 1, avgPrice: null }]), [{ symbol: '9999', expected: 0, reported: 1 }])
})
