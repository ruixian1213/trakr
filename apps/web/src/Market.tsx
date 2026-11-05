import { useEffect, useState } from 'react'
import {
  ApiError,
  api,
  type FollowedHolder,
  type HolderWeek,
  type MarketOverview,
  type MarketQuote,
  type MarketSource,
  type StockDetails,
  type StockResult,
  type TopVolume,
  type WatchlistResult,
} from './api.ts'
import { compactTW, lots, price, signed, tone, useLive } from './lib.tsx'
import { Avatar, Header, LevelMark, attempt } from './ui.tsx'

/**
 * The Government Open Data License is void without this notice (agency, year, dataset and version,
 * the licence statement and a link), so every screen that shows TWSE data renders it.
 */
export function Attribution({ source, asOf, stale }: { source: MarketSource; asOf: string | null; stale: boolean }) {
  return (
    <div className="sub attribution">
      資料來源：{source.agency}（{asOf ? `${asOf.slice(0, 4)} 年` : ''}「{source.datasets}」，版本 {source.version}）。本資料依「{source.licenseName}」公眾釋出，使用須遵守其條款：
      <a href={source.licenseUrl} target="_blank" rel="noopener noreferrer">
        {source.licenseUrl}
      </a>
      。{source.note}
      {asOf && `，資料日期 ${asOf}`}。{stale && ' 證交所目前暫時無法連線，顯示的是上一次成功取得的資料。'}
    </div>
  )
}

const changeText = (q: { change: number | null; changePct: number | null }) => `${signed(q.change)}（${signed(q.changePct)}%）`

function QuoteRow({ q, rank, metric, onRemove }: { q: MarketQuote; rank?: number; /** which figure a ranking is about */ metric?: 'value' | 'volume'; onRemove?: () => void }) {
  const t = q.change === null ? '' : tone(q.change)
  const link = (
    <a href={`#/s/${q.code}`} className="quote-link">
      {rank !== undefined && <div className={`rank ${rank <= 3 ? 'top' : ''}`}>{rank}</div>}
      <div className="body">
        <div className="head">
          <strong>{q.name}</strong>
        </div>
        <div className="muted small num">
          {q.code}
          {metric === 'value' ? q.value !== null && ` · 成交額 ${compactTW(q.value)}元` : q.volume !== null && q.volume > 0 && ` · ${metric === 'volume' ? '成交量' : '量'} ${lots(q.volume)}`}
        </div>
      </div>
      <div className="num quote-num">
        <div className={`quote-price ${t}`}>{price(q.close)}</div>
        <div className={`small ${t}`}>{changeText(q)}</div>
      </div>
    </a>
  )
  return (
    <div className="item quote-item">
      {link}
      {onRemove && (
        <button className="linkbtn" onClick={onRemove} aria-label={`移除 ${q.name}`}>
          移除
        </button>
      )}
    </div>
  )
}

