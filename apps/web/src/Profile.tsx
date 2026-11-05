import { useRef, useState } from 'react'
import { ApiError, api, uploadAvatar, type Me, type ProfileLink } from './api.ts'
import { toSquareJpeg } from './photo.ts'
import { Avatar, LevelMark, attempt, confirmAction, showToast } from './ui.tsx'

const MAX_BIO = 160
const MAX_LINKS = 6

// Must match the platforms the server accepts. The server is the real gatekeeper; this only drives the form.
const PLATFORMS = [
  { id: 'threads', label: 'Threads', hint: '帳號，例如 mychannel' },
  { id: 'instagram', label: 'Instagram', hint: '帳號，例如 mychannel' },
  { id: 'x', label: 'X', hint: '帳號，例如 mychannel' },
  { id: 'facebook', label: 'Facebook', hint: '使用者名稱，至少 5 個字元' },
  { id: 'youtube', label: 'YouTube', hint: '頻道 @ 名稱' },
  { id: 'tiktok', label: 'TikTok', hint: '帳號，例如 mychannel' },
  { id: 'telegram', label: 'Telegram', hint: '使用者名稱，至少 5 個字元' },
  { id: 'line', label: 'LINE', hint: 'LINE ID（加好友用）' },
]

const shown = (l: ProfileLink) => (l.platform === 'line' || l.platform === 'facebook' ? l.handle : `@${l.handle}`)

/**
 * Bio and links on a profile. The bio is rendered as plain text (never auto-linked) and each link is
 * an address the server built from a fixed template, so none of this can point somewhere unexpected.
 */
export function ProfileBio({ bio, links }: { bio?: string; links?: ProfileLink[] }) {
  if (!bio && !links?.length) return null
  return (
    <>
      {bio && <div className="post-text" style={{ marginTop: 12 }}>{bio}</div>}
      {links && links.length > 0 && (
        <div className="social-links">
          {links.map((l) => (
            <a key={l.platform} className="social-chip" href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc" aria-label={`${l.label} ${shown(l)}（在新分頁開啟）`}>
              <strong>{l.label}</strong>
              <span className="muted">{shown(l)}</span>
            </a>
          ))}
        </div>
      )}
    </>
  )
}

export function ReportProfile({ handle }: { handle: string }) {
  const [done, setDone] = useState(false)
  if (done) return <span className="muted small">已檢舉，感謝回報</span>
  return (
    <button
      className="linkbtn"
      onClick={async () => {
        const ok = await confirmAction({ title: '檢舉簡介', message: '檢舉這個人的簡介或連結（垃圾訊息、詐騙、冒充等）？', confirmLabel: '檢舉', danger: true })
        if (!ok) return
        try {
          await api('/report', { method: 'POST', body: { type: 'profile', handle } })
          setDone(true)
          showToast('已檢舉，感謝回報')
        } catch (e) {
          showToast(e instanceof ApiError && e.status === 401 ? '請先登入才能檢舉' : (e as Error).message)
        }
      }}
    >
      檢舉簡介
    </button>
  )
}

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
)

/** The account header. Tapping the photo opens the picker, so there is no separate "change photo" button. */
export function ProfileHeader({ m, level, onChanged }: { m: Me; level: number; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setErr(null)
    setBusy(true)
    try {
      await uploadAvatar(await toSquareJpeg(file))
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = '' // lets the same file be chosen again
    }
  }
  const remove = async () => {
    const ok = await confirmAction({ title: '移除大頭貼', message: '移除後會恢復成預設頭像。', confirmLabel: '移除', danger: true })
    if (!ok) return
    if (await attempt(() => api('/me/avatar', { method: 'DELETE' }))) {
      showToast('已移除大頭貼')
      onChanged()
    }
  }

  return (
    <div className="profile">
      <div className="row">
        <button type="button" className="avatar-pick" disabled={busy} onClick={() => input.current?.click()} aria-label={m.avatarV ? '更換大頭貼' : '上傳大頭貼'}>
          <Avatar handle={m.handle} size={64} v={m.avatarV} />
          <span className="avatar-badge" aria-hidden="true">
            <CameraIcon />
          </span>
          {busy && <span className="avatar-busy" aria-live="polite">上傳中</span>}
        </button>
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <div className="grow">
          <div className="row" style={{ gap: 6 }}>
            <span className="big-name">{m.handle}</span>
            <LevelMark level={level} />
          </div>
          <div className="muted small">@{m.handle} · {m.email}</div>
        </div>
      </div>
      {err && <div className="small up" style={{ marginTop: 8 }}>{err}</div>}
      <div className="muted small" style={{ marginTop: 10 }}>
        你的帳號 ID 是 @{m.handle}，是你在平台上的唯一識別（不分大小寫），註冊後無法更改。
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>
        點大頭貼即可{m.avatarV ? '更換' : '上傳'}照片。照片會在你的手機上裁成正方形並縮小，位置等拍攝資訊不會上傳。請不要使用他人的照片。
        {m.avatarV && (
          <>
            {' '}
            <button className="linkbtn" disabled={busy} onClick={remove} style={{ display: 'inline', minHeight: 0, padding: 0, margin: 0, textDecoration: 'underline' }}>
              移除照片
            </button>
          </>
        )}
      </div>
    </div>
  )
}

