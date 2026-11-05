import type { Snapshot, Trade } from './types.ts'

export interface TwrResult {
  totalReturn: number
  maxDrawdown: number
  series: { t: string; index: number }[]
}

/**
 * Time-weighted return. A snapshot's flow is treated as occurring at the end of its period,
 * so period return = (equity - flow) / previousEquity - 1. Deposits cannot inflate the result.
 */
export function twr(snapshots: Snapshot[]): TwrResult {
  const snaps = [...snapshots].sort((a, b) => a.takenAt.localeCompare(b.takenAt))
  let index = 1
  let peak = 1
  let maxDrawdown = 0
  const series: TwrResult['series'] = []
  snaps.forEach((s, i) => {
    if (i > 0) {
      const prev = snaps[i - 1]!.equity
      if (prev > 0) index *= (s.equity - s.flow) / prev
    }
    peak = Math.max(peak, index)
    maxDrawdown = Math.max(maxDrawdown, 1 - index / peak)
    series.push({ t: s.takenAt, index })
  })
  return { totalReturn: index - 1, maxDrawdown, series }
}

export interface TradeStats {
  closedTrades: number
  wins: number
  winRate: number
  realizedPnl: number
}

interface Lot {
  qty: number
  costPerShare: number
}

/**
 * FIFO matching of sells against earlier buys, per symbol. Each sell is one "closed trade".
 * Short-first (day-trade) sells have no lot to match; the unmatched part is ignored.
 */
export function tradeStats(trades: Trade[]): TradeStats {
  const sorted = [...trades].sort((a, b) => a.executedAt.localeCompare(b.executedAt))
  const lots = new Map<string, Lot[]>()
  let closed = 0
  let wins = 0
  let realized = 0
  for (const t of sorted) {
    const q = lots.get(t.symbol) ?? []
    lots.set(t.symbol, q)
    const fee = t.fee ?? 0
    if (t.side === 'buy') {
      q.push({ qty: t.qty, costPerShare: t.price + fee / t.qty })
      continue
    }
    let remaining = t.qty
    let pnl = 0
    let matched = 0
    while (remaining > 0 && q.length > 0) {
      const lot = q[0]!
      const take = Math.min(lot.qty, remaining)
      pnl += (t.price - lot.costPerShare) * take
      matched += take
      lot.qty -= take
      remaining -= take
      if (lot.qty === 0) q.shift()
    }
    if (matched === 0) continue
    pnl -= fee * (matched / t.qty)
    closed++
    if (pnl > 0) wins++
    realized += pnl
  }
  return { closedTrades: closed, wins, winRate: closed ? wins / closed : 0, realizedPnl: realized }
}
