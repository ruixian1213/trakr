import { useEffect, useState } from 'react'
import {
  ApiError,
  api,
  fetchMe,
  type AgentKey,
  type CsvImportResult,
  type HoldingsSnapshot,
  type Holdings,
  type Integrity,
  type LeaderEntry,
  type NotificationResult,
  type TradeItem,
  type TraderDetail,
} from './api.ts'
import { Footer, InstallPage, LegalPage, TraderNotice } from './legal.tsx'
import { Global, PostDetail } from './Forum.tsx'
import { HandleField, type HandleStatus } from './HandleField.tsx'
import { MarketTab, StockPage, WatchlistTab } from './Market.tsx'
import { ProfileBio, ProfileEditor, ProfileHeader, ReportProfile } from './Profile.tsx'
import { REASONS, Spark, fmtTime, money, pct, tone, useLive, useRoute } from './lib.tsx'
import { getTextSize, getTheme, setTextSize, setTheme, type TextSize, type Theme } from './typography.ts'
import { Avatar, DialogHost, Header, LevelMark, StockLabel, UnderlineTabs, VerifiedBadge, attempt, confirmAction, showToast } from './ui.tsx'

// ---------- shared rows ----------

function TraderRow({ e, metric }: { e: LeaderEntry; metric: 'return' | 'winrate' }) {
  return (
    <a href={`#/t/${e.handle}`} className="item">
      <div className={`rank ${e.rank <= 3 ? 'top' : ''}`}>{e.rank}</div>
      <Avatar handle={e.handle} v={e.avatarV} />
      <div className="body">
        <div className="head">
          <strong>{e.handle}</strong>
          <VerifiedBadge />
        </div>
        <div className="muted small num">
          勝率 {(e.winRate * 100).toFixed(0)}% · {e.closedTrades} 筆平倉
        </div>
      </div>
      <div className={`value-lg num ${metric === 'return' ? tone(e.totalReturn) : ''}`} style={{ alignSelf: 'center' }}>
        {metric === 'return' ? pct(e.totalReturn) : `${(e.winRate * 100).toFixed(0)}%`}
      </div>
    </a>
  )
}

function TradeRows({ items, hideHandle }: { items: TradeItem[]; hideHandle?: boolean }) {
  if (items.length === 0) return <div className="empty">尚無公開的交易</div>
  return (
    <>
      {items.map((t, i) => (
        <div key={`${t.handle}-${t.executedAt}-${i}`} className="item">
          {!hideHandle && <Avatar handle={t.handle} v={t.avatarV} />}
          <div className="body">
            <div className="head" style={{ gap: 6 }}>
              <span className={`trade-side ${t.side === 'buy' ? 'up' : 'down'}`}>{t.side === 'buy' ? '買進' : '賣出'}</span>
              <StockLabel symbol={t.symbol} name={t.name} />
              {!t.verified && <span className="tag">自行回報</span>}
            </div>
            <div className="muted small">
              {!hideHandle && `${t.handle} · `}
              {fmtTime(t.executedAt)}
            </div>
          </div>
          <div className="num" style={{ textAlign: 'right' }}>
            <div>{t.price}</div>
            <div className="muted small">{t.qty.toLocaleString('en-US')} 股</div>
          </div>
        </div>
      ))}
    </>
  )
}

// ---------- pages ----------

function Leaderboard() {
  const [sort, setSort] = useState<'return' | 'winrate'>('return')
  const { data, error } = useLive(() => api<{ entries: LeaderEntry[] }>(`/leaderboard?sort=${sort}`), [sort], 30_000)
  // Table bars are scaled to the largest absolute return on the page, so the best trader fills the bar.
  const best = Math.max(1e-9, ...(data?.entries ?? []).map((x) => Math.abs(x.totalReturn)))
  return (
    <>
      <Header title="排行榜" />
      <UnderlineTabs
        tabs={[
          { id: 'return', label: '總報酬率' },
          { id: 'winrate', label: '勝率' },
        ]}
        value={sort}
        onChange={setSort}
      />
      <div className="sub" style={{ paddingTop: 10 }}>
        只列入券商驗證（Level 2）的實盤績效，報酬率為時間加權。
      </div>
      {error && <div className="notice warn">{error}</div>}
      {data?.entries.length === 0 && <div className="empty">還沒有符合資格的交易員。需通過券商 API 驗證並累積足夠交易紀錄。</div>}
      {/* Phones: the list. Desktop: a table with a bar per trader, scaled to the best return on the page. */}
      <div className="lb-mobile">{data?.entries.map((e) => <TraderRow key={e.handle} e={e} metric={sort} />)}</div>
      {data && data.entries.length > 0 && (
        <div className="lb-table" role="table" aria-label="交易員排行榜">
          <div className="lb-row lb-head" role="row">
            <span role="columnheader">#</span>
            <span role="columnheader">交易員</span>
            <span role="columnheader">總報酬（時間加權）</span>
            <span role="columnheader">勝率</span>
            <span role="columnheader">平倉</span>
          </div>
          {data.entries.map((e) => {
            const width = (Math.abs(e.totalReturn) / best) * 100
            return (
              <a key={e.handle} href={`#/t/${e.handle}`} className="lb-row" role="row">
                <span className="lb-rank num" role="cell">{String(e.rank).padStart(2, '0')}</span>
                <span className="lb-who" role="cell">
                  <Avatar handle={e.handle} size={32} v={e.avatarV} />
                  <strong>{e.handle}</strong>
                  <VerifiedBadge />
                </span>
                <span className="lb-ret" role="cell">
                  <span className={`num lb-ret-val ${tone(e.totalReturn)}`}>{pct(e.totalReturn)}</span>
                  <span className="lb-track" aria-hidden="true">
                    <span className={`lb-fill ${tone(e.totalReturn)}`} style={{ width: `${width}%` }} />
                  </span>
                </span>
                <span className="num" role="cell">{(e.winRate * 100).toFixed(0)}%</span>
                <span className="num" role="cell">{e.closedTrades}</span>
              </a>
            )
          })}
        </div>
      )}
    </>
  )
}

