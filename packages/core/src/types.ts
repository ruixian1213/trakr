/** Quantities are always in shares (1 張 = 1000 shares); the agent normalizes before upload. */
export interface Trade {
  brokerTradeId: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  /** ISO-8601 UTC, e.g. 2026-11-03T02:15:00.000Z */
  executedAt: string
  fee?: number
}

export interface Position {
  symbol: string
  qty: number
  avgPrice: number
  lastPrice: number
}

/** What the agent uploads. Equity and flow are derived server-side, never trusted from the client. */
export interface RawSnapshot {
  takenAt: string
  /** Cash including unsettled receivables/payables (T+1, T+2). */
  cash: number
  positions: Position[]
}

export interface Snapshot extends RawSnapshot {
  equity: number
  /** External deposit(+)/withdrawal(-) inferred for the period ending at takenAt. */
  flow: number
}
