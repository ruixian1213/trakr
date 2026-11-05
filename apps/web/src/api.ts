export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: Record<string, any> = {},
  ) {
    super(message)
  }
}

// The session lives in an HttpOnly cookie the browser manages; no credential is ever readable from JS.
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status, data as Record<string, any>)
  return data as T
}

/** Current user, or null when signed out. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('/me')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null
    throw e
  }
}

export interface Post {
  id: number
  handle: string
  avatarV?: number | null
  verified?: boolean
  body: string
  createdAt: string
  commentCount: number
  mine: boolean
}
export interface PostComment {
  id: number
  handle: string
  avatarV?: number | null
  verified?: boolean
  body: string
  createdAt: string
  mine: boolean
}

export interface ProfileLink {
  platform: string
  label: string
  handle: string
  /** Built by the server from a fixed template; safe to use as an href. */
  url: string
}

/** Sends the (already resized) photo as raw bytes; the server checks the real file type itself. */
export async function uploadAvatar(blob: Blob): Promise<{ avatarV: number }> {
  const res = await fetch('/api/me/avatar', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': blob.type || 'image/jpeg' },
    body: blob,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status, data as Record<string, any>)
  return data as { avatarV: number }
}

export interface MarketSource {
  agency: string
  datasets: string
  version: string
  licenseName: string
  licenseUrl: string
  note: string
}
export interface MarketQuote {
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
  value: number | null
  transactions: number | null
}
export interface IndexQuote {
  name: string
  close: number | null
  change: number | null
  changePct: number | null
}
interface MarketMeta {
  source: MarketSource
  asOf: string | null
  stale: boolean
}
export interface MarketOverview extends MarketMeta {
  taiex: IndexQuote
  market: { volume: number | null; value: number | null; transactions: number | null }
  indices: IndexQuote[]
}
export interface TopVolume extends MarketMeta {
  rows: (MarketQuote & { rank: number })[]
}
export interface WatchlistResult extends MarketMeta {
  unavailable: boolean
  items: { code: string; quote: MarketQuote | null }[]
}
export interface StockResult extends MarketMeta {
  quote: MarketQuote
  watching: boolean
}

export interface AgentKey {
  id: number
  createdAt: string
  lastUsedAt: string | null
}

export interface Summary {
  handle: string
  avatarV?: number | null
  bio?: string
  links?: ProfileLink[]
  profileHidden?: boolean
  /** 2 = Broker Verified (API), 1 = User Submitted (CSV), 0 = nothing shared. */
  level: 0 | 1 | 2
  csvTrades: number
  totalReturn: number
  maxDrawdown: number
  winRate: number
  closedTrades: number
  realizedPnl: number
  snapshots: number
  eligible: boolean
  ineligibleReasons: string[]
  syncStatus: 'live' | 'stale' | 'never'
  lastSyncAt: string | null
}
export interface LeaderEntry extends Summary {
  rank: number
}
export interface TraderDetail extends Summary {
  equityCurve: { t: string; index: number }[]
  delaySec: number
  holdingsVisibility: 'public' | 'ratio' | 'hidden'
  followers: number
  following: boolean
  /** True when you have blocked this trader. Blocking hides both sides; see the server's block routes. */
  blocked: boolean
}
export interface TradeItem {
  handle: string
  avatarV?: number | null
  /** Stock name from TWSE data; null when unavailable, in which case show the code. */
  name?: string | null
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  executedAt: string
  /** false for user-uploaded CSV rows. */
  verified: boolean
}
export interface CsvImportResult {
  imported: number
  duplicates: number
  rejected: number
  errors: { line: number; message: string }[]
}
export interface Holdings {
  mode: 'public' | 'ratio' | 'hidden'
  /** 'csv': derived from a user-uploaded snapshot (Level 1). Absent: broker-verified (Level 2). */
  source?: 'csv'
  asOf?: string | null
  note?: 'ratio_unavailable' | 'negative_holdings' | null
  /** Symbols whose trades sold more than the snapshot held. */
  negative?: string[]
  holdings: { symbol: string; name?: string | null; qty?: number; avgPrice?: number | null; lastPrice?: number; weight?: number }[]
}
export interface HoldingsSnapshot {
  id: number
  asOf: string
  positions: number
  mismatches: { symbol: string; expected: number; reported: number }[]
}
export interface Integrity {
  chain: { ok: boolean; brokenAt?: number }
  trades: number
  head: string | null
  broker: string | null
  trackedSince: string | null
  gaps: { from: string; to: string }[]
}
/** One week of the TDCC shareholding distribution, condensed to the big-holder figures. */
export interface HolderWeek {
  asOf: string
  totalPeople: number
  /** Percent of shares held by 400-lot-and-above holders. */
  pct400: number
  people1000: number
  /** Percent of shares held by 1000-lot-and-above holders. */
  pct1000: number
}
export interface StockDetails {
  holders: { source: MarketSource; current: HolderWeek; previous: HolderWeek | null } | null
  margin: {
    source: MarketSource
    stale: boolean
    row: { marginPrev: number | null; margin: number | null; shortPrev: number | null; short: number | null } | null
  } | null
  exDividend: {
    source: MarketSource
    stale: boolean
    rows: { code: string; date: string | null; kind: string; cashDividend: number | null; stockDividendRatio: number | null }[]
  } | null
}
export interface FollowedHolder {
  handle: string
  avatarV?: number | null
  mode: 'public' | 'ratio' | 'hidden'
  /** Shares, when the holding is shown in full. */
  qty: number | null
  /** Percent weight, when the trader shows ratios only. */
  weight: number | null
  asOf: string | null
  level: 0 | 1 | 2
}
export interface NotificationResult {
  unread: number
  trades: TradeItem[]
}

export interface Me {
  emailDigest?: boolean
  handle: string
  avatarV?: number | null
  bio?: string
  links?: ProfileLink[]
  profileHidden?: boolean
  email: string
  delaySec: number
  holdingsVisibility: 'public' | 'ratio' | 'hidden'
  linked: boolean
  lastSyncAt: string | null
}