function Trader({ handle }: { handle: string }) {
  const detail = useLive(() => api<TraderDetail>(`/traders/${handle}`), [handle])
  const trades = useLive(() => api<{ delaySec: number; trades: TradeItem[] }>(`/traders/${handle}/trades`), [handle])
  const holdings = useLive(() => api<Holdings>(`/traders/${handle}/holdings`), [handle])
  const integrity = useLive(() => api<Integrity>(`/traders/${handle}/integrity`), [handle], 60_000)
  const [tab, setTab] = useState<'trades' | 'holdings'>('trades')
  const [err, setErr] = useState<string | null>(null)
  const me = useLive(fetchMe, [], 60_000)

  const d = detail.data
  if (detail.error) {
    return (
      <>
        <Header title="交易員" back="#/leaderboard" />
        <div className="empty">{detail.error === 'not found' ? '找不到這位交易員' : detail.error}</div>
      </>
    )
  }
  if (!d) return <Header title={handle} back="#/leaderboard" />

  const toggleFollow = async () => {
    setErr(null)
    try {
      await api(`/traders/${handle}/follow`, { method: d.following ? 'DELETE' : 'POST' })
      detail.reload()
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? '請先登入才能追蹤（到「我」登入或註冊）' : (e as Error).message)
    }
  }

  const toggleBlock = async () => {
    setErr(null)
    if (!d.blocked) {
      const ok = await confirmAction({
        title: `封鎖 ${d.handle}`,
        message: '封鎖後，你和對方會互相看不到彼此的貼文、留言、交易與持倉，雙方的追蹤也會取消。確定要封鎖嗎？',
        confirmLabel: '封鎖',
        danger: true,
      })
      if (!ok) return
    }
    if (await attempt(() => api(`/traders/${handle}/block`, { method: d.blocked ? 'DELETE' : 'POST' }))) detail.reload()
  }

  const minutes = Math.round(d.delaySec / 60)
  return (
    <>
      <Header title={d.handle} back="#/leaderboard" />
      <TraderNotice />
      <div className="profile">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Avatar handle={d.handle} size={64} v={d.avatarV} />
          <div className="grow">
            <div className="row" style={{ gap: 6 }}>
              <span className="big-name">{d.handle}</span>
              <LevelMark level={d.level} />
            </div>
            <div className="muted small">
              {d.followers} 位追蹤者 · 交易延遲 {minutes} 分鐘 ·{' '}
              <span className={d.syncStatus === 'live' ? 'down' : ''}>{d.syncStatus === 'live' ? '同步中' : d.syncStatus === 'never' ? '未同步' : '離線'}</span>
            </div>
          </div>
          <button className={d.following ? '' : 'primary'} onClick={toggleFollow}>
            {d.following ? '已追蹤' : '追蹤'}
          </button>
          <button onClick={toggleBlock}>{d.blocked ? '解除封鎖' : '封鎖'}</button>
        </div>
        {err && <div className="small up" style={{ marginTop: 8 }}>{err}</div>}
        <ProfileBio bio={d.bio} links={d.links} />
        {d.profileHidden && <div className="muted small" style={{ marginTop: 10 }}>此人的簡介與連結因多人檢舉暫時隱藏。</div>}
        {me.loaded && me.data?.handle !== d.handle && (d.bio || (d.links?.length ?? 0) > 0) && (
          <div style={{ marginTop: 8 }}>
            <ReportProfile handle={d.handle} />
          </div>
        )}
      </div>

      {d.level === 0 && <div className="notice">這位使用者還沒有分享任何交易紀錄。</div>}
      {d.level === 1 && (
        <div className="notice warn">自行回報：這些交易由使用者自行上傳，尚未經券商驗證，不列入實盤驗證排行榜。</div>
      )}
      {d.level === 2 && !d.eligible && <div className="notice warn">未列入排行榜：{d.ineligibleReasons.map((r) => REASONS[r] ?? r).join('、')}</div>}

      {d.level === 2 && (
        <>
          <div className="stats">
            <div>
              <div className="label">總報酬率</div>
              <div className={`value num ${tone(d.totalReturn)}`}>{pct(d.totalReturn)}</div>
            </div>
            <div>
              <div className="label">勝率</div>
              <div className="value num">{(d.winRate * 100).toFixed(0)}%</div>
            </div>
            <div>
              <div className="label">已實現損益</div>
              <div className={`value num ${tone(d.realizedPnl)}`}>{money(d.realizedPnl)}</div>
            </div>
            <div>
              <div className="label">最大回撤</div>
              <div className="value num down">-{(d.maxDrawdown * 100).toFixed(2)}%</div>
            </div>
          </div>
          <div className="pad">
            <Spark points={d.equityCurve} />
            {integrity.data && (
              <div className="muted small" style={{ marginTop: 8 }}>
                報酬率為時間加權 · 資料來源 {integrity.data.broker ?? '—'} API · 紀錄鏈 <span className={integrity.data.chain.ok ? 'down' : 'up'}>{integrity.data.chain.ok ? '完整' : '異常'}</span> · {integrity.data.trades} 筆 · 追蹤起算日{' '}
                {integrity.data.trackedSince ? fmtTime(integrity.data.trackedSince) : '—'}
                {integrity.data.gaps.length > 0 && ` · 近期 ${integrity.data.gaps.length} 段未驗證區間`}
              </div>
            )}
          </div>
        </>
      )}

      {d.level >= 1 ? (
        <UnderlineTabs
          tabs={[
            { id: 'trades', label: '交易' },
            { id: 'holdings', label: '持倉' },
          ]}
          value={tab}
          onChange={setTab}
        />
      ) : (
        <div className="section">交易紀錄</div>
      )}

      {tab === 'trades' ? (
        <TradeRows items={trades.data?.trades ?? []} hideHandle />
      ) : (
        <>
          {holdings.data?.source === 'csv' && (
            <div className="notice warn">由交易員自行上傳的庫存推算，屬 Level 1 自行回報，未經券商驗證。</div>
          )}
          {holdings.data?.note === 'ratio_unavailable' && <div className="empty">持倉以比重顯示需要市值資料，目前無法計算。</div>}
          {holdings.data?.note === 'negative_holdings' && (
            <div className="notice warn">賣出數量超過庫存（{holdings.data.negative?.join('、')}），上傳的庫存或成交紀錄可能有遺漏。</div>
          )}
          {holdings.data?.mode === 'hidden' && <div className="empty">交易員已隱藏持倉</div>}
          {holdings.data && holdings.data.mode !== 'hidden' && holdings.data.note !== 'ratio_unavailable' && holdings.data.holdings.length === 0 && (
            <div className="empty">目前沒有可顯示的持倉</div>
          )}
          {holdings.data?.holdings.map((h) => (
            <div key={h.symbol} className="item">
              <div className="body">
                <StockLabel symbol={h.symbol} name={h.name} />
              </div>
              {h.weight !== undefined ? (
                <span className="num">{(h.weight * 100).toFixed(1)}%</span>
              ) : (
                <span className="num muted">
                  {h.qty!.toLocaleString('en-US')} 股 · 成本 {h.avgPrice ?? '—'}
                </span>
              )}
            </div>
          ))}
          {holdings.data?.asOf && holdings.data.mode !== 'hidden' && (
            <div className="sub" style={{ paddingTop: 10 }}>
              {holdings.data.source === 'csv' ? `庫存基準日 ${fmtTime(holdings.data.asOf)}，之後的成交已套用` : `更新於 ${fmtTime(holdings.data.asOf)}`}（延遲 {minutes} 分鐘）
            </div>
          )}
        </>
      )}
    </>
  )
}

