import { useCallback, useEffect, useState } from 'react'

export const pct = (n: number, digits = 2) => `${n > 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`
export const money = (n: number) => Math.round(n).toLocaleString('en-US')
export const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : '')

/** Prices as TWSE prints them: two decimals, thousands separators. null (no trade today) shows a dash. */
export const price = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

export const signed = (n: number | null, digits = 2) =>
  n === null ? '—' : `${n > 0 ? '+' : ''}${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

/** 1 張 = 1000 shares. Large numbers use 萬 and 億, the way Taiwanese readers expect. */
export function compactTW(n: number | null): string {
  if (n === null) return '—'
  const abs = Math.abs(n)
  const fmt = (v: number, digits: number) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  if (abs >= 1e8) return `${fmt(n / 1e8, 2)}億`
  // Keep one decimal until the figure reaches 1,000 萬, so 1,016,798 shares reads 101.7萬 rather than 102萬.
  if (abs >= 1e4) return `${fmt(n / 1e4, abs >= 1e7 ? 0 : 1)}萬`
  return Math.round(n).toLocaleString('en-US')
}

export const lots = (shares: number | null) => (shares === null ? '—' : `${compactTW(shares / 1000)}張`)

export function fmtTime(iso: string) {
  // Always ISO-8601 from the server; Safari rejects looser formats like "2026-11-03 09:00".
  const d = new Date(iso)
  return d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export const REASONS: Record<string, string> = {
  no_account: '尚未綁定券商帳戶',
  too_few_closed_trades: '已平倉筆數不足',
  too_few_snapshots: '資料點不足',
  recent_unverified_gap: '近期有未驗證區間',
  holdings_mismatch: '庫存與成交紀錄不一致',
  stock_dividend_unverified: '持有的股票有配股，待確認後才列入排行榜',
}

/** Re-fetch on an interval and whenever the tab becomes visible again (iOS suspends timers in the background). */
export function useLive<T>(load: () => Promise<T>, deps: unknown[], everyMs = 15_000) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const run = useCallback(() => {
    load().then(
      (d) => {
        setData(d)
        setLoaded(true)
        setError(null)
      },
      (e: Error) => setError(e.message),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    run()
    const id = setInterval(run, everyMs)
    const onVis = () => document.visibilityState === 'visible' && run()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [run, everyMs])
  return { data, error, loaded, reload: run }
}

export function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/')
  useEffect(() => {
    const on = () => setHash(location.hash || '#/')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash.replace(/^#/, '').split('/').filter(Boolean)
}

export function Spark({ points }: { points: { index: number }[] }) {
  if (points.length < 2) return <div className="muted">資料累積中…</div>
  const ys = points.map((p) => p.index)
  const lo = Math.min(...ys)
  const hi = Math.max(...ys)
  const span = hi - lo || 1
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * 300).toFixed(1)},${(76 - ((p.index - lo) / span) * 72).toFixed(1)}`)
    .join(' ')
  const up = ys[ys.length - 1]! >= 1
  return (
    <svg className="spark" viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label="報酬曲線">
      <path d={d} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
