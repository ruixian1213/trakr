import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { Limiter } from './auth.ts'
import type { Row } from './db.ts'
import { AVATAR_MAX_BYTES, avatarProblem, inspectImage } from './image.ts'

interface Deps {
  authUser: (req: FastifyRequest) => Row | null
  now: () => number
}

export function registerAvatar(app: FastifyInstance, db: DatabaseSync, { authUser, now }: Deps) {
  const uploadLimiter = new Limiter(10, 60 * 60_000, now)

  // The client resizes to 256px before sending, so a real upload is a few tens of KB. Anything larger
  // is rejected by Fastify with 413 before our handler runs. SVG and other types get 415 (no parser).
  app.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: AVATAR_MAX_BYTES }, (_req, body, done) => done(null, body))

  app.put('/api/me/avatar', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    if (!uploadLimiter.allowed(String(me.id))) return reply.code(429).send({ error: '上傳太頻繁，請稍後再試' })
    const body = req.body
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: '只支援 JPEG 或 PNG 圖片' })
    const problem = avatarProblem(body)
    if (problem) return reply.code(400).send({ error: problem })
    uploadLimiter.record(String(me.id))

    // Trust the signature, not the Content-Type the client sent.
    const mime = inspectImage(body)!.mime
    const v = now()
    db.prepare('INSERT INTO avatars (user_id, mime, data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data').run(me.id, mime, body)
    db.prepare('UPDATE users SET avatar_ms = ? WHERE id = ?').run(v, me.id)
    return { avatarV: v }
  })

  app.delete('/api/me/avatar', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    db.prepare('DELETE FROM avatars WHERE user_id = ?').run(me.id)
    db.prepare('UPDATE users SET avatar_ms = NULL WHERE id = ?').run(me.id)
    return { avatarV: null }
  })

  app.get('/api/users/:handle/avatar', async (req, reply) => {
    const row = db
      .prepare('SELECT a.mime, a.data, u.avatar_ms FROM avatars a JOIN users u ON u.id = a.user_id WHERE u.handle_lc = ?')
      .get(String((req.params as Row).handle).toLowerCase()) as Row | undefined
    if (!row) return reply.code(404).send({ error: 'not found' })
    const asked = Number((req.query as Row).v)
    // A URL carrying the current version never changes content, so it can be cached for good.
    const cache = asked === row.avatar_ms ? 'public, max-age=31536000, immutable' : 'public, max-age=300'
    return reply
      .header('Cache-Control', cache)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'same-site')
      .type(row.mime as string)
      .send(Buffer.from(row.data as Uint8Array))
  })
}