interface LinkRow {
  platform: string
  handle: string
}

export function ProfileEditor({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [bio, setBio] = useState(me.bio ?? '')
  const [rows, setRows] = useState<LinkRow[]>((me.links ?? []).map((l) => ({ platform: l.platform, handle: l.handle })))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const used = new Set(rows.map((r) => r.platform))
  const free = PLATFORMS.find((p) => !used.has(p.id))

  const update = (i: number, patch: Partial<LinkRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const saved = await api<Me>('/me/profile', {
        method: 'PUT',
        body: { bio, links: rows.filter((r) => r.handle.trim() !== '').map((r) => ({ platform: r.platform, handle: r.handle.trim() })) },
      })
      // Show what the server actually stored (it cleans up pasted URLs down to the account name).
      setBio(saved.bio ?? '')
      setRows((saved.links ?? []).map((l) => ({ platform: l.platform, handle: l.handle })))
      setMsg({ ok: true, text: '已儲存' })
      onSaved()
    } catch (e2) {
      setMsg({ ok: false, text: (e2 as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="pad" onSubmit={save} style={{ paddingTop: 0 }}>
      {me.profileHidden && <div className="notice warn" style={{ margin: '0 0 12px' }}>你的簡介與連結因為多人檢舉，目前對其他人隱藏。請檢視並修改內容。</div>}
      <div className="field">
        <label htmlFor="bio">自我介紹</label>
        <textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={4} placeholder="介紹一下你的交易風格…（最多 4 行）" style={{ resize: 'none' }} />
        <div className="muted small num" style={{ textAlign: 'right' }}>
          {Array.from(bio).length}/{MAX_BIO}
        </div>
      </div>

      <div className="field" style={{ marginBottom: 8 }}>
        <label>社群連結</label>
        {rows.map((r, i) => {
          const spec = PLATFORMS.find((p) => p.id === r.platform)
          return (
            <div key={r.platform} className="row link-row">
              <select value={r.platform} aria-label="平台" onChange={(e) => update(i, { platform: e.target.value })}>
                {PLATFORMS.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.id !== r.platform && used.has(p.id)}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input value={r.handle} aria-label={`${spec?.label ?? ''} 帳號`} placeholder={spec?.hint} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => update(i, { handle: e.target.value })} />
              <button type="button" className="linkbtn" aria-label="移除這個連結" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                移除
              </button>
            </div>
          )
        })}
        {rows.length < MAX_LINKS && free && (
          <button type="button" onClick={() => setRows([...rows, { platform: free.id, handle: '' }])}>
            ＋ 新增連結
          </button>
        )}
        <div className="muted small" style={{ marginTop: 8 }}>
          只需填帳號（也可貼上個人頁網址），系統會自動產生連結。基於安全考量，不開放自訂網址與群組邀請連結。
        </div>
      </div>

      <button className="primary" type="submit" disabled={busy}>
        {busy ? '儲存中…' : '儲存'}
      </button>
      {msg && <span className={`small ${msg.ok ? 'down' : 'up'}`} style={{ marginLeft: 12 }}>{msg.text}</span>}
    </form>
  )
}
