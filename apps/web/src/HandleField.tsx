import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'

export type HandleStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok' }
  | { state: 'bad'; message: string }
  /** The check itself could not run (offline, rate limited). Do not block signing up; the server decides. */
  | { state: 'unknown' }

const FORMAT = /^[A-Za-z0-9_]{3,20}$/

/** Sign-up field for the unique account ID. Tells the person at once whether it is free. */
export function HandleField({ value, onChange, onStatus }: { value: string; onChange: (v: string) => void; onStatus: (s: HandleStatus) => void }) {
  const [status, setStatus] = useState<HandleStatus>({ state: 'idle' })
  const latest = useRef(0)

  useEffect(() => {
    const set = (s: HandleStatus) => {
      setStatus(s)
      onStatus(s)
    }
    const handle = value.trim()
    latest.current++
    const ticket = latest.current
    if (handle === '') return set({ state: 'idle' })
    // Obvious format mistakes need no round trip; the server stays the authority on everything else.
    if (!FORMAT.test(handle)) return set({ state: 'bad', message: '需為 3 到 20 個英文字母、數字或底線' })

    set({ state: 'checking' })
    const id = setTimeout(() => {
      api<{ available: boolean; message?: string }>(`/auth/handle-available?handle=${encodeURIComponent(handle)}`).then(
        (r) => {
          if (ticket !== latest.current) return // the person kept typing; this answer is about an older value
          set(r.available ? { state: 'ok' } : { state: 'bad', message: r.message ?? '這個帳號 ID 無法使用' })
        },
        () => ticket === latest.current && set({ state: 'unknown' }),
      )
    }, 400)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <div className="field">
      <label htmlFor="handle">帳號 ID（公開、唯一、不分大小寫）</label>
      <div className="id-field">
        <span className="at" aria-hidden="true">
          @
        </span>
        <input
          id="handle"
          name="handle"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          maxLength={20}
          aria-describedby="handle-help"
          aria-invalid={status.state === 'bad'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <div id="handle-help" className="small" role="status" aria-live="polite" style={{ marginTop: 4, minHeight: '1.4em' }}>
        {status.state === 'checking' && <span className="muted">檢查中…</span>}
        {status.state === 'ok' && <span className="down">✓ 可以使用</span>}
        {status.state === 'bad' && <span className="up">✗ {status.message}</span>}
        {(status.state === 'idle' || status.state === 'unknown') && <span className="muted">3 到 20 個英文字母、數字或底線。註冊後無法更改。</span>}
      </div>
    </div>
  )
}
