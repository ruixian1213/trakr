// End-of-day market data from the TWSE OpenAPI (https://openapi.twse.com.tw), released under the
// Government Open Data License. Commercial use is allowed, but the licence is void unless every
// use carries the attribution notice (see SOURCE). The API is the sanctioned automated channel;
// the website's terms forbid scraping, so nothing else is fetched.

export const SOURCE = {
  agency: '臺灣證券交易所',
  datasets: '上市個股日成交資訊、集中市場每日成交量前二十名證券、每日收盤行情-大盤統計資訊、集中市場每日市場成交資訊、個股融資融券餘額、除權息預告表',
  version: '1.0',
  licenseName: '政府資料開放授權條款－第1版',
  licenseUrl: 'https://data.gov.tw/license',
  note: '盤後資料，非即時行情',
} as const

/** Over-the-counter (櫃買中心) daily quotes, same licence. Used to fill in stocks TWSE does not list. */
export const TPEX_SOURCE = {
  agency: '證券櫃檯買賣中心',
  datasets: '上櫃股票行情',
  version: '1.0',
  licenseName: '政府資料開放授權條款－第1版',
  licenseUrl: 'https://data.gov.tw/license',
  note: '盤後資料，非即時行情',
} as const

export type Fetcher = (path: string) => Promise<unknown>

const BASE = 'https://openapi.twse.com.tw/v1'
const TPEX_OTC_QUOTES = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'

