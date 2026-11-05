// 集保戶股權分散表: how many holders sit in each shareholding size bracket, published weekly by TDCC
// (臺灣集中保管結算所) under the Government Open Data License. This is the public "大戶" signal: it shows
// whether the 400-lot and 1000-lot holders are growing or shrinking. It does not identify anyone.
//
// The feed only has the latest week, so trends appear once we have archived two weeks. We archive every
// week we see, so the history starts the day this runs.

export const TDCC_SOURCE = {
  agency: '臺灣集中保管結算所',
  datasets: '集保戶股權分散表',
  version: '1.0',
  licenseName: '政府資料開放授權條款－第1版',
  licenseUrl: 'https://data.gov.tw/license',
  note: '每週更新，非即時資料',
} as const

export const TDCC_URL = 'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5'

/** TDCC's brackets: level 12 starts at 400,001 shares (400 lots) and level 15 at 1,000,001 (1,000 lots). */
const LEVEL_400_LOTS = 12
const LEVEL_1000_LOTS = 15
const LEVEL_TOTAL = 17
const MAX_LEVEL = 17

export interface HolderRow {
  /** ISO date of the weekly snapshot. */
  asOf: string
  code: string
  level: number
  people: number
  shares: number
  /** Percent of the TDCC custody total (占集保庫存數比例). */
  pct: number
}

/** "20261030" -> "2026-10-30". */
export function tdccDate(s: string): string | null {
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * Parses the CSV. Rows that do not look right are skipped and counted, never guessed at. The first line
 * is a header; a byte-order mark may precede it.
 */
export function parseTdcc(text: string): { rows: HolderRow[]; skipped: number } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const out: HolderRow[] = []
  let skipped = 0
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue
    const f = line.split(',')
    // The feed pads codes with trailing spaces ("0050  "), so trim before checking.
    const code = (f[1] ?? '').trim()
    const asOf = tdccDate(f[0] ?? '')
    const level = Number(f[2])
    const people = Number(f[3])
    const shares = Number(f[4])
    const pct = Number(f[5])
    const ok =
      asOf !== null &&
      /^[0-9A-Za-z]{2,8}$/.test(code) &&
      Number.isInteger(level) &&
      level >= 1 &&
      level <= MAX_LEVEL &&
      [people, shares, pct].every((n) => Number.isFinite(n) && n >= 0)
    if (!ok) {
      skipped++
      continue
    }
    out.push({ asOf: asOf!, code, level, people, shares, pct })
  }
  return { rows: out, skipped }
}

export interface BigHolderSummary {
  asOf: string
  /** All holders in the week. */
  totalPeople: number
  /** Percent of shares held by 400-lot-and-above holders. */
  pct400: number
  /** Number of holders with 1000 lots or more. */
  people1000: number
  /** Percent of shares held by 1000-lot-and-above holders. */
  pct1000: number
}

/** The 400-lot and 1000-lot picture for one stock in one week. */
export function summarize(rows: HolderRow[]): BigHolderSummary | null {
  if (rows.length === 0) return null
  const asOf = rows[0]!.asOf
  const at = (level: number) => rows.find((r) => r.level === level)
  const total = at(LEVEL_TOTAL)
  const sumFrom = (from: number) => rows.filter((r) => r.level >= from && r.level <= LEVEL_1000_LOTS).reduce((a, r) => a + r.pct, 0)
  const round2 = (n: number) => Math.round(n * 100) / 100
  return {
    asOf,
    totalPeople: total?.people ?? rows.filter((r) => r.level < LEVEL_TOTAL).reduce((a, r) => a + r.people, 0),
    pct400: round2(sumFrom(LEVEL_400_LOTS)),
    people1000: at(LEVEL_1000_LOTS)?.people ?? 0,
    pct1000: round2(at(LEVEL_1000_LOTS)?.pct ?? 0),
  }
}

/** Fetches and archives the feed. A week we already hold is not written twice. */
export async function archiveHolders(
  db: { prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; exec(sql: string): void },
  fetchText: () => Promise<string>,
): Promise<{ weeks: number; rows: number; skipped: number }> {
  const { rows, skipped } = parseTdcc(await fetchText())
  const insert = db.prepare('INSERT OR IGNORE INTO holder_weeks (code, as_of, level, people, shares, pct) VALUES (?, ?, ?, ?, ?, ?)')
  db.exec('BEGIN')
  try {
    for (const r of rows) insert.run(r.code, r.asOf, r.level, r.people, Math.round(r.shares), r.pct)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  const weeks = new Set(rows.map((r) => r.asOf)).size
  return { weeks, rows: rows.length, skipped }
}

/** Latest week and the one before it for a stock, so the UI can show direction. */
export function holderHistory(
  db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } },
  code: string,
): { current: BigHolderSummary | null; previous: BigHolderSummary | null } {
  const weeks = (db.prepare('SELECT DISTINCT as_of FROM holder_weeks WHERE code = ? ORDER BY as_of DESC LIMIT 2').all(code) as { as_of: string }[]).map((w) => w.as_of)
  const load = (asOf: string) =>
    summarize(
      (db.prepare('SELECT as_of, code, level, people, shares, pct FROM holder_weeks WHERE code = ? AND as_of = ? ORDER BY level').all(code, asOf) as {
        as_of: string
        code: string
        level: number
        people: number
        shares: number
        pct: number
      }[]).map((r) => ({ asOf: r.as_of, code: r.code, level: r.level, people: r.people, shares: r.shares, pct: r.pct })),
    )
  return {
    current: weeks[0] ? load(weeks[0]) : null,
    previous: weeks[1] ? load(weeks[1]) : null,
  }
}
