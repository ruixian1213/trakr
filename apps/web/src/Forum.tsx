import { useState } from 'react'
import { ApiError, api, fetchMe, type Post, type PostComment } from './api.ts'
import { fmtTime, useLive } from './lib.tsx'
import { Avatar, CommentIcon, Header, attempt, confirmAction, showToast } from './ui.tsx'

const MAX_BODY = 500

function Composer({ handle, avatarV, placeholder, submitLabel, onSubmit }: { handle: string; avatarV?: number | null; placeholder: string; submitLabel: string; onSubmit: (body: string) => Promise<void> }) {
  const [body, setBody] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await onSubmit(body.trim())
      setBody('')
    } catch (e2) {
      setErr((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="item" onSubmit={submit}>
      <Avatar handle={handle} v={avatarV} />
      <div className="body">
        <textarea className="bare" value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder} maxLength={MAX_BODY} rows={3} />
        {err && <div className="small up">{err}</div>}
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="muted small num">
            {body.length}/{MAX_BODY}
          </span>
          <button className="primary" type="submit" disabled={busy || body.trim().length === 0}>
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  )
}

const SignInPrompt = () => (
  <div className="notice">
    <a href="#/me">登入</a>後即可發文與留言。
  </div>
)

const Disclaimer = () => <div className="sub" style={{ paddingTop: 8 }}>討論內容僅為個人意見，不構成投資建議，請自行判斷風險。</div>

/** Report or delete, depending on who is looking. Enough reports hide an item until it is reviewed. */
function ItemActions({ type, id, mine, onChanged }: { type: 'post' | 'comment'; id: number; mine: boolean; onChanged: () => void }) {
  const [reported, setReported] = useState(false)
  const [busy, setBusy] = useState(false)

  if (mine) {
    return (
      <button
        className="linkbtn"
        disabled={busy}
        onClick={async () => {
          const ok = await confirmAction({
            title: type === 'post' ? '刪除貼文' : '刪除留言',
            message: '確定要刪除嗎？刪除後無法復原。',
            confirmLabel: '刪除',
            danger: true,
          })
          if (!ok) return
          setBusy(true)
          const done = await attempt(() => api(type === 'post' ? `/posts/${id}` : `/comments/${id}`, { method: 'DELETE' }))
          setBusy(false)
          if (done) {
            showToast(type === 'post' ? '貼文已刪除' : '留言已刪除')
            onChanged()
          }
        }}
      >
        刪除
      </button>
    )
  }
  if (reported) return <span className="muted small">已檢舉</span>
  return (
    <button
      className="linkbtn"
      disabled={busy}
      onClick={async () => {
        const ok = await confirmAction({ title: '檢舉', message: '檢舉這則內容（垃圾訊息、詐騙、辱罵等）？', confirmLabel: '檢舉', danger: true })
        if (!ok) return
        setBusy(true)
        try {
          await api('/report', { method: 'POST', body: { type, id } })
          setReported(true)
          showToast('已檢舉，感謝回報')
        } catch (e) {
          showToast(e instanceof ApiError && e.status === 401 ? '請先登入才能檢舉' : (e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      檢舉
    </button>
  )
}

export function Global() {
  const me = useLive(fetchMe, [], 60_000)
  const posts = useLive(() => api<{ posts: Post[] }>('/posts?limit=30'), [], 15_000)

  return (
    <>
      <Header title="社群" />
      {me.data ? (
        <Composer
          handle={me.data.handle}
          avatarV={me.data.avatarV}
          placeholder="分享你的看法…"
          submitLabel="發佈"
          onSubmit={async (body) => {
            await api('/posts', { method: 'POST', body: { body } })
            posts.reload()
          }}
        />
      ) : (
        me.loaded && <SignInPrompt />
      )}
      <Disclaimer />
      {posts.error && <div className="notice warn">{posts.error}</div>}
      {posts.data?.posts.length === 0 && <div className="empty">還沒有討論，來發第一篇吧。</div>}
      {posts.data?.posts.map((p) => (
        <article key={p.id} className="item">
          <a href={`#/t/${p.handle}`}>
            <Avatar handle={p.handle} v={p.avatarV} />
          </a>
          <div className="body">
            <div className="head">
              <a href={`#/t/${p.handle}`}>
                <strong>{p.handle}</strong>
              </a>
              <span className="muted small">· {fmtTime(p.createdAt)}</span>
            </div>
            <a href={`#/g/${p.id}`} className="post-text">
              {p.body}
            </a>
            <div className="actions">
              <a href={`#/g/${p.id}`} className="stat">
                <CommentIcon />
                {p.commentCount > 0 && p.commentCount}
              </a>
              <ItemActions type="post" id={p.id} mine={p.mine} onChanged={posts.reload} />
            </div>
          </div>
        </article>
      ))}
    </>
  )
}

export function PostDetail({ id }: { id: string }) {
  const me = useLive(fetchMe, [], 60_000)
  const detail = useLive(() => api<{ post: Post; comments: PostComment[] }>(`/posts/${id}`), [id], 15_000)

  if (detail.error) {
    return (
      <>
        <Header title="貼文" back="#/global" />
        <div className="empty">{detail.error === 'not found' ? '貼文不存在或已被移除' : detail.error}</div>
      </>
    )
  }
  const d = detail.data
  if (!d) return <Header title="貼文" back="#/global" />

  return (
    <>
      <Header title="貼文" back="#/global" />
      <article className="pad" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="row">
          <a href={`#/t/${d.post.handle}`}>
            <Avatar handle={d.post.handle} v={d.post.avatarV} />
          </a>
          <a href={`#/t/${d.post.handle}`} className="grow">
            <strong>{d.post.handle}</strong>
          </a>
        </div>
        <div className="post-text lead" style={{ marginTop: 10 }}>
          {d.post.body}
        </div>
        <div className="actions">
          <span className="muted small">{fmtTime(d.post.createdAt)}</span>
          <ItemActions
            type="post"
            id={d.post.id}
            mine={d.post.mine}
            onChanged={() => {
              location.hash = '#/global'
            }}
          />
        </div>
      </article>

      {me.data ? (
        <Composer
          handle={me.data.handle}
          avatarV={me.data.avatarV}
          placeholder="寫下你的留言…"
          submitLabel="留言"
          onSubmit={async (body) => {
            await api(`/posts/${id}/comments`, { method: 'POST', body: { body } })
            detail.reload()
          }}
        />
      ) : (
        me.loaded && <SignInPrompt />
      )}

      {d.comments.map((c) => (
        <div key={c.id} className="item">
          <a href={`#/t/${c.handle}`}>
            <Avatar handle={c.handle} v={c.avatarV} />
          </a>
          <div className="body">
            <div className="head">
              <a href={`#/t/${c.handle}`}>
                <strong>{c.handle}</strong>
              </a>
              <span className="muted small">· {fmtTime(c.createdAt)}</span>
            </div>
            <div className="post-text">{c.body}</div>
            <div className="actions">
              <span />
              <ItemActions type="comment" id={c.id} mine={c.mine} onChanged={detail.reload} />
            </div>
          </div>
        </div>
      ))}
      {d.comments.length === 0 && <div className="empty">還沒有留言</div>}
    </>
  )
}