type HomeTab = 'following' | 'market' | 'watch' | 'top'

/** Find a trader by ID and open their record. Only IDs are searched. */
function TraderSearch() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ handle: string; avatarV?: number | null }[]>([])

  useEffect(() => {
    const needle = q.trim()
    if (!needle) {
      setResults([])
      return
    }
    const id = setTimeout(() => {
      api<{ results: { handle: string; avatarV?: number | null }[] }>(`/traders/search?q=${encodeURIComponent(needle)}`).then(
        (r) => setResults(r.results),
        () => setResults([]),
      )
    }, 250)
    return () => clearTimeout(id)
  }, [q])

  return (
    <div className="pad">
      <input type="search" inputMode="search" placeholder="輸入交易員 ID 查看紀錄" aria-label="搜尋交易員 ID" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={q} onChange={(e) => setQ(e.target.value)} />
      {results.map((r) => (
        <a key={r.handle} href={`#/t/${r.handle}`} className="row between" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)', color: 'inherit', textDecoration: 'none' }}>
          <span className="row" style={{ gap: 10, alignItems: 'center' }}>
            <Avatar handle={r.handle} size={32} v={r.avatarV} />
            <strong className="num">{r.handle}</strong>
          </span>
          <span className="muted small">查看紀錄 ›</span>
        </a>
      ))}
      {q.trim() && results.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>找不到這個 ID。</div>}
    </div>
  )
}

