import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'
import { MarketUnavailable, SOURCE, TPEX_SOURCE, type Market } from './market.ts'
import { TDCC_SOURCE, holderHistory } from './holders.ts'

const MAX_WATCHLIST = 50
const CODE_RE = /^[0-9A-Za-z]{2,8}$/

interface Deps {
  authUser: (req: FastifyRequest) => Row | null
  now: () => number
  market: Market
  /** Brings the TDCC archive up to date if it is due. Never throws. */
  syncHolders: () => Promise<void>
}

export function registerMarketRoutes(app: FastifyInstance, db: DatabaseSync, { authUser, now, market, syncHolders }: Deps) {
  // Market data is the same for everyone, so a minute of shared caching is safe and spares the server.
  const publicCache = (reply: FastifyReply) => reply.header('Cache-Control', 'public, max-age=60')

  /** Turns an upstream failure into a clean 503 instead of a stack trace. */
  async function guarded<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof MarketUnavailable) {
        reply.code(503).send({ error: 'market data temporarily unavailable' })
        return undefined
      }
      throw e
    }
  }

  app.get('/api/market/overview', async (_req, reply) => {
    const r = await guarded(reply, () => market.overview())
    if (!r) return
    publicCache(reply)
    return { source: SOURCE, asOf: r.asOf, stale: r.stale, ...r.overview }
  })

  app.get('/api/market/top-volume', async (_req, reply) => {
    const r = await guarded(reply, () => market.topVolume())
    if (!r) return
    publicCache(reply)
    return { source: SOURCE, asOf: r.asOf, stale: r.stale, rows: r.rows }
  })

  app.get('/api/market/top-value', async (_req, reply) => {
    const r = await guarded(reply, () => market.topValue())
    if (!r) return
    publicCache(reply)
    return { source: SOURCE, asOf: r.asOf, stale: r.stale, rows: r.rows }
  })

  app.get('/api/market/search', async (req, reply) => {
    const q = String((req.query as Row).q ?? '').slice(0, 30)
    const results = await guarded(reply, () => market.search(q))
    if (!results) return
    return { results }
  })

  app.get('/api/market/stocks/:code', async (req, reply) => {
    const code = String((req.params as Row).code)
    if (!CODE_RE.test(code)) return reply.code(400).send({ error: 'invalid code' })
    const r = await guarded(reply, () => market.quote(code))
    if (!r) return
    if (!r.quote) return reply.code(404).send({ error: 'not found' })
    const me = authUser(req)
    const watching = me ? !!db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND code = ?').get(me.id, code) : false
    return { source: SOURCE, asOf: r.asOf, stale: r.stale, quote: r.quote, watching }
  })

  /**
   * What sits behind a stock's price: big-holder history (TDCC weekly), margin balances (TWSE daily) and
   * upcoming ex-dividend or ex-right dates (TWSE). Each part can fail on its own, so it reports null
   * instead of failing the whole page.
   */
  app.get('/api/market/stocks/:code/details', async (req, reply) => {
    const code = String((req.params as Row).code)
    if (!CODE_RE.test(code)) return reply.code(400).send({ error: 'invalid code' })
    await syncHolders()
    const [margin, ex] = await Promise.allSettled([market.margin(code), market.exDividend(code)])
    const h = holderHistory(db, code)
    publicCache(reply)
    return {
      holders: h.current ? { source: TDCC_SOURCE, ...h } : null,
      margin:
        margin.status === 'fulfilled'
          ? { source: SOURCE, stale: margin.value.stale, row: margin.value.row }
          : null,
      exDividend: ex.status === 'fulfilled' ? { source: SOURCE, stale: ex.value.stale, rows: ex.value.rows } : null,
      otcSource: TPEX_SOURCE,
    }
  })

  // ---------- watchlist (自選股) ----------

  app.get('/api/me/watchlist', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const codes = (db.prepare('SELECT code FROM watchlist WHERE user_id = ? ORDER BY added_ms DESC, rowid DESC').all(me.id) as Row[]).map((r) => r.code as string)
    if (codes.length === 0) return { source: SOURCE, asOf: null, stale: false, unavailable: false, items: [] }
    try {
      const { asOf, stale, quotes } = await market.quotes(codes)
      return { source: SOURCE, asOf, stale, unavailable: false, items: codes.map((code, i) => ({ code, quote: quotes[i] })) }
    } catch (e) {
      if (!(e instanceof MarketUnavailable)) throw e
      // The list is the user's own data; show it even when prices cannot be fetched.
      return { source: SOURCE, asOf: null, stale: false, unavailable: true, items: codes.map((code) => ({ code, quote: null })) }
    }
  })

  app.put('/api/me/watchlist/:code', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const code = String((req.params as Row).code)
    if (!CODE_RE.test(code)) return reply.code(400).send({ error: 'invalid code' })
    const r = await guarded(reply, () => market.quote(code))
    if (!r) return
    if (!r.quote) return reply.code(404).send({ error: 'unknown stock code' })
    const count = (db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?').get(me.id) as Row).n as number
    const exists = db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND code = ?').get(me.id, code)
    if (!exists && count >= MAX_WATCHLIST) return reply.code(400).send({ error: `watchlist is limited to ${MAX_WATCHLIST} stocks` })
    db.prepare('INSERT OR IGNORE INTO watchlist (user_id, code, added_ms) VALUES (?, ?, ?)').run(me.id, code, now())
    return { watching: true }
  })

  app.delete('/api/me/watchlist/:code', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    db.prepare('DELETE FROM watchlist WHERE user_id = ? AND code = ?').run(me.id, String((req.params as Row).code))
    return { watching: false }
  })
}
