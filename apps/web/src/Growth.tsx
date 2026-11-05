import { useState } from 'react'
import { api, type TraderDetail } from './api.ts'
import { pct, tone, useLive } from './lib.tsx'
import { Header, LevelMark, attempt, showToast } from './ui.tsx'

/** How to become a verified (blue check) trader. Shown from the profile and settings. */
export function VerifyGuide() {
  return (
    <>
      <Header title="成為藍勾交易員" back="#/me" />
      <div className="pad">
        <p className="muted small" style={{ marginTop: 0 }}>
          藍勾代表你的實盤績效來自券商的成交紀錄，而不是你自己手動輸入。
        </p>
        <ol className="legal-list">
          <li>
            <strong>準備券商帳戶與 API 金鑰。</strong>目前支援永豐金證券（Shioaji）。富邦等其他券商尚未開放。
          </li>
          <li>
            <strong>在自己的電腦上安裝同步程式。</strong>它只讀取成交與庫存，不會下單，券商金鑰也不會離開你的電腦。
          </li>
          <li>
            <strong>到「設定」頁建立同步金鑰。</strong>金鑰只顯示一次，請立刻複製，並依頁面上的指示設定環境變數後執行。
          </li>
          <li>
            <strong>同步成功後，頭像旁會出現藍勾。</strong>累積足夠的已平倉交易後，還會列入實盤績效排行榜。
          </li>
        </ol>
        <p className="muted small">
          同步程式的完整說明在「設定」頁的「Level 2：券商同步」。自行上傳的 CSV 紀錄不會有藍勾，也不列入排行榜。
        </p>
        <p>
          <a href="#/settings">前往設定，建立同步金鑰 →</a>
        </p>
      </div>
    </>
  )
}

/** Two traders side by side. The route is #/compare/<a>/<b>; either handle can be left empty and filled in here. */
export function ComparePage({ a, b }: { a?: string; b?: string }) {
  const [left, setLeft] = useState(a ?? '')
  const [right, setRight] = useState(b ?? '')
  const go = () => {
    const x = left.trim().toLowerCase()
    const y = right.trim().toLowerCase()
    if (x && y) location.hash = `#/compare/${encodeURIComponent(x)}/${encodeURIComponent(y)}`
  }
  return (
    <>
      <Header title="比較交易員" back="#/leaderboard" />
      <div className="pad">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input aria-label="第一位交易員 ID" placeholder="第一位 ID" value={left} onChange={(e) => setLeft(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          <input aria-label="第二位交易員 ID" placeholder="第二位 ID" value={right} onChange={(e) => setRight(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          <button className="primary" onClick={go} disabled={!left.trim() || !right.trim()}>
            比較
          </button>
        </div>
      </div>
      {a && b && <Compared a={a} b={b} />}
    </>
  )
}

function Compared({ a, b }: { a: string; b: string }) {
  const left = useLive(() => api<TraderDetail>(`/traders/${a}`), [a])
  const right = useLive(() => api<TraderDetail>(`/traders/${b}`), [b])
  if (left.error || right.error) {
    return <div className="notice warn">{left.error ?? right.error}</div>
  }
  if (!left.data || !right.data) return <div className="empty">載入中…</div>
  const rows: { label: string; get: (d: TraderDetail) => string; color?: (d: TraderDetail) => string }[] = [
    { label: '總報酬（時間加權）', get: (d) => pct(d.totalReturn), color: (d) => tone(d.totalReturn) },
    { label: '勝率', get: (d) => `${(d.winRate * 100).toFixed(0)}%` },
    { label: '最大回撤', get: (d) => `${(d.maxDrawdown * 100).toFixed(1)}%` },
    { label: '平倉筆數', get: (d) => String(d.closedTrades) },
    { label: '追蹤者', get: (d) => String(d.followers) },
  ]
  return (
    <div className="cmp-table" role="table" aria-label="交易員比較">
      <div className="cmp-row cmp-head" role="row">
        <span role="columnheader">指標</span>
        <span role="columnheader">{left.data.handle}</span>
        <span role="columnheader">{right.data.handle}</span>
      </div>
      <div className="cmp-row" role="row">
        <span role="cell">驗證</span>
        <span role="cell">
          <LevelMark level={left.data.level} />
        </span>
        <span role="cell">
          <LevelMark level={right.data.level} />
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="cmp-row" role="row">
          <span role="cell">{r.label}</span>
          <span role="cell" className={`num ${r.color ? r.color(left.data!) : ''}`}>{r.get(left.data!)}</span>
          <span role="cell" className={`num ${r.color ? r.color(right.data!) : ''}`}>{r.get(right.data!)}</span>
        </div>
      ))}
      <div className="pad small muted">只列出公開的績效數字。報酬率為時間加權，不代表未來表現，也不構成投資建議。</div>
    </div>
  )
}

/** Copies a link to a trader's profile. The link opens a page with preview tags when shared. */
export async function copyTraderLink(handle: string) {
  const url = `${location.origin}/t/${handle}`
  await attempt(
    async () => {
      await navigator.clipboard.writeText(url)
      showToast('已複製交易員連結')
    },
    '無法複製，請手動複製網址列的連結',
  )
}