function Home() {
  const [picked, setPicked] = useState<HomeTab | null>(null)
  const top = useLive(() => api<{ entries: LeaderEntry[] }>('/leaderboard?sort=return'), [], 30_000)
  const [signedOut, setSignedOut] = useState(false)
  const feed = useLive(async () => {
    try {
      setSignedOut(false)
      return await api<{ trades: TradeItem[] }>('/feed')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSignedOut(true)
        return null
      }
      throw e
    }
  }, [])

  // Unread follow notifications: trades of followed traders that became visible since the user last looked.
  const notes = useLive(
    async () => {
      try {
        return await api<NotificationResult>('/me/notifications')
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    [],
    60_000,
  )
  const unread = notes.data?.unread ?? 0

  // Signed-in people land on the follow feed; everyone else lands on the market.
  const tab: HomeTab = picked ?? (feed.loaded && !signedOut ? 'following' : 'market')
  const setTab = (t: HomeTab) => {
    setPicked(t)
    if (t === 'following' && unread > 0) {
      api('/me/notifications/seen', { method: 'POST' }).then(notes.reload, () => {})
    }
  }

  return (
    <>
      <Header title="Trakr" />
      <UnderlineTabs
        tabs={[
          { id: 'following', label: unread > 0 ? `追蹤 ${unread}` : '追蹤' },
          { id: 'market', label: '市場' },
          { id: 'watch', label: '自選' },
          { id: 'top', label: '達人' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'market' && <MarketTab />}
      {tab === 'watch' && <WatchlistTab />}
      {tab === 'top' && (
        <>
          <TraderSearch />
          {top.error && <div className="notice warn">{top.error}</div>}
          {top.data?.entries.length === 0 && <div className="empty">還沒有符合資格的交易員。</div>}
          {top.data?.entries.slice(0, 10).map((e) => <TraderRow key={e.handle} e={e} metric="return" />)}
          {top.data && top.data.entries.length > 0 && (
            <a href="#/leaderboard" className="item tap" style={{ color: 'var(--accent)', fontWeight: 600 }}>
              查看完整排行榜
            </a>
          )}
        </>
      )}
      {tab === 'following' && (
        <>
          {signedOut && (
            <div className="notice">
              <a href="#/me">登入</a>後追蹤交易員，這裡會顯示他們的最新交易。
            </div>
          )}
          {feed.error && <div className="notice warn">{feed.error}</div>}
          {feed.data && (feed.data.trades.length === 0 ? <div className="empty">追蹤的交易員還沒有公開的交易。</div> : <TradeRows items={feed.data.trades} />)}
        </>
      )}
    </>
  )
}

// ---------- account ----------

function AuthForm({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [handle, setHandle] = useState('')
  const [handleStatus, setHandleStatus] = useState<HandleStatus>({ state: 'idle' })
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await api(mode === 'login' ? '/auth/login' : '/auth/register', {
        method: 'POST',
        body: mode === 'login' ? { email, password } : { email, handle, password },
      })
      onDone()
    } catch (e2) {
      setErr((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Header title={mode === 'login' ? '登入' : '建立帳號'} />
      {/* A real <form> with autocomplete hints lets iCloud Keychain offer to save and fill the password. */}
      <form className="pad auth-form" onSubmit={submit} style={{ paddingTop: 20 }}>
        <div className="field">
          <label htmlFor="email">電子郵件</label>
          <input id="email" name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {mode === 'register' && <HandleField value={handle} onChange={setHandle} onStatus={setHandleStatus} />}
        <div className="field">
          <label htmlFor="password">密碼（至少 8 個字元）</label>
          <input id="password" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="primary block" type="submit" disabled={busy || (mode === 'register' && (handleStatus.state === 'bad' || handleStatus.state === 'checking'))}>
          {mode === 'login' ? '登入' : '註冊'}
        </button>
        {err && <div className="small up" style={{ marginTop: 12 }}>{err}</div>}
        <button
          type="button"
          className="block"
          style={{ marginTop: 12 }}
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setErr(null)
          }}
        >
          {mode === 'login' ? '還沒有帳號？註冊' : '已有帳號？登入'}
        </button>
        {mode === 'register' && (
          <p className="muted small" style={{ marginTop: 12 }}>
            註冊即表示你已閱讀並同意 <a href="#/legal">免責聲明與條款</a>。
          </p>
        )}
      </form>
    </>
  )
}

function CsvImport({ onChanged }: { onChanged: () => void }) {
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<CsvImportResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [errLines, setErrLines] = useState<CsvImportResult['errors']>([])
  const [busy, setBusy] = useState(false)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setFileName(file.name)
    setCsv(await file.text())
    setResult(null)
    setErr(null)
    setErrLines([])
  }

  const send = async () => {
    setBusy(true)
    setErr(null)
    setResult(null)
    setErrLines([])
    try {
      const r = await api<CsvImportResult>('/me/csv-import', { method: 'POST', body: { csv } })
      setResult(r)
      setErrLines(r.errors)
      setCsv('')
      setFileName(null)
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
      setErrLines(e instanceof ApiError ? (e.body.errors ?? []) : [])
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    const ok = await confirmAction({ title: '清除已匯入', message: '刪除你匯入的所有自行回報交易？此動作無法復原。', confirmLabel: '清除', danger: true })
    if (!ok) return
    if (await attempt(() => api('/me/csv-import', { method: 'DELETE' }))) {
      setResult(null)
      showToast('已清除匯入的交易')
      onChanged()
    }
  }

  return (
    <div className="pad">
      <div className="muted small">欄位：時間、股票代號、買賣、股數（或張數）、價格，手續費可省略。支援中英文欄位名稱，時間視為台北時間。</div>
      <pre>{`時間,股票代號,買賣,股數,價格,手續費
2026-11-02 09:15,2330,買進,1000,600,855`}</pre>
      <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => pick(e.target.files?.[0])} />
      {fileName && <div className="muted small" style={{ marginTop: 6 }}>{fileName}（{csv.split(/\r?\n/).filter(Boolean).length - 1} 列）</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy || csv.trim() === ''} onClick={send}>
          匯入
        </button>
        <button className="danger" onClick={clear}>
          清除已匯入
        </button>
      </div>
      {result && (
        <div className="small down" style={{ marginTop: 10 }}>
          已匯入 {result.imported} 筆{result.duplicates > 0 && `，略過重複 ${result.duplicates} 筆`}
          {result.rejected > 0 && `，${result.rejected} 筆無法使用`}
        </div>
      )}
      {err && <div className="small up" style={{ marginTop: 10 }}>{err === 'no valid rows' ? '沒有可匯入的資料列' : err}</div>}
      {errLines.length > 0 && (
        <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {errLines.map((x, i) => (
            <li key={i}>第 {x.line} 列：{x.message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Upload a holdings snapshot (期初庫存) so later trades can be applied to it. */
function HoldingsImport({ onChanged }: { onChanged: () => void }) {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const [asOf, setAsOf] = useState(today)
  const [csv, setCsv] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [errLines, setErrLines] = useState<{ line: number; message: string }[]>([])
  const list = useLive(() => api<{ snapshots: HoldingsSnapshot[] }>('/me/holdings-import'), [], 60_000)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setFileName(file.name)
    setCsv(await file.text())
    setMsg(null)
    setErrLines([])
  }

  const submit = async (text: string) => {
    setBusy(true)
    setMsg(null)
    setErrLines([])
    try {
      const r = await api<{ positions: number; reconciledWith: string | null; mismatches: HoldingsSnapshot['mismatches'] }>('/me/holdings-import', {
        method: 'POST',
        body: { asOf, csv: text },
      })
      const n = r.mismatches.length
      setMsg({
        ok: n === 0,
        text:
          `已儲存 ${asOf} 的庫存（${r.positions} 檔）` +
          (r.reconciledWith ? `。與 ${r.reconciledWith} 的推算比對：${n === 0 ? '一致' : `有 ${n} 檔不一致`}` : ''),
      })
      setCsv(null)
      setFileName(null)
      list.reload()
      onChanged()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
      setErrLines(e instanceof ApiError ? (e.body.errors ?? []) : [])
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: number, date: string) => {
    const ok = await confirmAction({
      title: '刪除庫存紀錄',
      message: `刪除 ${date} 的庫存？之後的持倉會改以更早的庫存推算。`,
      confirmLabel: '刪除',
      danger: true,
    })
    if (!ok) return
    if (await attempt(() => api(`/me/holdings-import/${id}`, { method: 'DELETE' }))) {
      showToast('已刪除')
      list.reload()
      onChanged()
    }
  }

  const rowCount = csv === null ? 0 : csv.split(/\r?\n/).filter((l) => l.trim() !== '').length - 1

  return (
    <div className="pad">
      <div className="muted small">
        只有成交紀錄看不出持倉，因為不知道起點。請上傳某一天收盤時的庫存（券商 App 匯出，或你自己整理的 CSV），之後的成交會自動套用到這個起點上。欄位：股票代號、股數（或張數），均價可省略。
      </div>
      <pre>{`股票代號,股數,均價
2330,2000,580
2317,1000,120`}</pre>
      <div className="field">
        <label htmlFor="holdings-date">庫存日期（收盤時的持股）</label>
        <input id="holdings-date" type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} />
      </div>
      <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => pick(e.target.files?.[0])} />
      {fileName && <div className="muted small" style={{ marginTop: 6 }}>{fileName}（{Math.max(0, rowCount)} 檔）</div>}
      <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <button className="primary" disabled={busy || csv === null} onClick={() => csv !== null && submit(csv)}>
          上傳庫存
        </button>
        <button disabled={busy} onClick={() => submit('')}>
          這天沒有任何持股
        </button>
      </div>
      {msg && <div className={`small ${msg.ok ? 'down' : 'up'}`} style={{ marginTop: 10 }}>{msg.text}</div>}
      {errLines.length > 0 && (
        <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {errLines.map((x, i) => (
            <li key={i}>第 {x.line} 列：{x.message}</li>
          ))}
        </ul>
      )}

      {(list.data?.snapshots.length ?? 0) > 0 && <div className="section" style={{ padding: '14px 0 6px', border: 0 }}>已上傳的庫存</div>}
      {list.data?.snapshots.map((s) => (
        <div key={s.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
          <div className="row between">
            <div className="small">
              <strong className="num">{s.asOf}</strong> · {s.positions} 檔
              {s.mismatches.length > 0 && <span className="up"> · 與推算有 {s.mismatches.length} 檔不一致</span>}
            </div>
            <button className="linkbtn" onClick={() => remove(s.id, s.asOf)}>
              刪除
            </button>
          </div>
          {s.mismatches.map((m) => (
            <div key={m.symbol} className="small muted num" style={{ marginTop: 4 }}>
              {m.symbol}：依成交推算 {m.expected} 股，庫存顯示 {m.reported} 股
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function AgentKeys() {
  const keys = useLive(() => api<{ keys: AgentKey[] }>('/me/agent-keys'), [], 30_000)
  const [fresh, setFresh] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const create = async () => {
    setErr(null)
    try {
      setFresh((await api<{ key: string }>('/me/agent-keys', { method: 'POST' })).key)
      keys.reload()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const revoke = async (id: number) => {
    const ok = await confirmAction({ title: `撤銷金鑰 #${id}`, message: '撤銷後，使用這把金鑰的同步程式會立即停止運作。確定嗎？', confirmLabel: '撤銷', danger: true })
    if (!ok) return
    if (await attempt(() => api(`/me/agent-keys/${id}`, { method: 'DELETE' }))) {
      showToast('金鑰已撤銷')
      keys.reload()
    }
  }

  return (
    <div className="pad">
      <div className="muted small">同步金鑰只能上傳你的交易資料，不能登入網站，也不能下單。外洩時直接撤銷即可。</div>
      {fresh && (
        <div className="notice warn" style={{ margin: '12px 0' }}>
          金鑰只會顯示這一次，請現在複製：
          <pre>{fresh}</pre>
        </div>
      )}
      {keys.data?.keys.map((k) => (
        <div key={k.id} className="row between" style={{ margin: '10px 0' }}>
          <div className="small">
            金鑰 #{k.id}
            <div className="muted">
              建立 {fmtTime(k.createdAt)} · {k.lastUsedAt ? `最後使用 ${fmtTime(k.lastUsedAt)}` : '尚未使用'}
            </div>
          </div>
          <button onClick={() => revoke(k.id)}>撤銷</button>
        </div>
      ))}
      <button className="primary" onClick={create} style={{ marginTop: 8 }}>
        建立同步金鑰
      </button>
      {err && <div className="small up" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  )
}

/** Accounts you have blocked, with a way to unblock. Blocked accounts are hidden from you and you from them. */
function BlockedList() {
  const list = useLive(() => api<{ blocked: { handle: string }[] }>('/me/blocks'), [], 20_000)
  const unblock = async (handle: string) => {
    if (await attempt(() => api(`/traders/${handle}/block`, { method: 'DELETE' }))) list.reload()
  }
  const rows = list.data?.blocked ?? []
  return (
    <>
      <div className="section">已封鎖的使用者</div>
      <div className="pad" style={{ paddingTop: 0 }}>
        {rows.length === 0 && <div className="muted small">沒有封鎖任何人。</div>}
        {rows.map((b) => (
          <div key={b.handle} className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span className="grow">{b.handle}</span>
            <button onClick={() => unblock(b.handle)}>解除封鎖</button>
          </div>
        ))}
      </div>
    </>
  )
}

/** Permanently deletes the account and everything in it. Needs the password, and a confirmation dialog. */
function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [password, setPassword] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const ok = await confirmAction({
      title: '刪除帳號',
      message: '刪除後，你的交易紀錄、持倉、同步金鑰、貼文與追蹤關係都會永久移除，無法復原。確定要刪除嗎？',
      confirmLabel: '永久刪除',
      danger: true,
    })
    if (!ok) return
    if (await attempt(() => api('/me/delete', { method: 'POST', body: { password } }))) {
      setPassword('')
      showToast('帳號已刪除')
      onDeleted()
    }
  }
  return (
    <>
      <div className="section">刪除帳號</div>
      <form className="pad" onSubmit={submit}>
        <div className="muted small">刪除後無法復原，你的所有資料都會從伺服器移除，ID 也會釋放給其他人使用。</div>
        <div className="field">
          <label htmlFor="del-pw">輸入密碼以確認</label>
          <input id="del-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" className="danger" disabled={!password}>
          刪除帳號
        </button>
      </form>
    </>
  )
}

function ChangePassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api('/auth/password', { method: 'POST', body: { current, next } })
      setCurrent('')
      setNext('')
      setMsg({ ok: true, text: '已更新，其他裝置已登出' })
    } catch (e2) {
      setMsg({ ok: false, text: (e2 as Error).message })
    }
  }
  return (
    <form className="pad" onSubmit={submit}>
      <div className="field">
        <label htmlFor="cur">目前密碼</label>
        <input id="cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="new">新密碼（至少 8 個字元）</label>
        <input id="new" type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <button type="submit">變更密碼</button>
      {msg && <div className={`small ${msg.ok ? 'down' : 'up'}`} style={{ marginTop: 10 }}>{msg.text}</div>}
    </form>
  )
}

function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="choice" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Appearance() {
  const [size, setSize] = useState<TextSize>(getTextSize())
  const [theme, setThemeState] = useState<Theme>(getTheme())
  return (
    <div className="pad" style={{ paddingTop: 0 }}>
      <div className="field">
        <label>文字大小</label>
        <Choice
          label="文字大小"
          value={size}
          onChange={(s) => {
            setSize(s)
            setTextSize(s)
          }}
          options={[
            { id: 'small', label: '小' },
            { id: 'standard', label: '標準' },
            { id: 'large', label: '大' },
            { id: 'xlarge', label: '特大' },
          ]}
        />
      </div>
      <div className="field">
        <label>主題</label>
        <Choice
          label="主題"
          value={theme}
          onChange={(t) => {
            setThemeState(t)
            setTheme(t)
          }}
          options={[
            { id: 'system', label: '跟隨系統' },
            { id: 'dark', label: '深色' },
            { id: 'light', label: '淺色' },
          ]}
        />
      </div>
      <div className="notice" style={{ margin: '0 0 8px' }}>
        <div className="post-text" style={{ marginTop: 0, color: 'var(--text)' }}>
          台積電 2330 今天收盤上漲 <span className="up num">+1.25%</span>，成交量明顯放大。
        </div>
      </div>
      <div className="muted small">在 iPhone 上也會跟著「設定 → 螢幕顯示與亮度 → 文字大小」調整。</div>
    </div>
  )
}

/** Your own trades, including unverified CSV rows. Shown only on your own page; the owner always sees them in full. */
function MyTrades({ handle }: { handle: string }) {
  const mine = useLive(() => api<{ trades: TradeItem[] }>(`/traders/${handle}/trades`), [handle], 30_000)
  const trades = mine.data?.trades ?? []
  if (mine.error) return <div className="notice warn">{mine.error}</div>
  if (mine.loaded && trades.length === 0) return <div className="empty">還沒有交易紀錄。綁定券商或上傳 CSV 後會顯示在這裡。</div>
  return <TradeRows items={trades.slice(0, 20)} hideHandle />
}

/** Gear icon in the top bar. Everything you fill in or manage lives behind it. */
function SettingsLink() {
  return (
    <a href="#/settings" className="iconbtn" aria-label="設定">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    </a>
  )
}

/** Your page: who you are, your own trades, and what your verification level means. */
function MePage() {
  const me = useLive(fetchMe, [], 20_000)
  const m = me.data
  const profile = useLive(() => (m ? api<TraderDetail>(`/traders/${m.handle}`) : Promise.resolve(null)), [m?.handle], 20_000)

  if (me.error) return <div className="notice warn">{me.error}</div>
  if (!me.loaded) return <Header title="我" right={<SettingsLink />} />
  if (!m) return <AuthForm onDone={me.reload} />

  const level = profile.data?.level ?? 0
  return (
    <>
      <Header title="我" right={<SettingsLink />} />
      <ProfileHeader m={m} level={level} onChanged={() => { me.reload(); profile.reload() }} />

      <div className="section">我的交易</div>
      <MyTrades handle={m.handle} />

      <div className="section">驗證等級</div>
      <div className="pad" style={{ paddingTop: 0 }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
          <VerifiedBadge />
          <div className="small">
            <strong>Level 2 · 券商驗證</strong>
            <div className="muted">透過券商 API 取得成交紀錄，可核對價格、數量與時間，才會列入實盤績效排行榜。</div>
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
          <span className="tag" style={{ marginTop: 1 }}>自行回報</span>
          <div className="small">
            <strong>Level 1 · 自行上傳</strong>
            <div className="muted">自行輸入或上傳 CSV，尚未取得可信來源證明。可以顯示交易紀錄，但不列入排行榜。</div>
          </div>
        </div>
        <div className="small" style={{ marginTop: 12 }}>
          目前等級：<strong>{level === 2 ? 'Level 2 · 券商驗證' : level === 1 ? 'Level 1 · 自行上傳' : '尚未分享交易'}</strong>
          {m.lastSyncAt && <span className="muted"> · 最後同步 {fmtTime(m.lastSyncAt)}</span>}
        </div>
      </div>
    </>
  )
}

/** Everything you fill in or manage: profile text, broker sync, uploads, appearance, privacy, account. */
function SettingsPage() {
  const me = useLive(fetchMe, [], 20_000)
  const m = me.data
  const profile = useLive(() => (m ? api<TraderDetail>(`/traders/${m.handle}`) : Promise.resolve(null)), [m?.handle], 20_000)

  const save = async (patch: { delaySec?: number; holdingsVisibility?: string }) => {
    if (await attempt(() => api('/me/settings', { method: 'PUT', body: patch }))) {
      showToast('設定已更新')
      me.reload()
    }
  }
  const logout = async () => {
    if (await attempt(() => api('/auth/logout', { method: 'POST' }))) me.reload()
  }

  if (me.error) return <div className="notice warn">{me.error}</div>
  if (!me.loaded) return <Header title="設定" back="#/me" />
  if (!m) return <AuthForm onDone={me.reload} />

  return (
    <>
      <Header title="設定" back="#/me" />

      <div className="section first">個人簡介與社群連結</div>
      <ProfileEditor me={m} onSaved={() => { me.reload(); profile.reload() }} />

      <div className="section">Level 2：券商同步</div>
      <div className="pad" style={{ paddingTop: 0 }}>
        <div className="muted small">在你自己的電腦或主機上執行唯讀同步程式。它不會下單、不載入憑證（CA），券商金鑰不會離開你的電腦。</div>
        <pre>{`pip install shioaji
set SHIOAJI_API_KEY=...
set SHIOAJI_SECRET_KEY=...
set TOT_AGENT_KEY=<下方建立的同步金鑰>
python -m tot_agent --broker shioaji --server ${location.origin}`}</pre>
      </div>
      <AgentKeys />

      <div className="section">Level 1：匯入 CSV</div>
      <CsvImport onChanged={profile.reload} />

      <div className="section">Level 1：庫存快照（期初持倉）</div>
      <HoldingsImport onChanged={profile.reload} />

      <div className="section">外觀與文字大小</div>
      <Appearance />

      <div className="section">隱私與防狙擊</div>
      <div className="pad" style={{ paddingTop: 0 }}>
        <div className="field">
          <label htmlFor="delay">交易紀錄延遲公開（最少 3 分鐘）</label>
          <select id="delay" value={m.delaySec} onChange={(e) => save({ delaySec: Number(e.target.value) })}>
            {[180, 240, 300, 600, 1800].map((s) => (
              <option key={s} value={s}>
                {s / 60} 分鐘
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="vis">持倉顯示</label>
          <select id="vis" value={m.holdingsVisibility} onChange={(e) => save({ holdingsVisibility: e.target.value })}>
            <option value="public">完整公開（標的、股數、成本）</option>
            <option value="ratio">只顯示比重</option>
            <option value="hidden">完全隱藏</option>
          </select>
        </div>
      </div>

      <BlockedList />

      <div className="section">帳號安全</div>
      <ChangePassword />
      <div className="pad">
        <button onClick={logout}>登出</button>
      </div>
      <DeleteAccount onDeleted={me.reload} />

      <div className="section">條款與說明</div>
      <div className="pad" style={{ paddingTop: 0 }}>
        <a href="#/legal">免責聲明與條款</a>
        <br />
        <a href="#/install">安裝到 iPhone</a>
      </div>
    </>
  )
}

type Tab = 'home' | 'global' | 'leaderboard' | 'me'

/** Outline when idle, solid when selected: the same cue X and Threads use. */
function TabIcon({ id, active }: { id: Tab; active: boolean }) {
  const common = { viewBox: '0 0 24 24', fill: active ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (id) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 11.2 12 3.5l9 7.7V20a.8.8 0 0 1-.8.8H15v-6.2H9v6.2H3.8a.8.8 0 0 1-.8-.8z" />
        </svg>
      )
    case 'global':
      return (
        <svg {...common} fill="none" strokeWidth={active ? 2.6 : 1.9}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3c2.8 3 2.8 15 0 18" />
          <path d="M12 3c-2.8 3-2.8 15 0 18" />
        </svg>
      )
    case 'leaderboard':
      return (
        <svg {...common}>
          <rect x="3.5" y="12" width="4.5" height="8.5" rx="1" />
          <rect x="9.75" y="4" width="4.5" height="16.5" rx="1" />
          <rect x="16" y="9" width="4.5" height="11.5" rx="1" />
        </svg>
      )
    case 'me':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4.2 3.6-6.5 8-6.5s8 2.3 8 6.5z" />
        </svg>
      )
  }
}

const TABS: { id: Tab; href: string; label: string }[] = [
  { id: 'home', href: '#/', label: '首頁' },
  { id: 'global', href: '#/global', label: '社群' },
  { id: 'leaderboard', href: '#/leaderboard', label: '排行榜' },
  { id: 'me', href: '#/me', label: '我' },
]

export function App() {
  const [page, a] = useRoute()

  let tab: Tab
  let view: React.ReactNode
  if (page === 't' && a) {
    tab = 'leaderboard'
    view = <Trader handle={a} key={a} />
  } else if (page === 'g' && a) {
    tab = 'global'
    view = <PostDetail id={a} key={a} />
  } else if (page === 's' && a) {
    tab = 'home'
    view = <StockPage code={a} key={a} />
  } else if (page === 'settings') {
    tab = 'me'
    view = <SettingsPage />
  } else if (page === 'legal') {
    tab = 'me'
    view = <LegalPage />
  } else if (page === 'install') {
    tab = 'me'
    view = <InstallPage />
  } else if (page === 'global') {
    tab = 'global'
    view = <Global />
  } else if (page === 'leaderboard') {
    tab = 'leaderboard'
    view = <Leaderboard />
  } else if (page === 'me') {
    tab = 'me'
    view = <MePage />
  } else {
    tab = 'home'
    view = <Home />
  }

  return (
    <>
      {view}
      <Footer />
      <DialogHost />
      <nav className="tabbar" aria-label="主選單">
        {TABS.map((t) => (
          <a key={t.id} href={t.href} className={tab === t.id ? 'on' : ''} aria-label={t.label} aria-current={tab === t.id ? 'page' : undefined}>
            <TabIcon id={t.id} active={tab === t.id} />
          </a>
        ))}
      </nav>
    </>
  )
}
