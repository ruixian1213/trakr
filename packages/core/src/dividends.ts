import { tradeCashEffect } from './flow.ts'
import type { Position, Trade } from './types.ts'

/**
 * A cash dividend announced for a stock. exMs is the ex-dividend moment (the start of the trading day,
 * Taipei 09:00). cashPerShare is NT$ per share.
 */
export interface DividendEvent {
  symbol: string
  exMs: number
  cashPerShare: number
}

export interface FlowInput {
  takenMs: number
  cash: number
  equity: number
  positions: Position[]
}

/** Dividend cash can arrive weeks after the ex-date. Money not received within this window is dropped. */
export const DIVIDEND_WINDOW_DAYS = 120
const DAY = 86_400_000

/**
 * External flow for each snapshot, with dividend income taken out.
 *
 * The broker API has no deposit history, so flow is inferred as the cash change that trades do not explain
 * (see inferFlow). A cash dividend also raises cash without any trade, so without this step it would be
 * read as a deposit and then subtracted from the return, understating every dividend-paying holding.
 *
 * For each period, the dividends whose ex-date falls inside it are expected to be paid in cash:
 * shares held at the ex-moment × cash per share. Cash that arrives in the period first pays off those
 * expected dividends (oldest first); only the remainder counts as a flow. Expected dividends that never
 * arrive within the window expire, so they cannot later swallow an unrelated deposit.
 *
 * snaps must be sorted by takenMs. Returns one flow per snapshot, in the same order.
 */
export function adjustedFlows(snaps: FlowInput[], trades: Trade[], events: DividendEvent[], toleranceRatio = 0.005): number[] {
  const flows = snaps.map(() => 0)
  const tradeMs = trades.map((t) => ({ t, ms: Date.parse(t.executedAt) }))
  let pool: { amount: number; exMs: number }[] = []

  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1]!
    const cur = snaps[i]!

    for (const e of events) {
      if (e.exMs <= prev.takenMs || e.exMs > cur.takenMs || e.cashPerShare <= 0) continue
      // Shares held at the ex-moment: the previous snapshot, plus trades made before the ex-moment.
      let held = prev.positions.find((p) => p.symbol === e.symbol)?.qty ?? 0
      for (const { t, ms } of tradeMs) {
        if (t.symbol !== e.symbol || ms <= prev.takenMs || ms >= e.exMs) continue
        held += t.side === 'buy' ? t.qty : -t.qty
      }
      if (held > 0) pool.push({ amount: held * e.cashPerShare, exMs: e.exMs })
    }
    pool = pool.filter((p) => p.exMs >= cur.takenMs - DIVIDEND_WINDOW_DAYS * DAY)

    const between = tradeMs.filter(({ ms }) => ms > prev.takenMs && ms <= cur.takenMs).map(({ t }) => t)
    const residual = cur.cash - prev.cash - between.reduce((sum, t) => sum + tradeCashEffect(t), 0)

    let explained = 0
    if (residual > 0) {
      for (const p of pool) {
        const take = Math.min(p.amount, residual - explained)
        p.amount -= take
        explained += take
        if (explained >= residual) break
      }
      pool = pool.filter((p) => p.amount > 0)
    }
    const rest = residual - explained
    flows[i] = Math.abs(rest) <= cur.equity * toleranceRatio ? 0 : rest
  }
  return flows
}
