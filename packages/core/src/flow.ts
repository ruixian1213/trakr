import type { Position, Trade } from './types.ts'

/** 證交稅: 0.3% for stocks, 0.1% for ETFs (symbols starting with "00"). */
export function sellTaxRate(symbol: string): number {
  return symbol.startsWith('00') ? 0.001 : 0.003
}

export function tradeCashEffect(t: Trade): number {
  const gross = t.qty * t.price
  const fee = t.fee ?? 0
  return t.side === 'buy' ? -(gross + fee) : gross - fee - gross * sellTaxRate(t.symbol)
}

/**
 * The broker API exposes no deposit/withdrawal history, so we infer it:
 * flow = change in cash - cash effect of trades in the period.
 * Residuals under `toleranceRatio` of equity (dividends, rounding, fee schedule) count as zero.
 */
export function inferFlow(
  prevCash: number,
  cash: number,
  tradesInPeriod: Trade[],
  equity: number,
  toleranceRatio = 0.005,
): number {
  const tradeEffect = tradesInPeriod.reduce((sum, t) => sum + tradeCashEffect(t), 0)
  const residual = cash - prevCash - tradeEffect
  return Math.abs(residual) <= equity * toleranceRatio ? 0 : residual
}

export function marketValue(positions: Position[]): number {
  return positions.reduce((s, p) => s + p.qty * p.lastPrice, 0)
}

export interface Mismatch {
  symbol: string
  expected: number
  reported: number
}

/** Positions implied by baseline + trades since, compared with what the broker reports. */
export function reconcile(baseline: Position[], tradesSince: Trade[], reported: Position[]): Mismatch[] {
  const expected = new Map<string, number>()
  for (const p of baseline) expected.set(p.symbol, (expected.get(p.symbol) ?? 0) + p.qty)
  for (const t of tradesSince) {
    expected.set(t.symbol, (expected.get(t.symbol) ?? 0) + (t.side === 'buy' ? t.qty : -t.qty))
  }
  const got = new Map<string, number>()
  for (const p of reported) got.set(p.symbol, (got.get(p.symbol) ?? 0) + p.qty)
  const out: Mismatch[] = []
  for (const sym of new Set([...expected.keys(), ...got.keys()])) {
    const e = expected.get(sym) ?? 0
    const g = got.get(sym) ?? 0
    if (e !== g) out.push({ symbol: sym, expected: e, reported: g })
  }
  return out
}
