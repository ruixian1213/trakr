import type { Trade } from './types.ts'
import { HEADERS, readRows } from './csv.ts'

// A holdings snapshot: what the account held at the close of a day. Users upload one of these to give
// the platform a starting point; later trades then move the position forward.

export interface HoldingLine {
  symbol: string
  /** shares */
  qty: number
  /** cost per share; null when unknown, for example after trades have changed the position */
  avgPrice: number | null
}

export interface HoldingsCsvError {
  line: number
  message: string
}

export interface LineMismatch {
  symbol: string
  expected: number
  reported: number
}

const AVG_PRICE = ['avgprice', 'avg_price', 'cost', '均價', '平均成本', '成本', '成本價', '平均價格'] as const
const LOT = 1000

const num = (raw: string) => Number(raw.replace(/[,\s]/g, ''))

/**
 * Parses a holdings snapshot. An empty file, or a header with no rows, is a valid snapshot: it means the
 * account held nothing that day, which is worth recording.
 */
export function parseHoldingsCsv(text: string): { lines: HoldingLine[]; errors: HoldingsCsvError[] } {
  const errors: HoldingsCsvError[] = []
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? ''
  const rows = readRows(text, firstLine.includes('\t') ? '\t' : ',')
  if (rows.length === 0) return { lines: [], errors }

  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  const col = (names: readonly string[]) => header.findIndex((h) => names.includes(h))
  const idx = { symbol: col(HEADERS.symbol), qty: col(HEADERS.qty), lots: col(HEADERS.lots), price: col(AVG_PRICE) }
  if (idx.symbol < 0 || (idx.qty < 0 && idx.lots < 0)) {
    return { lines: [], errors: [{ line: 1, message: '找不到欄位：股票代號、股數（或張數）。第一列需為欄位名稱' }] }
  }
  if (rows.length === 1) return { lines: [], errors }

  const seen = new Set<string>()
  const lines: HoldingLine[] = []
  rows.slice(1).forEach((r, i) => {
    const line = i + 2
    const cell = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '')
    const symbol = cell(idx.symbol).replace(/^'/, '')
    const qty = idx.qty >= 0 ? num(cell(idx.qty)) : num(cell(idx.lots)) * LOT
    const avg = idx.price >= 0 && cell(idx.price) !== '' ? num(cell(idx.price)) : null

    if (!/^[0-9A-Za-z]{2,8}$/.test(symbol)) return errors.push({ line, message: '股票代號不正確' })
    if (!Number.isInteger(qty) || qty <= 0) return errors.push({ line, message: '股數需為正整數（空頭部位請另行說明，目前不支援）' })
    if (avg !== null && (!Number.isFinite(avg) || avg < 0)) return errors.push({ line, message: '均價不正確' })
    if (seen.has(symbol)) return errors.push({ line, message: `${symbol} 重複列出` })
    seen.add(symbol)
    lines.push({ symbol, qty, avgPrice: avg })
  })
  return { lines, errors }
}

/**
 * Moves a snapshot forward by the trades that happened after it. A symbol whose average cost is no
 * longer known after trading is returned with avgPrice null. A position that goes below zero means the
 * trades and the snapshot disagree; it is reported rather than hidden.
 */
export function applyTrades(lines: HoldingLine[], trades: Trade[]): { lines: HoldingLine[]; negative: string[] } {
  const qty = new Map<string, number>()
  const avg = new Map<string, number | null>()
  for (const l of lines) {
    qty.set(l.symbol, l.qty)
    avg.set(l.symbol, l.avgPrice)
  }
  const touched = new Set<string>()
  for (const t of [...trades].sort((a, b) => a.executedAt.localeCompare(b.executedAt))) {
    qty.set(t.symbol, (qty.get(t.symbol) ?? 0) + (t.side === 'buy' ? t.qty : -t.qty))
    touched.add(t.symbol)
    if (!avg.has(t.symbol)) avg.set(t.symbol, null)
  }
  const negative: string[] = []
  const out: HoldingLine[] = []
  for (const [symbol, q] of qty) {
    if (q < 0) negative.push(symbol)
    else if (q > 0) out.push({ symbol, qty: q, avgPrice: touched.has(symbol) ? null : (avg.get(symbol) ?? null) })
  }
  return { lines: out, negative }
}

/** Compares what the trades say the account holds with what a new snapshot reports. */
export function compareLines(expected: HoldingLine[], reported: HoldingLine[]): LineMismatch[] {
  const e = new Map(expected.map((l) => [l.symbol, l.qty]))
  const r = new Map(reported.map((l) => [l.symbol, l.qty]))
  const out: LineMismatch[] = []
  for (const symbol of new Set([...e.keys(), ...r.keys()])) {
    const ex = e.get(symbol) ?? 0
    const rp = r.get(symbol) ?? 0
    if (ex !== rp) out.push({ symbol, expected: ex, reported: rp })
  }
  return out
}
