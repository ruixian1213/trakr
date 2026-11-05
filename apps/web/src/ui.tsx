import { useEffect, useRef, useState, type ReactNode } from 'react'

// Every shade gives at least 4.8:1 against the white initial (WCAG AA needs 4.5:1).
const PALETTE = ['#5463eb', '#c34174', '#a36120', '#19815e', '#885acb', '#2778a0', '#8a6e1f']

/** Initial on a colour picked from the handle, so the same person always looks the same. */
export function Avatar({ handle, size = 40, v }: { handle: string; size?: number; /** photo version from the API; absent means no photo */ v?: number | null }) {
  const [broken, setBroken] = useState(false)
  if (v && !broken) {
    // The version in the URL lets the browser cache the photo permanently; a new upload changes it.
    return (
      <img
        className="avatar photo"
        src={`/api/users/${encodeURIComponent(handle)}/avatar?v=${v}`}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
      />
    )
  }
  let h = 0
  for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span className="avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.42, background: PALETTE[h % PALETTE.length] }}>
      {handle.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Blue check, as on X and Threads. Means Level 2: trades pulled from the broker API. */
export function VerifiedBadge() {
  return (
    <svg className="verified" viewBox="0 0 24 24" role="img" aria-label="券商驗證">
      <title>券商驗證</title>
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A handle with the blue check beside it when the trader is broker-verified (Level 2). */
export function HandleName({ handle, verified, mono }: { handle: string; verified?: boolean; mono?: boolean }) {
  return (
    <span className="handle-name">
      <strong className={mono ? "num" : undefined}>{handle}</strong>
      {verified && <VerifiedBadge />}
    </span>
  )
}

/** Level 2 shows the check; Level 1 shows a plain "self-reported" tag; Level 0 shows nothing. */
export function LevelMark({ level }: { level: number }) {
  if (level >= 2) return <VerifiedBadge />
  if (level === 1) return <span className="tag">自行回報</span>
  return null
}

/**
 * A stock as people say it: name first, code beside it ("台積電 2330"). Links to the stock page.
 * If the name is unknown (TWSE data unavailable, or a code TWSE does not list) the code stands alone.
 */
export function StockLabel({ symbol, name }: { symbol: string; name?: string | null }) {
  return (
    <a href={`#/s/${encodeURIComponent(symbol)}`} className="stock-label">
      <strong>{name ?? symbol}</strong>
      {name && <span className="muted small num">{symbol}</span>}
    </a>
  )
}

// ---------- confirmation dialog and toast ----------
//
// Never use window.confirm / alert / prompt. In-app browsers and webviews (the kind people open links
// from inside chat and social apps) suppress them and answer "cancel" instantly, so any action guarded
// by confirm() silently does nothing. These render inside the page and always work.

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  /** Styles the confirm button as destructive. */
  danger?: boolean
}

let askImpl: ((o: ConfirmOptions) => Promise<boolean>) | null = null
let toastImpl: ((text: string) => void) | null = null

/** Resolves true only if the user explicitly confirms. If the host is not mounted it resolves false (fail safe). */
export const confirmAction = (o: ConfirmOptions): Promise<boolean> => (askImpl ? askImpl(o) : Promise.resolve(false))

export const showToast = (text: string) => toastImpl?.(text)

/** Runs a mutating action; if it throws, the reason is shown instead of vanishing. Returns whether it succeeded. */
export async function attempt(fn: () => Promise<unknown>, fallback = '操作失敗，請稍後再試'): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (e) {
    showToast(e instanceof Error && e.message ? e.message : fallback)
    return false
  }
}

/** Mount once near the root. */
export function DialogHost() {
  const [dlg, setDlg] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    askImpl = (o) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve }))
    toastImpl = (t) => {
      setToast(t)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setToast(null), 4000)
    }
    return () => {
      askImpl = null
      toastImpl = null
      window.clearTimeout(timer.current)
    }
  }, [])

  const close = (v: boolean) => {
    dlg?.resolve(v)
    setDlg(null)
  }

  useEffect(() => {
    if (!dlg) return
    // Focus lands on Cancel, so pressing Enter by reflex never confirms a destructive action.
    cancelRef.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        dlg.resolve(false)
        setDlg(null)
      } else if (e.key === 'Tab') {
        // Keep keyboard focus inside the dialog.
        e.preventDefault()
        ;(document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current)?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [dlg])

  return (
    <>
      {dlg && (
        <div className="dialog-backdrop" onClick={() => close(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-msg" onClick={(e) => e.stopPropagation()}>
            <h2 id="dlg-title">{dlg.title ?? '請確認'}</h2>
            <p id="dlg-msg">{dlg.message}</p>
            <div className="dialog-actions">
              <button ref={cancelRef} onClick={() => close(false)}>
                取消
              </button>
              <button ref={confirmRef} className={dlg.danger ? 'danger-solid' : 'primary'} onClick={() => close(true)}>
                {dlg.confirmLabel ?? '確定'}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  )
}

const ArrowLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 12H5" />
    <path d="M11 6l-6 6 6 6" />
  </svg>
)

export function Header({ title, back, right }: { title: string; back?: string; right?: ReactNode }) {
  return (
    <header className="topbar">
      {back && (
        <a href={back} className="iconbtn" aria-label="返回">
          <ArrowLeft />
        </a>
      )}
      <h1>{title}</h1>
      <div className="grow" />
      {right}
    </header>
  )
}

export function UnderlineTabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export const CommentIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 20.5l1.6-5.2A8.5 8.5 0 1 1 21 11.5z" />
  </svg>
)