export function MarketTab() {
  const ov = useLive(() => api<MarketOverview>('/market/overview'), [], 60_000)
  // Two rankings of the same market: by money changing hands, and by number of shares.
  const [rank, setRank] = useState<'value' | 'volume'>('value')
  const top = useLive(() => api<TopVolume>(rank === 'value' ? '/market/top-value' : '/market/top-volume'), [rank], 60_000)
  const o = ov.data
  const t = o ? tone(o.taiex.change ?? 0) : ''

  return (
    <>
      {ov.error && <div className="notice warn">{ov.error === 'market data temporarily unavailable' ? '證交所資料暫時無法取得，請稍後再試。' : ov.error}</div>}
      {o && (
        <>
          <div className="pad index-card">
            <div className="muted small">發行量加權股價指數</div>
            <div className={`index-value num ${t}`}>{price(o.taiex.close)}</div>
            <div className={`num ${t}`} style={{ fontWeight: 600 }}>
              {o.taiex.change !== null && o.taiex.change > 0 ? '▲' : o.taiex.change !== null && o.taiex.change < 0 ? '▼' : ''} {changeText(o.taiex)}
            </div>
            <div className="muted small num" style={{ marginTop: 6 }}>
              成交金額 {compactTW(o.market.value)}元 · 成交量 {lots(o.market.volume)} · {compactTW(o.market.transactions)}筆
            </div>
          </div>
          {o.indices.length > 0 && (
            <div className="chips" role="list">
              {o.indices.map((i) => (
                <div key={i.name} className="chip" role="listitem">
                  <div className="muted small">{i.name.replace('指數', '')}</div>
                  <div className={`num ${tone(i.change ?? 0)}`} style={{ fontWeight: 700 }}>
                    {price(i.close)}
                  </div>
                  <div className={`small num ${tone(i.change ?? 0)}`}>{signed(i.changePct)}%</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="section">成交排行</div>
      <div className="pad" style={{ paddingTop: 0 }}>
        <div className="choice" role="radiogroup" aria-label="排行方式">
          {(
            [
              ['value', '成交額'],
              ['volume', '成交量'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="radio" aria-checked={rank === id} className={rank === id ? 'on' : ''} onClick={() => setRank(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          {rank === 'value' ? '依成交金額（元）排序，反映資金湧入哪些股票。' : '依成交股數排序，低價股與 ETF 常因股數多而上榜。'}
        </div>
      </div>
      {top.error && <div className="notice warn">{top.error === 'market data temporarily unavailable' ? '證交所資料暫時無法取得，請稍後再試。' : top.error}</div>}
      {top.data?.rows.map((r) => <QuoteRow key={`${rank}-${r.code}`} q={r} rank={r.rank} metric={rank} />)}
      {top.data && <Attribution source={top.data.source} asOf={top.data.asOf} stale={top.data.stale || !!o?.stale} />}
    </>
  )
}

function StockSearch({ held, onAdded }: { held: Set<string>; onAdded: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<MarketQuote[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      return
    }
    const id = setTimeout(() => {
      api<{ results: MarketQuote[] }>(`/market/search?q=${encodeURIComponent(q.trim())}`).then(
        (r) => setResults(r.results),
        (e: Error) => setErr(e.message),
      )
    }, 250)
    return () => clearTimeout(id)
  }, [q])

  const add = async (code: string) => {
    setErr(null)
    try {
      await api(`/me/watchlist/${encodeURIComponent(code)}`, { method: 'PUT' })
      onAdded()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="pad">
      <input type="search" inputMode="search" placeholder="搜尋股票代號或名稱，例如 2330 或 台積電" aria-label="搜尋股票" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <div className="small up" style={{ marginTop: 8 }}>{err}</div>}
      {results.map((r) => (
        <div key={r.code} className="row between" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
          <div>
            <strong>{r.name}</strong>
            <div className="muted small num">{r.code}</div>
          </div>
          {held.has(r.code) ? (
            <span className="muted small">已加入</span>
          ) : (
            <button className="primary" onClick={() => add(r.code)}>
              加入
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function WatchlistTab() {
  const [signedOut, setSignedOut] = useState(false)
  const wl = useLive(async () => {
    try {
      setSignedOut(false)
      return await api<WatchlistResult>('/me/watchlist')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSignedOut(true)
        return null
      }
      throw e
    }
  }, [], 60_000)

  if (signedOut) {
    return (
      <div className="notice">
        <a href="#/me">登入</a>後即可建立自選股，追蹤你關心的股票。
      </div>
    )
  }

  const items = wl.data?.items ?? []
  const remove = async (code: string) => {
    if (await attempt(() => api(`/me/watchlist/${encodeURIComponent(code)}`, { method: 'DELETE' }))) wl.reload()
  }

  return (
    <>
      <StockSearch held={new Set(items.map((i) => i.code))} onAdded={wl.reload} />
      {wl.error && <div className="notice warn">{wl.error}</div>}
      {wl.data?.unavailable && <div className="notice warn">暫時無法取得股價，下面是你的自選清單。</div>}
      {wl.loaded && !wl.error && items.length === 0 && <div className="empty">還沒有自選股，用上面的搜尋框加入第一檔。</div>}
      {items.map((i) =>
        i.quote ? (
          <QuoteRow key={i.code} q={i.quote} onRemove={() => remove(i.code)} />
        ) : (
          <div key={i.code} className="item quote-item">
            <div className="body">
              <strong className="num">{i.code}</strong>
              <div className="muted small">暫無報價</div>
            </div>
            <button className="linkbtn" onClick={() => remove(i.code)}>
              移除
            </button>
          </div>
        ),
      )}
      {wl.data && wl.data.items.length > 0 && !wl.data.unavailable && <Attribution source={wl.data.source} asOf={wl.data.asOf} stale={wl.data.stale} />}
    </>
  )
}

const EX_KIND: Record<string, string> = { 息: '除息', 權: '除權', 權息: '除權息' }

/** Margin balances are in shares. Under one lot, show shares: "13股" reads better than "0張". */
const balance = (n: number | null) => (n === null ? '—' : n < 1000 ? `${n.toLocaleString('en-US')}股` : lots(n))
const dayChange = (now: number | null, before: number | null) =>
  now === null || before === null ? '' : `較前日 ${signed((now - before) / 1000, 1)}張`

/** Change from one week (or day) to the next, written out so no one has to compare two numbers by eye. */
const vsBefore = (now: number, before: number | null | undefined, unit: string, digits = 2) =>
  before === null || before === undefined ? '' : `較前次 ${signed(now - before, digits)}${unit}`

function BigHolders({ holders }: { holders: NonNullable<StockDetails['holders']> }) {
  const cur: HolderWeek = holders.current
  const prev = holders.previous
  return (
    <>
      <div className="section">大戶持股（集保每週資料）</div>
      <div className="pad">
        <div className="stats">
          <div>
            <div className="label">400 張以上</div>
            <div className="value sm num">{cur.pct400}%</div>
            <div className="small muted num">{vsBefore(cur.pct400, prev?.pct400, '%')}</div>
          </div>
          <div>
            <div className="label">千張大戶人數</div>
            <div className="value sm num">{cur.people1000.toLocaleString('en-US')}</div>
            <div className="small muted num">{vsBefore(cur.people1000, prev?.people1000, '人', 0)}</div>
          </div>
          <div>
            <div className="label">千張大戶持股</div>
            <div className="value sm num">{cur.pct1000}%</div>
            <div className="small muted num">{vsBefore(cur.pct1000, prev?.pct1000, '%')}</div>
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          {prev ? `與 ${prev.asOf} 比較。` : '趨勢需要至少兩週的資料，之後會顯示變化。'}資料日 {cur.asOf}，只代表持股分布，不代表特定人士的買賣。
        </div>
      </div>
      <Attribution source={holders.source} asOf={cur.asOf} stale={false} />
    </>
  )
}

function StockInsight({ code }: { code: string }) {
  const det = useLive(() => api<StockDetails>(`/market/stocks/${encodeURIComponent(code)}/details`), [code], 5 * 60_000)
  const [signedOut, setSignedOut] = useState(false)
  const followed = useLive(
    async () => {
      try {
        setSignedOut(false)
        return await api<{ holders: FollowedHolder[] }>(`/market/stocks/${encodeURIComponent(code)}/followed-holders`)
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setSignedOut(true)
          return null
        }
        throw e
      }
    },
    [code],
    5 * 60_000,
  )
  const d = det.data
  const m = d?.margin?.row

  return (
    <>
      {d?.holders ? <BigHolders holders={d.holders} /> : det.loaded && <div className="notice">暫時無法取得集保大戶資料。</div>}

      <div className="section">融資融券（每日）</div>
      {m ? (
        <div className="pad">
          <div className="stats">
            <div>
              <div className="label">融資餘額</div>
              <div className="value sm num">{balance(m.margin)}</div>
              <div className="small muted num">{dayChange(m.margin, m.marginPrev)}</div>
            </div>
            <div>
              <div className="label">融券餘額</div>
              <div className="value sm num">{balance(m.short)}</div>
              <div className="small muted num">{dayChange(m.short, m.shortPrev)}</div>
            </div>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>餘額為證交所每日盤後數字，只呈現變化，不代表任何買賣判斷。</div>
        </div>
      ) : (
        det.loaded && <div className="empty">這檔股票目前沒有融資融券資料。</div>
      )}

      <div className="section">除權息預告</div>
      {d?.exDividend && d.exDividend.rows.length > 0 ? (
        d.exDividend.rows.map((r) => (
          <div className="item" key={`${r.date}-${r.kind}`}>
            <div className="row between">
              <strong className="num">{r.date ?? '日期未定'}</strong>
              <span className="tag">{EX_KIND[r.kind] ?? r.kind}</span>
            </div>
            <div className="muted small num">
              {r.cashDividend !== null && `現金股利 ${r.cashDividend} 元`}
              {r.stockDividendRatio !== null && r.stockDividendRatio !== 0 && ` · 配股 ${r.stockDividendRatio}`}
            </div>
          </div>
        ))
      ) : (
        det.loaded && <div className="empty">近期沒有除權息預告。</div>
      )}

      <div className="section">你追蹤的人{followed.data && followed.data.holders.length > 0 ? `（${followed.data.holders.length} 位持有這檔股票）` : ''}</div>
      {signedOut ? (
        <div className="notice">
          <a href="#/me">登入</a>後，可以看到你追蹤的交易員是否持有這檔股票。
        </div>
      ) : followed.data && followed.data.holders.length > 0 ? (
        followed.data.holders.map((h) => (
          <a key={h.handle} href={`#/t/${h.handle}`} className="item tap">
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <Avatar handle={h.handle} size={32} v={h.avatarV} />
              <div className="body">
                <div className="head">
                  <strong>{h.handle}</strong> <LevelMark level={h.level} />
                </div>
                <div className="muted small num">
                  {h.qty !== null ? `持有 ${lots(h.qty)}` : h.weight !== null ? `占持股約 ${h.weight}%` : '持股未公開'}
                  {h.asOf && ` · ${h.asOf.slice(0, 10)}`}
                </div>
              </div>
            </div>
          </a>
        ))
      ) : (
        followed.loaded && <div className="empty">你追蹤的交易員目前沒有持有這檔股票（或其持股已隱藏）。</div>
      )}
      <div className="muted small" style={{ padding: '0 16px 8px' }}>
        只列出你追蹤的交易員、且已依其延遲設定公開的持股。
      </div>
    </>
  )
}

export function StockPage({ code }: { code: string }) {
  const st = useLive(() => api<StockResult>(`/market/stocks/${encodeURIComponent(code)}`), [code], 60_000)
  const [msg, setMsg] = useState<string | null>(null)

  if (st.error) {
    return (
      <>
        <Header title={code} back="#/" />
        <div className="empty">{st.error === 'not found' ? '找不到這檔股票' : st.error === 'market data temporarily unavailable' ? '證交所資料暫時無法取得，請稍後再試。' : st.error}</div>
      </>
    )
  }
  const d = st.data
  if (!d) return <Header title={code} back="#/" />

  const q = d.quote
  const t = q.change === null ? '' : tone(q.change)
  const toggle = async () => {
    setMsg(null)
    try {
      await api(`/me/watchlist/${encodeURIComponent(q.code)}`, { method: d.watching ? 'DELETE' : 'PUT' })
      st.reload()
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 401 ? '請先登入才能使用自選股' : (e as Error).message)
    }
  }

  return (
    <>
      <Header title={q.name} back="#/" />
      <div className="pad index-card">
        <div className="row between">
          <span className="muted num">{q.code}</span>
          <button className={d.watching ? '' : 'primary'} onClick={toggle}>
            {d.watching ? '已在自選' : '加入自選'}
          </button>
        </div>
        {msg && <div className="small up" style={{ marginTop: 6 }}>{msg}</div>}
        <div className={`index-value num ${t}`}>{price(q.close)}</div>
        <div className={`num ${t}`} style={{ fontWeight: 600 }}>
          {changeText(q)}
        </div>
      </div>
      <div className="stats">
        {[
          ['開盤', price(q.open)],
          ['最高', price(q.high)],
          ['最低', price(q.low)],
          ['成交量', lots(q.volume)],
          ['成交值', `${compactTW(q.value)}元`],
          ['成交筆數', compactTW(q.transactions)],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="label">{label}</div>
            <div className="value sm num">{value}</div>
          </div>
        ))}
      </div>
      <StockInsight code={q.code} />
      <Attribution source={d.source} asOf={d.asOf} stale={d.stale} />
    </>
  )
}
