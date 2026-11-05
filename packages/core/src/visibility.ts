import type { Position } from './types.ts'

export const MIN_DELAY_SEC = 180
export const DEFAULT_DELAY_SEC = 300
export const MAX_DELAY_SEC = 1800

export type HoldingsVisibility = 'public' | 'ratio' | 'hidden'

/** Traders choose their delay, but never below the anti-sniping floor. */
export function clampDelay(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_DELAY_SEC
  return Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, Math.round(sec)))
}

export function isVisible(executedMs: number, delaySec: number, nowMs: number): boolean {
  return executedMs + delaySec * 1000 <= nowMs
}

export function ratioHoldings(positions: Position[]): { symbol: string; weight: number }[] {
  const total = positions.reduce((s, p) => s + p.qty * p.lastPrice, 0)
  if (total <= 0) return []
  return positions
    .map((p) => ({ symbol: p.symbol, weight: (p.qty * p.lastPrice) / total }))
    .sort((a, b) => b.weight - a.weight)
}

// Taiwan cash market: Mon-Fri 09:00-13:30 (UTC+8) = 01:00-05:30 UTC. Holidays are not modelled.
const OPEN_MS = 1 * 3600_000
const CLOSE_MS = 5.5 * 3600_000
const DAY_MS = 24 * 3600_000

/** True if [fromMs, toMs] overlaps a trading session, i.e. the agent was silent while trades could happen. */
export function overlapsMarketHours(fromMs: number, toMs: number): boolean {
  if (toMs <= fromMs) return false
  const firstDay = Math.floor(fromMs / DAY_MS)
  const lastDay = Math.floor(toMs / DAY_MS)
  for (let d = firstDay; d <= Math.min(lastDay, firstDay + 30); d++) {
    const dow = new Date(d * DAY_MS).getUTCDay()
    if (dow === 0 || dow === 6) continue
    const open = d * DAY_MS + OPEN_MS
    const close = d * DAY_MS + CLOSE_MS
    if (fromMs < close && toMs > open) return true
  }
  return false
}
