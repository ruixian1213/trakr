import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { Limiter } from './auth.ts'
import type { Row } from './db.ts'

const MAX_BODY = 500
/** Distinct reports that hide a post or comment until it is reviewed. */
const HIDE_AT_REPORTS = 3

const reportCount = (type: string, alias: string) =>
  `(SELECT COUNT(*) FROM reports r WHERE r.target_type = '${type}' AND r.target_id = ${alias}.id)`
const POST_OK = `p.deleted_ms IS NULL AND ${reportCount('post', 'p')} < ${HIDE_AT_REPORTS}`
const COMMENT_OK = `c.deleted_ms IS NULL AND ${reportCount('comment', 'c')} < ${HIDE_AT_REPORTS}`

/**
 * A block works both ways: if either side blocked the other, the author's content is hidden from the viewer.
 * `viewerId` is a number from the session, never user text. Anonymous viewers pass -1, which matches nothing.
 */
export const notBlocked = (viewerId: number | undefined, column: string) => {
  const v = Number.isInteger(viewerId) ? viewerId : -1
  return `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${v} AND b.blocked_id = ${column}) OR (b.blocked_id = ${v} AND b.blocker_id = ${column}))`
}

/** Plain text only (React escapes it on output). Returns null when empty or too long. */
function cleanBody(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  return s.length >= 1 && s.length <= MAX_BODY ? s : null
}

interface Deps {
  authUser: (req: FastifyRequest) => Row | null
  now: () => number
}

export function registerForum(app: FastifyInstance, db: DatabaseSync, { authUser, now }: Deps) {
  const postLimiter = new Limiter(10, 10 * 60_000, now)
  const commentLimiter = new Limiter(30, 10 * 60_000, now)
  const reportLimiter = new Limiter(30, 60 * 60_000, now)

  const shapePost = (r: Row, viewerId: number | undefined) => ({
    id: r.id,
    handle: r.handle,
    avatarV: r.avatar_ms ?? null,
    body: r.body,
    createdAt: new Date(r.created_ms).toISOString(),
    commentCount: r.comment_count ?? 0,
    mine: viewerId !== undefined && r.user_id === viewerId,
  })

  const postSql = `
    SELECT p.id, p.user_id, p.body, p.created_ms, u.handle, u.avatar_ms,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND ${COMMENT_OK}) AS comment_count
    FROM posts p JOIN users u ON u.id = p.user_id`

  const getPost = (id: number, viewerId?: number) =>
    db.prepare(`${postSql} WHERE p.id = ? AND ${POST_OK} AND ${notBlocked(viewerId, 'p.user_id')}`).get(id) as Row | undefined

  app.get('/api/posts', async (req) => {
    const q = req.query as Row
    const before = Number(q.before) > 0 ? Number(q.before) : Number.MAX_SAFE_INTEGER
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 20))
    const viewer = authUser(req)
    const rows = db
      .prepare(`${postSql} WHERE p.id < ? AND ${POST_OK} AND ${notBlocked(viewer?.id, 'p.user_id')} ORDER BY p.id DESC LIMIT ?`)
      .all(before, limit) as Row[]
    return { posts: rows.map((r) => shapePost(r, viewer?.id)) }
  })

  app.post('/api/posts', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const body = cleanBody((req.body as Row | null)?.body)
    if (!body) return reply.code(400).send({ error: `post must be 1-${MAX_BODY} characters` })
    if (!postLimiter.allowed(String(u.id))) return reply.code(429).send({ error: 'posting too fast, try again later' })
    postLimiter.record(String(u.id))
    const res = db.prepare('INSERT INTO posts (user_id, body, created_ms) VALUES (?, ?, ?)').run(u.id, body, now())
    return shapePost(getPost(Number(res.lastInsertRowid), u.id)!, u.id)
  })

  app.get('/api/posts/:id', async (req, reply) => {
    const id = Number((req.params as Row).id)
    const viewer = authUser(req)
    const post = getPost(id, viewer?.id)
    if (!post) return reply.code(404).send({ error: 'not found' })
    const comments = db
      .prepare(
        `SELECT c.id, c.user_id, c.body, c.created_ms, u.handle, u.avatar_ms FROM comments c JOIN users u ON u.id = c.user_id
         WHERE c.post_id = ? AND ${COMMENT_OK} AND ${notBlocked(viewer?.id, 'c.user_id')} ORDER BY c.id`,
      )
      .all(id) as Row[]
    return {
      post: shapePost(post, viewer?.id),
      comments: comments.map((c) => ({
        id: c.id,
        handle: c.handle,
        avatarV: c.avatar_ms ?? null,
        body: c.body,
        createdAt: new Date(c.created_ms).toISOString(),
        mine: viewer?.id === c.user_id,
      })),
    }
  })

  app.post('/api/posts/:id/comments', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const id = Number((req.params as Row).id)
    if (!getPost(id, u.id)) return reply.code(404).send({ error: 'not found' })
    const body = cleanBody((req.body as Row | null)?.body)
    if (!body) return reply.code(400).send({ error: `comment must be 1-${MAX_BODY} characters` })
    if (!commentLimiter.allowed(String(u.id))) return reply.code(429).send({ error: 'commenting too fast, try again later' })
    commentLimiter.record(String(u.id))
    const res = db.prepare('INSERT INTO comments (post_id, user_id, body, created_ms) VALUES (?, ?, ?, ?)').run(id, u.id, body, now())
    return { id: Number(res.lastInsertRowid) }
  })

  const removeOwn = (table: 'posts' | 'comments') => async (req: FastifyRequest, reply: any) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const res = db
      .prepare(`UPDATE ${table} SET deleted_ms = ? WHERE id = ? AND user_id = ? AND deleted_ms IS NULL`)
      .run(now(), Number((req.params as Row).id), u.id)
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not found' })
    return { ok: true }
  }
  app.delete('/api/posts/:id', removeOwn('posts'))
  app.delete('/api/comments/:id', removeOwn('comments'))

  app.post('/api/report', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const b = (req.body ?? {}) as Row
    if (b.type !== 'post' && b.type !== 'comment' && b.type !== 'profile') {
      return reply.code(400).send({ error: 'type must be post, comment or profile' })
    }
    let id = Number(b.id)
    let exists: unknown
    if (b.type === 'profile') {
      // Profiles are reported by handle; the API never exposes internal user ids.
      const target = db.prepare('SELECT id FROM users WHERE handle_lc = ?').get(String(b.handle ?? '').toLowerCase()) as Row | undefined
      if (target?.id === u.id) return reply.code(400).send({ error: 'cannot report yourself' })
      id = target ? Number(target.id) : Number.NaN
      exists = target
    } else {
      exists = b.type === 'post' ? getPost(id, u.id) : db.prepare(`SELECT c.id FROM comments c WHERE c.id = ? AND ${COMMENT_OK} AND ${notBlocked(u.id, 'c.user_id')}`).get(id)
    }
    if (!exists) return reply.code(404).send({ error: 'not found' })
    if (!reportLimiter.allowed(String(u.id))) return reply.code(429).send({ error: 'too many reports' })
    reportLimiter.record(String(u.id))
    const reason = typeof b.reason === 'string' ? b.reason.slice(0, 200) : ''
    db.prepare('INSERT OR IGNORE INTO reports (reporter_id, target_type, target_id, reason, created_ms) VALUES (?, ?, ?, ?, ?)').run(
      u.id,
      b.type,
      id,
      reason,
      now(),
    )
    return { ok: true }
  })
}
