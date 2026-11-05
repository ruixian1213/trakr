import { createHash } from 'node:crypto'
import type { Trade } from './types.ts'

export const CSV_MAX_ROWS = 2000

export interface CsvError {
  line: number
  message: string
}

export interface CsvResult {
  trades: Trade[]
  errors: CsvError[]
}

// Header aliases, lowercased. Covers English plus the labels Taiwan brokers commonly export.
export const HEADERS = {
  time: ['time', 'date', 'datetime', 'executedat', '成交日期', '成交時間', '交易日期', '日期', '時間'],
  symbol: ['symbol', 'code', 'stock', '股票代號', '證券代號', '股票代碼', '代號'],
  side: ['side', 'action', '買賣別', '買賣', '交易別'],
  qty: ['qty', 'quantity', 'shares', '成交股數', '股數', '成交數量', '數量'],
  lots: ['lots', '成交張數', '張數'],
  price: ['price', '成交價', '成交價格', '價格', '單價'],
  fee: ['fee', '手續費'],
} as const

/** Minimal RFC-4180 reader: quoted fields, escaped quotes, CRLF, BOM. */
export function readRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

/**
 * Dates without a zone are Taipei time (UTC+8). Accepts 2026-11-03, 2026/11/03 09:15[:30] and
 * ROC years (115/11/03). A bare date is placed at 13:30, the close.
 */
export function parseTaipeiTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{2,4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!m) return null
  let year = Number(m[1])
  if (year < 1911) year += 1911
  const [month, day] = [Number(m[2]), Number(m[3])]
  const hasTime = m[4] !== undefined
  const [hh, mm, ss] = hasTime ? [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] : [13, 30, 0]
  if (month < 1 || month > 12 || day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) return null
  // Reject calendar rollovers such as 2026-02-31.
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  return new Date(Date.UTC(year, month - 1, day, hh, mm, ss) - 8 * 3600_000).toISOString()
}

function parseSide(raw: string): 'buy' | 'sell' | null {
  const s = raw.trim().toLowerCase()
  if (s === 'buy' || s === 'b' || s.includes('買')) return 'buy'
  if (s === 'sell' || s === 's' || s.includes('賣')) return 'sell'
  return null
}

const num = (raw: string) => Number(raw.replace(/[,\s]/g, ''))

/**
 * Parses a broker statement export into trades. Row ids are content hashes, so importing
 * the same file twice is a no-op, while two identical fills in one file stay distinct.
 */
export function parseTradesCsv(text: string): CsvResult {
  const errors: CsvError[] = []
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? ''
  const delimiter = firstLine.includes('\t') ? '\t' : ','
  const rows = readRows(text, delimiter)
  if (rows.length < 2) return { trades: [], errors: [{ line: 1, message: '沒有資料列（第一列需為欄位名稱）' }] }
  if (rows.length - 1 > CSV_MAX_ROWS) return { trades: [], errors: [{ line: 1, message: `一次最多匯入 ${CSV_MAX_ROWS} 筆` }] }

  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  const col = (names: readonly string[]) => header.findIndex((h) => names.includes(h))
  const idx = {
    time: col(HEADERS.time),
    symbol: col(HEADERS.symbol),
    side: col(HEADERS.side),
    qty: col(HEADERS.qty),
    lots: col(HEADERS.lots),
    price: col(HEADERS.price),
    fee: col(HEADERS.fee),
  }
  const labels = { time: '時間', symbol: '股票代號', side: '買賣', price: '價格' } as const
  const missing: string[] = (Object.keys(labels) as (keyof typeof labels)[]).filter((k) => idx[k] < 0).map((k) => labels[k])
  if (idx.qty < 0 && idx.lots < 0) missing.push('股數')
  if (missing.length) {
    return { trades: [], errors: [{ line: 1, message: `找不到欄位：${missing.join('、')}（第一列需為欄位名稱）` }] }
  }

  const seen = new Map<string, number>()
  const trades: Trade[] = []
  rows.slice(1).forEach((r, i) => {
    const line = i + 2
    const cell = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '')
    const executedAt = parseTaipeiTime(cell(idx.time))
    const symbol = cell(idx.symbol).replace(/^'/, '')
    const side = parseSide(cell(idx.side))
    const qty = idx.qty >= 0 ? num(cell(idx.qty)) : num(cell(idx.lots)) * 1000
    const price = num(cell(idx.price))
    const fee = idx.fee >= 0 && cell(idx.fee) !== '' ? num(cell(idx.fee)) : 0

    if (!executedAt) return errors.push({ line, message: '時間格式無法辨識（例：2026-11-03 09:15）' })
    if (!/^[0-9A-Za-z]{2,8}$/.test(symbol)) return errors.push({ line, message: '股票代號不正確' })
    if (!side) return errors.push({ line, message: '買賣別需為 買/賣 或 buy/sell' })
    if (!Number.isInteger(qty) || qty <= 0) return errors.push({ line, message: '股數需為正整數' })
    if (!Number.isFinite(price) || price <= 0) return errors.push({ line, message: '價格需大於 0' })
    if (!Number.isFinite(fee) || fee < 0) return errors.push({ line, message: '手續費不正確' })

    const key = [executedAt, symbol, side, qty, price].join('|')
    const nth = seen.get(key) ?? 0
    seen.set(key, nth + 1)
    const id = 'csv:' + createHash('sha256').update(`${key}|${nth}`).digest('hex').slice(0, 32)
    trades.push({ brokerTradeId: id, symbol, side, qty, price, executedAt, fee })
  })
  return { trades, errors }
}
