import { createHash } from 'node:crypto'
import type { Trade } from './types.ts'

export const GENESIS_HASH = '0'.repeat(64)

export function tradeHash(prevHash: string, t: Trade): string {
  const material = [prevHash, t.brokerTradeId, t.symbol, t.side, t.qty, t.price, t.executedAt, t.fee ?? 0].join('|')
  return createHash('sha256').update(material).digest('hex')
}

export interface ChainRow {
  trade: Trade
  prevHash: string
  hash: string
}

/** Rows must be in ingestion order. Returns the index of the first row that does not verify. */
export function verifyChain(rows: ChainRow[]): { ok: boolean; brokenAt?: number } {
  let prev = GENESIS_HASH
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    if (r.prevHash !== prev || tradeHash(prev, r.trade) !== r.hash) return { ok: false, brokenAt: i }
    prev = r.hash
  }
  return { ok: true }
}