export function twseFetcher(): Fetcher {
  return async (path) => {
    // Absolute URLs are other official OpenAPI hosts (TPEx); plain paths belong to TWSE.
    const res = await fetch(path.startsWith('https://') ? path : BASE + path, {
      headers: { accept: 'application/json', 'user-agent': 'tot/0.1 (market data cache)' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`TWSE ${path}: HTTP ${res.status}`)
    return res.json()
  }
}

export interface Quote {
  code: string
  name: string
  close: number | null
  change: number | null
  changePct: number | null
  open: number | null
  high: number | null
  low: number | null
  /** shares */
  volume: number | null
  /** NT$ */
  value: number | null
  transactions: number | null
}

export interface IndexQuote {
  name: string
  close: number | null
  change: number | null
  changePct: number | null
}

export interface TopVolumeRow extends Quote {
  rank: number
}

export interface Overview {
  taiex: IndexQuote
  market: { volume: number | null; value: number | null; transactions: number | null }
  indices: IndexQuote[]
}

export class MarketUnavailable extends Error {}

/** "1151102" (ROC) -> "2026-11-02". */
export function rocToIso(roc: unknown): string | null {
  const m = String(roc ?? '').match(/^(\d{2,3})(\d{2})(\d{2})$/)
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null
}

/** "1,005.50" -> 1005.5. Blank, "--" and other junk become null (suspended stocks report empty prices). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(String(v).replace(/,/g, '').trim())
  return String(v).trim() === '' || !Number.isFinite(n) ? null : n
}

function pct(close: number | null, change: number | null): number | null {
  if (close === null || change === null) return null
  const prev = close - change
  return prev > 0 ? Math.round((change / prev) * 10_000) / 100 : null
}

const signed = (dir: unknown, magnitude: number | null): number | null =>
  magnitude === null ? null : dir === '+' ? magnitude : dir === '-' ? -magnitude : 0

// Indices shown on the home screen, in order. Names are exactly as TWSE publishes them.
const FEATURED_INDICES = ['臺灣50指數', '電子工業類指數', '半導體類指數', '金融保險類指數', '航運類指數']

interface Entry<T> {
  value: T
  at: number
}

export interface ExRow {
  code: string
  /** ISO date of the ex-date, or null when TWSE leaves it blank. */
  date: string | null
  kind: string
  /** NT$ per share, null when no cash dividend is announced. */
  cashDividend: number | null
  stockDividendRatio: number | null
}

function parseExRows(raw: unknown): ExRow[] {
  if (!Array.isArray(raw)) throw new Error('unexpected response shape')
  return raw.map((r: Record<string, unknown>) => ({
    code: String(r.Code ?? ''),
    date: rocToIso(r.Date),
    kind: String(r.Exdividend ?? ''),
    cashDividend: num(r.CashDividend),
    stockDividendRatio: num(r.StockDividendRatio),
  }))
}

export interface MarketOptions {
  now?: () => number
  ttlMs?: number
}

export function createMarket(fetcher: Fetcher, opts: MarketOptions = {}) {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? 10 * 60_000
  const cache = new Map<string, Entry<unknown>>()
  const inflight = new Map<string, Promise<unknown>>()

  /**
   * One upstream request per dataset per TTL no matter how many users ask. If TWSE is down we keep
   * serving the last good copy and say so.
   */
  async function load<T>(path: string, parse: (raw: any) => T): Promise<{ value: T; stale: boolean }> {
    const hit = cache.get(path) as Entry<T> | undefined
    if (hit && now() - hit.at < ttl) return { value: hit.value, stale: false }
    let p = inflight.get(path) as Promise<T> | undefined
    if (!p) {
      p = fetcher(path)
        .then((raw) => {
          const value = parse(raw)
          cache.set(path, { value, at: now() })
          return value
        })
        .finally(() => inflight.delete(path))
      inflight.set(path, p)
    }
    try {
      return { value: await p, stale: false }
    } catch (e) {
      if (hit) return { value: hit.value, stale: true }
      throw new MarketUnavailable((e as Error).message)
    }
  }

  const rows = (raw: any): any[] => {
    if (!Array.isArray(raw)) throw new Error('unexpected response shape')
    return raw
  }

  const loadStocks = () =>
    load('/exchangeReport/STOCK_DAY_ALL', (raw) => {
      const list = rows(raw)
      const map = new Map<string, Quote>()
      let date: string | null = null
      for (const r of list) {
        date ??= rocToIso(r.Date)
        const close = num(r.ClosingPrice)
        const change = num(r.Change)
        map.set(String(r.Code), {
          code: String(r.Code),
          name: String(r.Name ?? ''),
          close,
          change: close === null ? null : change,
          changePct: pct(close, close === null ? null : change),
          open: num(r.OpeningPrice),
          high: num(r.HighestPrice),
          low: num(r.LowestPrice),
          volume: num(r.TradeVolume),
          value: num(r.TradeValue),
          transactions: num(r.Transaction),
        })
      }
      return { date, map }
    })

  /**
   * OTC (上櫃) stocks. Failure here must not hide listed stocks, so it resolves to an empty map instead.
   * TPEx reports shares and value in the same units as TWSE, and its change already carries a sign.
   */
  let otcPausedUntil = 0
  const loadOtc = async (): Promise<Map<string, Quote>> => {
    // After a failure, leave TPEx alone for one TTL instead of retrying on every page view.
    if (now() < otcPausedUntil) return new Map()
    try {
      const { value } = await load(TPEX_OTC_QUOTES, (raw) => {
        const map = new Map<string, Quote>()
        for (const r of rows(raw)) {
          const close = num(r.Close)
          const change = num(r.Change)
          map.set(String(r.SecuritiesCompanyCode), {
            code: String(r.SecuritiesCompanyCode),
            name: String(r.CompanyName ?? ''),
            close,
            change: close === null ? null : change,
            changePct: pct(close, close === null ? null : change),
            open: num(r.Open),
            high: num(r.High),
            low: num(r.Low),
            volume: num(r.TradingShares),
            value: num(r.TransactionAmount),
            transactions: num(r.TransactionNumber),
          })
        }
        return map
      })
      return value
    } catch {
      otcPausedUntil = now() + ttl
      return new Map()
    }
  }

  /** Listed and OTC stocks together. TWSE wins if a code ever appears in both. */
  const allStocks = async () => {
    const [listed, otc] = await Promise.all([loadStocks(), loadOtc()])
    const map = new Map(otc)
    for (const [code, q] of listed.value.map) map.set(code, q)
    return { asOf: listed.value.date, stale: listed.stale, map }
  }

  return {
    async stocks() {
      return allStocks()
    },

    async quote(code: string) {
      const { asOf, stale, map } = await this.stocks()
      return { asOf, stale, quote: map.get(code) ?? null }
    },

    async quotes(codes: string[]) {
      const { asOf, stale, map } = await this.stocks()
      return { asOf, stale, quotes: codes.map((c) => map.get(c) ?? null) }
    },

    async search(q: string, limit = 10) {
      const needle = q.trim().toLowerCase()
      if (!needle) return []
      const { map } = await this.stocks()
      const exact: Quote[] = []
      const prefix: Quote[] = []
      const contains: Quote[] = []
      for (const s of map.values()) {
        const code = s.code.toLowerCase()
        if (code === needle) exact.push(s)
        else if (code.startsWith(needle)) prefix.push(s)
        else if (s.name.toLowerCase().includes(needle)) contains.push(s)
      }
      return [...exact, ...prefix, ...contains].slice(0, limit)
    },

    async topVolume() {
      const { value, stale } = await load('/exchangeReport/MI_INDEX20', (raw) => {
        const list = rows(raw)
        return {
          asOf: rocToIso(list[0]?.Date),
          rows: list.map((r): TopVolumeRow => {
            const close = num(r.ClosingPrice)
            const change = signed(r.Dir, num(r.Change))
            return {
              rank: Number(r.Rank),
              code: String(r.Code),
              name: String(r.Name ?? ''),
              close,
              change,
              changePct: pct(close, change),
              open: num(r.OpeningPrice),
              high: num(r.HighestPrice),
              low: num(r.LowestPrice),
              volume: num(r.TradeVolume),
              value: null,
              transactions: num(r.Transaction),
            }
          }),
        }
      })
      return { asOf: value.asOf, stale, rows: value.rows }
    },

    /**
     * Top 20 by trade value (成交金額). TWSE publishes an official ranking only for volume, so this is
     * the same all-stock dataset sorted by value. (Sorting that dataset by volume reproduces TWSE's
     * official top-20 exactly, which is why the same approach is safe for value.)
     */
    async topValue(limit = 20) {
      const { asOf, stale, map } = await this.stocks()
      const rows = [...map.values()]
        .filter((s) => s.value !== null && s.value > 0)
        .sort((a, b) => b.value! - a.value!)
        .slice(0, limit)
        .map((s, i): TopVolumeRow => ({ ...s, rank: i + 1 }))
      return { asOf, stale, rows }
    },

    /**
     * Stock names for a list of codes. Names are a convenience, so this never throws: if TWSE data is
     * unavailable the map is simply empty and callers fall back to showing the code.
     */
    async names(codes: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      try {
        const { map } = await this.stocks()
        for (const c of codes) {
          const s = map.get(c)
          if (s) out.set(c, s.name)
        }
      } catch {
        /* fall back to codes */
      }
      return out
    },

    /** Margin balances (融資融券餘額) for one stock. Balances are in shares; null where TWSE leaves them blank. */
    async margin(code: string) {
      const { value, stale } = await load('/exchangeReport/MI_MARGN', (raw) => {
        const m = new Map<string, { marginPrev: number | null; margin: number | null; shortPrev: number | null; short: number | null }>()
        for (const r of rows(raw)) {
          m.set(String(r['股票代號'] ?? ''), {
            marginPrev: num(r['融資前日餘額']),
            margin: num(r['融資今日餘額']),
            shortPrev: num(r['融券前日餘額']),
            short: num(r['融券今日餘額']),
          })
        }
        return m
      })
      return { stale, row: value.get(code) ?? null }
    },

    /**
     * Ex-dividend and ex-right announcements (除權息預告). Returns the rows for one stock, nearest first.
     * Dates are ROC in the source and converted to ISO here.
     */
    async exDividend(code: string) {
      const { value, stale } = await load('/exchangeReport/TWT48U_ALL', parseExRows)
      return { stale, rows: value.filter((r) => r.code === code) }
    },

    /** The whole announcement list, used to archive cash dividends for the return calculation. */
    async dividendEvents() {
      const { value, stale } = await load('/exchangeReport/TWT48U_ALL', parseExRows)
      return { stale, rows: value }
    },

    async overview() {
      const [idx, summary] = await Promise.all([
        load('/exchangeReport/MI_INDEX', (raw) => {
          const list = rows(raw)
          const byName = new Map<string, IndexQuote>()
          for (const r of list) {
            const name = String(r['指數'] ?? '')
            byName.set(name, {
              name,
              close: num(r['收盤指數']),
              change: signed(r['漲跌'], num(r['漲跌點數'])),
              changePct: num(r['漲跌百分比']),
            })
          }
          return { asOf: rocToIso(list[0]?.['日期']), byName }
        }),
        load('/exchangeReport/FMTQIK', (raw) => {
          const last = rows(raw).at(-1)
          if (!last) throw new Error('empty FMTQIK')
          return {
            volume: num(last.TradeVolume),
            value: num(last.TradeValue),
            transactions: num(last.Transaction),
            taiex: num(last.TAIEX),
            change: num(last.Change),
          }
        }),
      ])
      // The index list carries the percentage change; the summary carries volume and value.
      const fromList = idx.value.byName.get('發行量加權股價指數')
      const taiex: IndexQuote = fromList ?? {
        name: '發行量加權股價指數',
        close: summary.value.taiex,
        change: summary.value.change,
        changePct: pct(summary.value.taiex, summary.value.change),
      }
      const overview: Overview = {
        taiex,
        market: { volume: summary.value.volume, value: summary.value.value, transactions: summary.value.transactions },
        indices: FEATURED_INDICES.map((n) => idx.value.byName.get(n)).filter((x): x is IndexQuote => !!x),
      }
      return { asOf: idx.value.asOf, stale: idx.stale || summary.stale, overview }
    },
  }
}

export type Market = ReturnType<typeof createMarket>
