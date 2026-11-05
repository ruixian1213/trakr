import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  GENESIS_HASH,
  clampDelay,
  inferFlow,
  isVisible,
  marketValue,
  overlapsMarketHours,
  ratioHoldings,
  SOCIAL,
  isSocialPlatform,
  normalizeSocial,
  applyTrades,
  compareLines,
  parseHoldingsCsv,
  parseTaipeiTime,
  parseTradesCsv,
  reconcile,
  socialUrl,
  type LineMismatch,
  tradeHash,
  tradeStats,
  twr,
  verifyChain,
  DEFAULT_DELAY_SEC,
  type HoldingsVisibility,
  type Position,
  type DividendEvent,
  adjustedFlows,
  HANDLE_MESSAGES,
  handleKey,
  handleProblem,
  type SocialPlatform,
  type Snapshot,
  type Trade,
} from '@tot/core'
import type { Row } from './db.ts'
import { registerAvatar } from './avatar.ts'
import { notBlocked, registerForum } from './forum.ts'
import { createMarket, twseFetcher, type Fetcher } from './market.ts'
import { TDCC_URL, archiveHolders } from './holders.ts'
import { registerMarketRoutes } from './market-routes.ts'
import { DUMMY_HASH, Limiter, PASSWORD_MAX, PASSWORD_MIN, hashPassword, parseCookies, verifyPassword } from './auth.ts'
import { digestMessage, unsubscribeToken, unsubscribeTokenValid, type DigestTrade, type Mailer } from "./digest.ts"

export interface AppOptions {
  /** Mark the session cookie Secure. Turn on whenever the site is served over HTTPS. */
  secureCookies?: boolean
  /** Behind a reverse proxy: trust X-Forwarded-For/Host so client IPs (rate limits) and the origin check are right. */
  trustProxy?: boolean
  /** Source of TWSE data. Tests pass fixtures so nothing touches the network. */
  marketFetcher?: Fetcher
  /** Source of the TDCC weekly holder feed (CSV text). Tests pass a fixture. */
  holderFetcher?: () => Promise<string>
  /** Refresh the TDCC and dividend archives on a timer, not only on page views. Turn on in production. */
  autoSync?: boolean
  now?: () => number
  /** Leaderboard entry requirements. */
  minClosedTrades?: number
  minSnapshots?: number
  /** A market-hours silence longer than this is recorded as a gap. */
  gapThresholdMs?: number
  /** A gap newer than this keeps the trader off the leaderboard. */
  gapPenaltyMs?: number
  /** Public base URL for share links, sitemap and unsubscribe links. Defaults to the request host. */
  publicUrl?: string
  /** Email digest. Off unless both a secret and a mailer are given. */
  digest?: { secret: string; mailer: Mailer }
}

const VISIBILITIES: HoldingsVisibility[] = ['public', 'ratio', 'hidden']
const DAY = 86_400_000
const SESSION_COOKIE = 'tot_session'
const SESSION_TTL_MS = 30 * DAY
const MAX_AGENT_KEYS = 5
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function parseIso(s: unknown): number | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(s)) return null
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms
}

const isPos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

export function buildApp(db: DatabaseSync, opts: AppOptions = {}) {
  const now = opts.now ?? Date.now
  const minClosed = opts.minClosedTrades ?? 5
  const minSnaps = opts.minSnapshots ?? 3
  const gapThreshold = opts.gapThresholdMs ?? 30 * 60_000
  const gapPenalty = opts.gapPenaltyMs ?? 14 * DAY

  const app = Fastify({ trustProxy: opts.trustProxy ?? false })
  const market = createMarket(opts.marketFetcher ?? twseFetcher(), { now })

  // The TDCC feed is weekly, so checking twice a day is plenty. A failed check is retried on the next request.
  const HOLDER_CHECK_MS = 12 * 3_600_000
  let lastHolderCheck = 0
  const fetchHolderText =
    opts.holderFetcher ??
    (async () => {
      const res = await fetch(TDCC_URL, { headers: { 'user-agent': 'tot/0.1 (market data cache)' }, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`TDCC: HTTP ${res.status}`)
      return res.text()
    })
  async function syncHolders() {
    if (now() - lastHolderCheck < HOLDER_CHECK_MS) return
    lastHolderCheck = now()
    try {
      await archiveHolders(db, fetchHolderText)
    } catch (e) {
      lastHolderCheck = 0
      app.log.warn({ err: (e as Error).message }, 'TDCC holder archive failed')
    }
  }

  /** Adds the stock's name to rows that only carry a code. A missing name is null, never an error. */
  async function named<T extends { symbol: string }>(items: T[]): Promise<(T & { name: string | null })[]> {
    const names = await market.names(items.map((i) => i.symbol))
    return items.map((i) => ({ ...i, name: names.get(i.symbol) ?? null }))
  }

  const userByHandleStmt = db.prepare('SELECT * FROM users WHERE handle_lc = ?')
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    // IDs are compared without regard to case: the key is the lower-cased ID.
    userByHandle: { get: (handle: unknown) => userByHandleStmt.get(handleKey(String(handle ?? ''))) },
    // Broker-verified trades only: these drive stats, the hash chain and reconciliation.
    tradesOf: db.prepare("SELECT * FROM trades WHERE user_id = ? AND source = 'api' ORDER BY id"),
    // Everything we may display, including unverified CSV rows.
    allTradesOf: db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY executed_ms, id'),
    snapsOf: db.prepare('SELECT * FROM snapshots WHERE user_id = ? ORDER BY taken_ms'),
  }

  const loginByIdentity = new Limiter(5, 15 * 60_000, now) // ip + email
  const loginByIp = new Limiter(40, 15 * 60_000, now)
  const registerByIp = new Limiter(10, 60 * 60_000, now)
  const handleCheckByIp = new Limiter(60, 60_000, now)

  // Cookies are SameSite=Lax; this also rejects cross-origin writes that carry an Origin header.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const origin = req.headers.origin
    if (!origin) return
    let host = ''
    try {
      host = new URL(origin).host
    } catch {
      /* falls through to the rejection below */
    }
    if (host !== req.host) return reply.code(403).send({ error: 'cross-origin request blocked' })
  })

  // Responses can hold personal data: never let a browser or shared proxy cache them.
  app.addHook('onSend', async (_req, reply, payload) => {
    // Routes serving shared public data (market quotes) set their own caching first.
    if (!reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    return payload
  })

  /** Browser session from the cookie. Agent keys never authenticate here. */
  function authSession(req: FastifyRequest): { user: Row; idHash: string } | null {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!sid) return null
    const idHash = sha(sid)
    const s = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as Row | undefined
    if (!s) return null
    if (s.expires_ms <= now()) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash)
      return null
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) as Row | undefined
    return user ? { user, idHash } : null
  }

  const authUser = (req: FastifyRequest): Row | null => authSession(req)?.user ?? null

  /** Agent key from the Authorization header. Only the ingest route accepts it. */
  function agentUser(req: FastifyRequest): Row | null {
    const h = req.headers.authorization
    if (!h?.startsWith('Bearer ')) return null
    const keyHash = sha(h.slice(7))
    const k = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_ms IS NULL').get(keyHash) as Row | undefined
    if (!k) return null
    db.prepare('UPDATE api_keys SET last_used_ms = ? WHERE id = ?').run(now(), k.id)
    return (db.prepare('SELECT * FROM users WHERE id = ?').get(k.user_id) as Row | undefined) ?? null
  }

  function startSession(reply: FastifyReply, userId: number) {
    const sid = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO sessions (id_hash, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)').run(
      sha(sid),
      userId,
      now(),
      now() + SESSION_TTL_MS,
    )
    reply.header('set-cookie', cookie(sid, SESSION_TTL_MS / 1000))
  }

  function cookie(value: string, maxAgeSec: number) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${opts.secureCookies ? '; Secure' : ''}`
  }

  const MAX_BIO = 160
  const MAX_BIO_LINES = 4
  const MAX_LINKS = 6
  /** Distinct reports that hide a person's bio and links (not the account) until reviewed. */
  const PROFILE_HIDE_AT = 3
  const profileLimiter = new Limiter(30, 60 * 60_000, now)

  const linksOf = (userId: number) =>
    (db.prepare('SELECT platform, handle FROM social_links WHERE user_id = ? ORDER BY rowid').all(userId) as Row[])
      .filter((r) => isSocialPlatform(r.platform))
      .map((r) => ({
        platform: r.platform as SocialPlatform,
        label: SOCIAL[r.platform as SocialPlatform].label,
        handle: r.handle as string,
        url: socialUrl(r.platform as SocialPlatform, r.handle),
      }))

  const profileHidden = (userId: number) =>
    ((db.prepare("SELECT COUNT(*) AS n FROM reports WHERE target_type = 'profile' AND target_id = ?").get(userId) as Row).n as number) >= PROFILE_HIDE_AT

  const meBody = (u: Row) => ({
    handle: u.handle,
    avatarV: u.avatar_ms ?? null,
    bio: u.bio ?? '',
    links: linksOf(u.id),
    profileHidden: profileHidden(u.id),
    email: u.email,
    delaySec: u.delay_sec,
    holdingsVisibility: u.holdings_visibility,
    emailDigest: !!u.email_digest,
    linked: !!db.prepare('SELECT 1 FROM accounts WHERE user_id = ?').get(u.id),
    lastSyncAt: u.last_sync_ms ? new Date(u.last_sync_ms).toISOString() : null,
  })

  const toTrade = (r: Row): Trade => ({
    brokerTradeId: r.broker_trade_id,
    symbol: r.symbol,
    side: r.side,
    qty: r.qty,
    price: r.price,
    executedAt: r.executed_at,
    fee: r.fee,
  })

  const toSnapshot = (r: Row): Snapshot => ({
    takenAt: r.taken_at,
    cash: r.cash,
    equity: r.equity,
    flow: r.flow,
    positions: JSON.parse(r.positions),
  })

  /** Archived cash dividends, as the dividend module expects them. */
  function dividendEvents(): DividendEvent[] {
    return (db.prepare('SELECT symbol, ex_date, cash_per_share FROM dividend_events').all() as Row[]).map((r) => ({
      symbol: r.symbol as string,
      // The ex-moment is the start of the trading day in Taipei (09:00 UTC+8 = 01:00Z).
      exMs: Date.parse(`${r.ex_date as string}T01:00:00.000Z`),
      cashPerShare: r.cash_per_share as number,
    }))
  }

  // The announcement list changes daily, so it is refreshed on the same schedule as the holder feed.
  const DIVIDEND_CHECK_MS = 12 * 3_600_000
  let lastDividendCheck = 0
  async function syncDividends() {
    if (now() - lastDividendCheck < DIVIDEND_CHECK_MS) return
    lastDividendCheck = now()
    try {
      const { rows } = await market.dividendEvents()
      const cashUpsert = db.prepare('INSERT OR REPLACE INTO dividend_events (symbol, ex_date, cash_per_share) VALUES (?, ?, ?)')
      const stockUpsert = db.prepare('INSERT OR REPLACE INTO stock_dividend_events (symbol, ex_date, ratio) VALUES (?, ?, ?)')
      db.exec('BEGIN')
      try {
        for (const r of rows) {
          if (!r.date) continue
          if (r.cashDividend !== null && r.cashDividend > 0) cashUpsert.run(r.code, r.date, r.cashDividend)
          // Stock dividends are only recorded. Their unit is unverified, so a trader holding one is held off the leaderboard.
          if (r.stockDividendRatio !== null && r.stockDividendRatio > 0) stockUpsert.run(r.code, r.date, r.stockDividendRatio)
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    } catch (e) {
      lastDividendCheck = 0
      app.log.warn({ err: (e as Error).message }, 'dividend archive failed')
    }
  }

  function traderSummary(user: Row) {
    const trades = (q.tradesOf.all(user.id) as Row[]).map(toTrade)
    const snaps = (q.snapsOf.all(user.id) as Row[])
    // Cash dividends are income, not deposits. Flows are recomputed with the announced dividends taken out.
    const flows = adjustedFlows(
      snaps.map((s) => ({ takenMs: s.taken_ms as number, cash: s.cash as number, equity: s.equity as number, positions: JSON.parse(s.positions) })),
      trades,
      dividendEvents(),
    )
    const perf = twr(snaps.map((s, i) => ({ ...toSnapshot(s), flow: flows[i]! })))
    const ts = tradeStats(trades)
    const lastSnap = snaps[snaps.length - 1]
    const recentGap = db
      .prepare('SELECT COUNT(*) AS n FROM gaps WHERE user_id = ? AND to_ms >= ?')
      .get(user.id, now() - gapPenalty) as Row
    const hasAccount = !!db.prepare('SELECT 1 FROM accounts WHERE user_id = ?').get(user.id)
    const csvTrades = (db.prepare("SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND source = 'csv'").get(user.id) as Row).n as number
    // 2 = Broker Verified (API), 1 = User Submitted (CSV only), 0 = nothing shared yet.
    const level = hasAccount ? 2 : csvTrades > 0 ? 1 : 0
    const reconcileOk = lastSnap ? lastSnap.reconciled === 1 : false
    const reasons: string[] = []
    if (!hasAccount) reasons.push('no_account')
    if (ts.closedTrades < minClosed) reasons.push('too_few_closed_trades')
    if (snaps.length < minSnaps) reasons.push('too_few_snapshots')
    if (recentGap.n > 0) reasons.push('recent_unverified_gap')
    if (!reconcileOk) reasons.push('holdings_mismatch')
    // A stock dividend adds shares without a trade, so the holdings would not reconcile. Until its unit is
    // verified we say so, rather than let it show up as a mismatch that looks like misreporting.
    const heldEver = new Set<string>()
    for (const s of snaps) for (const p of JSON.parse(s.positions as string) as Position[]) heldEver.add(p.symbol)
    const firstMs = snaps.length ? (snaps[0]!.taken_ms as number) : Infinity
    const stockDivs = (db.prepare('SELECT symbol, ex_date FROM stock_dividend_events').all() as Row[]).filter((r) => {
      const ex = Date.parse(`${r.ex_date as string}T01:00:00.000Z`)
      return heldEver.has(r.symbol as string) && ex >= firstMs && ex <= now()
    })
    if (stockDivs.length > 0) reasons.push('stock_dividend_unverified')
    const syncAgeMs = user.last_sync_ms ? now() - user.last_sync_ms : null
    return {
      handle: user.handle,
      avatarV: user.avatar_ms ?? null,
      // Other people see nothing of a bio or links that enough users have reported.
      ...(profileHidden(user.id) ? { bio: '', links: [], profileHidden: true } : { bio: user.bio ?? '', links: linksOf(user.id), profileHidden: false }),
      level,
      csvTrades,
      totalReturn: perf.totalReturn,
      maxDrawdown: perf.maxDrawdown,
      winRate: ts.winRate,
      closedTrades: ts.closedTrades,
      realizedPnl: ts.realizedPnl,
      snapshots: snaps.length,
      equityCurve: perf.series,
      eligible: reasons.length === 0,
      ineligibleReasons: reasons,
      syncStatus: syncAgeMs === null ? 'never' : syncAgeMs <= 15 * 60_000 ? 'live' : 'stale',
      lastSyncAt: user.last_sync_ms ? new Date(user.last_sync_ms).toISOString() : null,
    }
  }

  /** Trades the viewer may see: the owner sees all, everyone else only after the delay. */
  function visibleTrades(user: Row, viewer: Row | null, limit: number) {
    const all = q.allTradesOf.all(user.id) as Row[]
    const owner = viewer?.id === user.id
    return all
      .filter((r) => owner || isVisible(r.executed_ms, user.delay_sec, now()))
      .slice(-limit)
      .reverse()
      .map((r) => ({
        handle: user.handle,
        avatarV: user.avatar_ms ?? null,
        symbol: r.symbol,
        side: r.side,
        qty: r.qty,
        price: r.price,
        executedAt: r.executed_at,
        verified: r.source === 'api',
      }))
  }

  // ---------- accounts & settings ----------

  app.post('/api/auth/register', async (req, reply) => {
    if (!registerByIp.allowed(req.ip)) return reply.code(429).send({ error: 'too many sign-ups, try again later' })
    const b = (req.body ?? {}) as Row
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(email) || email.length > 254) return reply.code(400).send({ error: 'invalid email' })
    const problem = handleProblem(b.handle)
    if (problem) return reply.code(400).send({ error: HANDLE_MESSAGES[problem], code: `handle_${problem}` })
    const handle = b.handle as string
    if (typeof b.password !== 'string' || b.password.length < PASSWORD_MIN || b.password.length > PASSWORD_MAX) {
      return reply.code(400).send({ error: `password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters` })
    }
    if (q.userByEmail.get(email)) return reply.code(409).send({ error: 'email already registered', code: 'email_taken' })
    // Compared without regard to case: "Alice" is taken if "alice" exists.
    if (q.userByHandle.get(handle)) return reply.code(409).send({ error: HANDLE_MESSAGES.taken, code: 'handle_taken' })
    registerByIp.record(req.ip)
    const passwordHash = await hashPassword(b.password)

    let id: number
    try {
      id = Number(
        db
          .prepare('INSERT INTO users (email, handle, handle_lc, password_hash, delay_sec, created_ms) VALUES (?, ?, ?, ?, ?, ?)')
          .run(email, handle, handleKey(handle), passwordHash, DEFAULT_DELAY_SEC, now()).lastInsertRowid,
      )
    } catch (e) {
      // Two sign-ups can pass the checks above at the same moment (hashing the password takes time).
      // The database's unique indexes are the real guarantee; the loser gets a normal "taken" answer.
      const msg = (e as Error).message
      if (/UNIQUE/i.test(msg)) {
        return /users\.email/.test(msg)
          ? reply.code(409).send({ error: 'email already registered', code: 'email_taken' })
          : reply.code(409).send({ error: HANDLE_MESSAGES.taken, code: 'handle_taken' })
      }
      throw e
    }
    startSession(reply, id)
    return meBody(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row)
  })

  // Lets the sign-up form say "taken" before the person has typed a password.
  app.get('/api/auth/handle-available', async (req, reply) => {
    if (!handleCheckByIp.allowed(req.ip)) return reply.code(429).send({ error: 'too many checks, slow down' })
    handleCheckByIp.record(req.ip)
    const handle = String((req.query as Row).handle ?? '')
    const problem = handleProblem(handle)
    if (problem) return { available: false, reason: problem, message: HANDLE_MESSAGES[problem] }
    if (q.userByHandle.get(handle)) return { available: false, reason: 'taken', message: HANDLE_MESSAGES.taken }
    return { available: true }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as Row
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
    const password = typeof b.password === 'string' ? b.password.slice(0, PASSWORD_MAX) : ''
    const identity = `${req.ip}|${email}`
    if (!loginByIdentity.allowed(identity) || !loginByIp.allowed(req.ip)) {
      return reply.code(429).send({ error: 'too many attempts, try again in 15 minutes' })
    }
    const u = q.userByEmail.get(email) as Row | undefined
    const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH)
    if (!u || !ok) {
      loginByIdentity.record(identity)
      loginByIp.record(req.ip)
      return reply.code(401).send({ error: 'email or password is incorrect' })
    }
    loginByIdentity.reset(identity)
    startSession(reply, u.id)
    return meBody(u)
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const s = authSession(req)
    if (s) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(s.idHash)
    reply.header('set-cookie', cookie('', 0))
    return { ok: true }
  })

  app.post('/api/auth/password', async (req, reply) => {
    const s = authSession(req)
    if (!s) return reply.code(401).send({ error: 'unauthorized' })
    const b = (req.body ?? {}) as Row
    if (typeof b.current !== 'string' || !(await verifyPassword(b.current.slice(0, PASSWORD_MAX), s.user.password_hash))) {
      return reply.code(403).send({ error: 'current password is incorrect' })
    }
    if (typeof b.next !== 'string' || b.next.length < PASSWORD_MIN || b.next.length > PASSWORD_MAX) {
      return reply.code(400).send({ error: `password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters` })
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(b.next), s.user.id)
    // Sign out everywhere else; a stolen session should not survive a password change.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(s.user.id, s.idHash)
    return { ok: true }
  })

  // Self-service account deletion (required by App Store guideline 5.1.1(v)). Needs the password, so a
  // stolen session alone cannot wipe an account. Everything the user owns is removed in one transaction.
  app.post('/api/me/delete', async (req, reply) => {
    const s = authSession(req)
    if (!s) return reply.code(401).send({ error: 'unauthorized' })
    const b = (req.body ?? {}) as Row
    if (typeof b.password !== 'string' || !(await verifyPassword(b.password.slice(0, PASSWORD_MAX), s.user.password_hash))) {
      return reply.code(403).send({ error: 'password is incorrect' })
    }
    const uid = s.user.id
    db.exec('BEGIN')
    try {
      // Comments on the user's posts and the user's own comments and posts go first (they reference posts).
      db.prepare('DELETE FROM reports WHERE reporter_id = ? OR (target_type = ? AND target_id IN (SELECT id FROM comments WHERE user_id = ? OR post_id IN (SELECT id FROM posts WHERE user_id = ?)))').run(uid, 'comment', uid, uid)
      db.prepare('DELETE FROM reports WHERE target_type = ? AND target_id IN (SELECT id FROM posts WHERE user_id = ?)').run('post', uid)
      db.prepare('DELETE FROM comments WHERE user_id = ? OR post_id IN (SELECT id FROM posts WHERE user_id = ?)').run(uid, uid)
      db.prepare('DELETE FROM posts WHERE user_id = ?').run(uid)
      db.prepare('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?').run(uid, uid)
      for (const table of ['trades', 'snapshots', 'gaps', 'csv_snapshots', 'watchlist', 'api_keys', 'sessions', 'accounts', 'notification_seen', 'social_links', 'avatars']) {
        db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(uid)
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(uid)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    reply.header('set-cookie', cookie('', 0))
    return { ok: true }
  })

  app.get('/api/me', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    return meBody(u)
  })

  // ---------- bio and social links ----------

  app.put('/api/me/profile', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    if (!profileLimiter.allowed(String(u.id))) return reply.code(429).send({ error: '更新太頻繁，請稍後再試' })
    profileLimiter.record(String(u.id))
    const b = (req.body ?? {}) as Row

    let bio = (u.bio as string) ?? ''
    if (b.bio !== undefined) {
      if (typeof b.bio !== 'string') return reply.code(400).send({ error: '自我介紹格式不正確' })
      // Plain text only; the web app renders it as text and never turns anything in it into a link.
      const clean = b.bio.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
      if (Array.from(clean).length > MAX_BIO) return reply.code(400).send({ error: `自我介紹最多 ${MAX_BIO} 字` })
      if (clean.split('\n').length > MAX_BIO_LINES) return reply.code(400).send({ error: `自我介紹最多 ${MAX_BIO_LINES} 行` })
      bio = clean
    }

    let links: { platform: SocialPlatform; handle: string }[] | null = null
    if (b.links !== undefined) {
      if (!Array.isArray(b.links) || b.links.length > MAX_LINKS) return reply.code(400).send({ error: `最多 ${MAX_LINKS} 個社群連結` })
      const seen = new Set<string>()
      links = []
      for (const l of b.links as Row[]) {
        if (!isSocialPlatform(l?.platform)) return reply.code(400).send({ error: '不支援的社群平台' })
        if (seen.has(l.platform)) return reply.code(400).send({ error: '同一個平台只能放一個連結' })
        const handle = normalizeSocial(l.platform, l.handle)
        if (!handle) return reply.code(400).send({ error: `${SOCIAL[l.platform].label} 帳號格式不正確` })
        seen.add(l.platform)
        links.push({ platform: l.platform, handle })
      }
    }

    db.exec('BEGIN')
    try {
      db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, u.id)
      if (links) {
        db.prepare('DELETE FROM social_links WHERE user_id = ?').run(u.id)
        const ins = db.prepare('INSERT INTO social_links (user_id, platform, handle) VALUES (?, ?, ?)')
        for (const l of links) ins.run(u.id, l.platform, l.handle)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return meBody(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as Row)
  })

  // ---------- Level 1: holdings snapshot (期初庫存) ----------

  const snapshotLimiter = new Limiter(20, 60 * 60_000, now)
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

  app.get('/api/me/holdings-import', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const rows = db.prepare('SELECT id, as_of, lines, mismatches FROM csv_snapshots WHERE user_id = ? ORDER BY taken_ms DESC').all(me.id) as Row[]
    return {
      snapshots: rows.map((r) => ({
        id: r.id,
        asOf: r.as_of,
        positions: (JSON.parse(r.lines as string) as unknown[]).length,
        mismatches: JSON.parse(r.mismatches as string) as LineMismatch[],
      })),
    }
  })

  app.post('/api/me/holdings-import', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    if (!snapshotLimiter.allowed(String(me.id))) return reply.code(429).send({ error: '上傳太頻繁，請稍後再試' })
    const b = (req.body ?? {}) as Row
    const asOf = typeof b.asOf === 'string' ? b.asOf.trim() : ''
    const iso = DATE_ONLY.test(asOf) ? parseTaipeiTime(asOf) : null
    if (!iso) return reply.code(400).send({ error: '請選擇庫存日期' })
    const takenMs = Date.parse(iso)
    if (takenMs > now() + 60_000) return reply.code(400).send({ error: '庫存日期不能是未來' })
    if (typeof b.csv !== 'string') return reply.code(400).send({ error: 'csv is required' })
    const { lines, errors } = parseHoldingsCsv(b.csv)
    if (errors.length) return reply.code(400).send({ error: '部分列無法使用', errors: errors.slice(0, 10) })
    snapshotLimiter.record(String(me.id))
    if (db.prepare('SELECT 1 FROM csv_snapshots WHERE user_id = ? AND taken_ms = ?').get(me.id, takenMs)) {
      return reply.code(409).send({ error: '這一天已經有庫存紀錄，請先刪除再上傳' })
    }

    // Check the new snapshot against what the previous one plus every trade in between implies.
    const prev = db
      .prepare('SELECT * FROM csv_snapshots WHERE user_id = ? AND taken_ms < ? ORDER BY taken_ms DESC LIMIT 1')
      .get(me.id, takenMs) as Row | undefined
    let mismatches: LineMismatch[] = []
    if (prev) {
      const between = (q.allTradesOf.all(me.id) as Row[]).map(toTrade).filter((t) => {
        const ms = Date.parse(t.executedAt)
        return ms > (prev.taken_ms as number) && ms <= takenMs
      })
      mismatches = compareLines(applyTrades(JSON.parse(prev.lines as string), between).lines, lines)
    }
    db.prepare(
      'INSERT INTO csv_snapshots (user_id, as_of, taken_ms, taken_at, lines, mismatches, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(me.id, asOf, takenMs, iso, JSON.stringify(lines), JSON.stringify(mismatches), now())
    return { asOf, positions: lines.length, reconciledWith: prev ? (prev.as_of as string) : null, mismatches }
  })

  app.delete('/api/me/holdings-import/:id', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const res = db.prepare('DELETE FROM csv_snapshots WHERE id = ? AND user_id = ?').run(Number((req.params as Row).id), me.id)
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not found' })
    return { ok: true }
  })

  // ---------- Level 1: user-submitted CSV ----------

  const csvLimiter = new Limiter(10, 60 * 60_000, now)

  // CSV rows are stored apart from the verified record: no hash chain, no stats, no ranking.
  app.post('/api/me/csv-import', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const text = (req.body as Row | null)?.csv
    if (typeof text !== 'string' || text.trim() === '') return reply.code(400).send({ error: 'csv is required' })
    if (!csvLimiter.allowed(String(u.id))) return reply.code(429).send({ error: 'too many imports, try again later' })
    csvLimiter.record(String(u.id))

    const { trades, errors } = parseTradesCsv(text)
    if (trades.length === 0) return reply.code(400).send({ error: 'no valid rows', errors: errors.slice(0, 10) })

    const insert = db.prepare(
      `INSERT OR IGNORE INTO trades (user_id, broker_trade_id, symbol, side, qty, price, fee, executed_ms, executed_at, prev_hash, hash, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 'csv')`,
    )
    let imported = 0
    let duplicates = 0
    let future = 0
    for (const t of trades) {
      const ms = Date.parse(t.executedAt)
      if (ms > now() + 60_000) {
        future++
        continue
      }
      const res = insert.run(u.id, t.brokerTradeId, t.symbol, t.side, t.qty, t.price, t.fee ?? 0, ms, t.executedAt)
      if (Number(res.changes) === 1) imported++
      else duplicates++
    }
    return { imported, duplicates, rejected: errors.length + future, errors: errors.slice(0, 10) }
  })

  app.delete('/api/me/csv-import', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const res = db.prepare("DELETE FROM trades WHERE user_id = ? AND source = 'csv'").run(u.id)
    return { removed: Number(res.changes) }
  })

  // ---------- agent keys ----------

  app.get('/api/me/agent-keys', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const rows = db
      .prepare('SELECT id, created_ms, last_used_ms FROM api_keys WHERE user_id = ? AND revoked_ms IS NULL ORDER BY id')
      .all(u.id) as Row[]
    return {
      keys: rows.map((r) => ({
        id: r.id,
        createdAt: new Date(r.created_ms).toISOString(),
        lastUsedAt: r.last_used_ms ? new Date(r.last_used_ms).toISOString() : null,
      })),
    }
  })

  app.post('/api/me/agent-keys', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const active = (db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_ms IS NULL').get(u.id) as Row).n
    if (active >= MAX_AGENT_KEYS) return reply.code(400).send({ error: `at most ${MAX_AGENT_KEYS} active keys; revoke one first` })
    const key = 'tot_ak_' + randomBytes(24).toString('hex')
    const res = db.prepare('INSERT INTO api_keys (user_id, key_hash, created_ms) VALUES (?, ?, ?)').run(u.id, sha(key), now())
    // The plaintext is returned once and never stored.
    return { id: Number(res.lastInsertRowid), key }
  })

  app.delete('/api/me/agent-keys/:id', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const res = db
      .prepare('UPDATE api_keys SET revoked_ms = ? WHERE id = ? AND user_id = ? AND revoked_ms IS NULL')
      .run(now(), Number((req.params as Row).id), u.id)
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not found' })
    return { ok: true }
  })

  app.put('/api/me/settings', async (req, reply) => {
    const u = authUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const b = (req.body ?? {}) as Row
    let delay = u.delay_sec as number
    let vis = u.holdings_visibility as string
    if (b.delaySec !== undefined) {
      if (typeof b.delaySec !== 'number') return reply.code(400).send({ error: 'delaySec must be a number' })
      delay = clampDelay(b.delaySec)
    }
    let digest = u.email_digest as number
    if (b.emailDigest !== undefined) {
      if (typeof b.emailDigest !== "boolean") return reply.code(400).send({ error: "emailDigest must be true or false" })
      digest = b.emailDigest ? 1 : 0
    }
    if (b.holdingsVisibility !== undefined) {
      if (!VISIBILITIES.includes(b.holdingsVisibility)) return reply.code(400).send({ error: 'bad holdingsVisibility' })
      vis = b.holdingsVisibility
    }
    db.prepare("UPDATE users SET delay_sec = ?, holdings_visibility = ?, email_digest = ? WHERE id = ?").run(delay, vis, digest, u.id)
    return { delaySec: delay, holdingsVisibility: vis, emailDigest: !!digest }
  })

  // ---------- ingest from the local agent ----------

  app.post('/api/ingest', async (req, reply) => {
    const u = agentUser(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const b = (req.body ?? {}) as Row
    if (typeof b.broker !== 'string' || typeof b.accountFingerprint !== 'string' || b.accountFingerprint.length < 16) {
      return reply.code(400).send({ error: 'broker and accountFingerprint required' })
    }
    const nowMs = now()

    // Bind the account on first contact. Afterwards it can never change.
    const acct = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(u.id) as Row | undefined
    let boundMs: number
    if (!acct) {
      if (db.prepare('SELECT 1 FROM accounts WHERE fingerprint = ?').get(b.accountFingerprint)) {
        return reply.code(409).send({ error: 'this broker account is already linked to another user' })
      }
      db.prepare('INSERT INTO accounts (user_id, broker, fingerprint, bound_ms) VALUES (?, ?, ?, ?)').run(
        u.id,
        b.broker,
        b.accountFingerprint,
        nowMs,
      )
      boundMs = nowMs
    } else if (acct.fingerprint !== b.accountFingerprint) {
      return reply.code(409).send({ error: 'a different broker account is already linked' })
    } else {
      boundMs = acct.bound_ms
    }

    // Record silence that overlapped a trading session.
    if (u.last_sync_ms && nowMs - u.last_sync_ms > gapThreshold && overlapsMarketHours(u.last_sync_ms, nowMs)) {
      db.prepare('INSERT INTO gaps (user_id, from_ms, to_ms) VALUES (?, ?, ?)').run(u.id, u.last_sync_ms, nowMs)
    }
    db.prepare('UPDATE users SET last_sync_ms = ? WHERE id = ?').run(nowMs, u.id)

    // Trades: append-only, hash-chained in ingestion order, nothing before the bind date.
    const incoming = Array.isArray(b.trades) ? (b.trades as Row[]) : []
    const parsed: { t: Trade; ms: number }[] = []
    let rejected = 0
    for (const r of incoming) {
      const ms = parseIso(r?.executedAt)
      const ok =
        ms !== null &&
        typeof r.brokerTradeId === 'string' &&
        r.brokerTradeId.length > 0 &&
        typeof r.symbol === 'string' &&
        (r.side === 'buy' || r.side === 'sell') &&
        Number.isInteger(r.qty) &&
        r.qty > 0 &&
        isPos(r.price) &&
        (r.fee === undefined || (typeof r.fee === 'number' && r.fee >= 0)) &&
        ms >= boundMs && // no backfill before linking
        ms <= nowMs + 60_000
      if (!ok) {
        rejected++
        continue
      }
      parsed.push({
        ms,
        t: { brokerTradeId: r.brokerTradeId, symbol: r.symbol, side: r.side, qty: r.qty, price: r.price, executedAt: new Date(ms).toISOString(), fee: r.fee ?? 0 },
      })
    }
    parsed.sort((a, c) => a.ms - c.ms)

    let accepted = 0
    let duplicates = 0
    let prevHash = (db.prepare("SELECT hash FROM trades WHERE user_id = ? AND source = 'api' ORDER BY id DESC LIMIT 1").get(u.id) as Row | undefined)?.hash ?? GENESIS_HASH
    const insertTrade = db.prepare(
      `INSERT OR IGNORE INTO trades (user_id, broker_trade_id, symbol, side, qty, price, fee, executed_ms, executed_at, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const { t, ms } of parsed) {
      const hash = tradeHash(prevHash, t)
      const res = insertTrade.run(u.id, t.brokerTradeId, t.symbol, t.side, t.qty, t.price, t.fee ?? 0, ms, t.executedAt, prevHash, hash)
      if (Number(res.changes) === 1) {
        accepted++
        prevHash = hash
      } else {
        duplicates++
      }
    }

    // Snapshot: equity and flow are derived here, not trusted from the agent.
    let reconciled: boolean | null = null
    const s = b.snapshot as Row | undefined
    if (s) {
      const takenMs = parseIso(s.takenAt)
      const positions: Position[] | null = Array.isArray(s.positions)
        ? s.positions.every(
            (p: Row) =>
              typeof p?.symbol === 'string' && Number.isInteger(p.qty) && p.qty > 0 && isPos(p.avgPrice) && isPos(p.lastPrice),
          )
          ? (s.positions as Position[])
          : null
        : null
      if (takenMs === null || takenMs > nowMs + 60_000 || typeof s.cash !== 'number' || !Number.isFinite(s.cash) || !positions) {
        return reply.code(400).send({ error: 'invalid snapshot', accepted, duplicates, rejected })
      }
      const equity = s.cash + marketValue(positions)
      const prev = db
        .prepare('SELECT * FROM snapshots WHERE user_id = ? AND taken_ms < ? ORDER BY taken_ms DESC LIMIT 1')
        .get(u.id, takenMs) as Row | undefined
      const first = db.prepare('SELECT * FROM snapshots WHERE user_id = ? ORDER BY taken_ms LIMIT 1').get(u.id) as Row | undefined
      const allTrades = q.tradesOf.all(u.id) as Row[]

      let flow = 0
      if (prev) {
        const between = allTrades.filter((r) => r.executed_ms > prev.taken_ms && r.executed_ms <= takenMs).map(toTrade)
        flow = inferFlow(prev.cash, s.cash, between, equity)
      }
      let mismatches: unknown[] = []
      if (first && first.taken_ms < takenMs) {
        const since = allTrades.filter((r) => r.executed_ms > first.taken_ms && r.executed_ms <= takenMs).map(toTrade)
        mismatches = reconcile(JSON.parse(first.positions), since, positions)
      }
      reconciled = mismatches.length === 0
      db.prepare(
        `INSERT OR IGNORE INTO snapshots (user_id, taken_ms, taken_at, cash, equity, flow, positions, reconciled, mismatches)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(u.id, takenMs, new Date(takenMs).toISOString(), s.cash, equity, flow, JSON.stringify(positions), reconciled ? 1 : 0, JSON.stringify(mismatches))
    }

    return { accepted, duplicates, rejected, reconciled }
  })

  // ---------- public reads ----------

  app.get('/api/leaderboard', async (req) => {
    await syncDividends()
    const sort = (req.query as Row).sort === 'winrate' ? 'winRate' : 'totalReturn'
    const users = db.prepare('SELECT * FROM users').all() as Row[]
    const rows = users.map((u) => {
      const { equityCurve: _curve, ...rest } = traderSummary(u)
      return rest
    })
    const eligible = rows.filter((r) => r.eligible).sort((a, b) => b[sort] - a[sort])
    return { sort, entries: eligible.map((r, i) => ({ rank: i + 1, ...r })) }
  })

  // Block helpers. A block is one-directional to create but hides both ways (see forum.ts notBlocked).
  const blocks = (blocker: number, blocked: number) =>
    !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blocker, blocked)
  const blockedEitherWay = (a: number, b: number) => blocks(a, b) || blocks(b, a)

  app.get('/api/traders/:handle', async (req, reply) => {
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).send({ error: 'not found' })
    const viewer = authUser(req)
    // If this trader blocked the viewer, the viewer gets no profile at all. The viewer who blocked them still sees it, to unblock.
    if (viewer && blocks(u.id as number, viewer.id as number)) return reply.code(404).send({ error: 'not found' })
    await syncDividends()
    const followers = (db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?').get(u.id) as Row).n
    const following = viewer
      ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewer.id, u.id)
      : false
    return {
      ...traderSummary(u),
      delaySec: u.delay_sec,
      holdingsVisibility: u.holdings_visibility,
      followers,
      following,
      blocked: viewer ? blocks(viewer.id as number, u.id as number) : false,
    }
  })

  app.get('/api/traders/:handle/trades', async (req, reply) => {
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).send({ error: 'not found' })
    const viewer = authUser(req)
    if (viewer && blockedEitherWay(viewer.id as number, u.id as number) && viewer.id !== u.id) return reply.code(404).send({ error: 'not found' })
    return { delaySec: u.delay_sec, trades: await named(visibleTrades(u, viewer, 100)) }
  })

  /**
   * Holdings as this viewer may see them: the owner sees everything live, anyone else sees the snapshot
   * as of the trader's display delay (or a weight ratio, or nothing). Shared by the holdings route and by
   * the "followed traders who hold this stock" view, so both apply the same delay and privacy rules.
   */
  async function holdingsOf(u: Row, viewer: Row | null) {
    const owner = viewer?.id === u.id
    const mode = owner ? 'public' : (u.holdings_visibility as HoldingsVisibility)
    if (mode === 'hidden') return { mode, holdings: [] as Row[] }
    const cutoff = owner ? now() : now() - u.delay_sec * 1000
    const snap = db
      .prepare('SELECT * FROM snapshots WHERE user_id = ? AND taken_ms <= ? ORDER BY taken_ms DESC LIMIT 1')
      .get(u.id, cutoff) as Row | undefined
    // A holdings snapshot the user uploaded, if it is newer than any broker-verified snapshot, moves forward
    // by the trades after it. Only trades visible under the trader's delay are applied to others.
    const csv = db
      .prepare('SELECT * FROM csv_snapshots WHERE user_id = ? AND taken_ms <= ? ORDER BY taken_ms DESC LIMIT 1')
      .get(u.id, cutoff) as Row | undefined
    if (csv && (!snap || (csv.taken_ms as number) > (snap.taken_ms as number))) {
      if (mode === 'ratio') return { mode, source: 'csv' as const, asOf: csv.taken_at as string, holdings: [] as Row[], note: 'ratio_unavailable' }
      const after = (q.allTradesOf.all(u.id) as Row[]).map(toTrade).filter((t) => {
        const ms = Date.parse(t.executedAt)
        return ms > (csv.taken_ms as number) && ms <= cutoff
      })
      const derived = applyTrades(JSON.parse(csv.lines as string), after)
      return {
        mode,
        source: 'csv' as const,
        asOf: csv.taken_at as string,
        negative: derived.negative,
        note: derived.negative.length ? 'negative_holdings' : null,
        holdings: await named(derived.lines),
      }
    }
    if (!snap) return { mode, asOf: null as string | null, holdings: [] as Row[] }
    const positions: Position[] = JSON.parse(snap.positions)
    return {
      mode,
      asOf: snap.taken_at as string,
      holdings: mode === 'ratio' ? await named(ratioHoldings(positions)) : await named(positions),
    }
  }

  app.get('/api/traders/:handle/holdings', async (req, reply) => {
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).send({ error: 'not found' })
    const viewer = authUser(req)
    if (viewer && viewer.id !== u.id && blockedEitherWay(viewer.id as number, u.id as number)) return reply.code(404).send({ error: 'not found' })
    return holdingsOf(u, viewer)
  })

  app.get('/api/traders/:handle/integrity', async (req, reply) => {
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).send({ error: 'not found' })
    const viewer = authUser(req)
    if (viewer && viewer.id !== u.id && blockedEitherWay(viewer.id as number, u.id as number)) return reply.code(404).send({ error: 'not found' })
    const rows = (q.tradesOf.all(u.id) as Row[]).map((r) => ({ trade: toTrade(r), prevHash: r.prev_hash, hash: r.hash }))
    const gaps = db.prepare('SELECT from_ms, to_ms FROM gaps WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id) as Row[]
    const acct = db.prepare('SELECT broker, bound_ms FROM accounts WHERE user_id = ?').get(u.id) as Row | undefined
    return {
      chain: verifyChain(rows),
      trades: rows.length,
      head: rows[rows.length - 1]?.hash ?? null,
      broker: acct?.broker ?? null,
      trackedSince: acct ? new Date(acct.bound_ms).toISOString() : null,
      gaps: gaps.map((g) => ({ from: new Date(g.from_ms).toISOString(), to: new Date(g.to_ms).toISOString() })),
    }
  })

  // ---------- follows ----------

  app.post('/api/traders/:handle/follow', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).send({ error: 'not found' })
    if (u.id === me.id) return reply.code(400).send({ error: 'cannot follow yourself' })
    if (blockedEitherWay(me.id as number, u.id as number)) return reply.code(403).send({ error: 'blocked' })
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(me.id, u.id)
    return { following: true }
  })

  // Blocking hides both sides from each other and drops any follow in either direction.
  app.post('/api/traders/:handle/block', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).send({ error: 'not found' })
    if (u.id === me.id) return reply.code(400).send({ error: 'cannot block yourself' })
    db.exec('BEGIN')
    try {
      db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_ms) VALUES (?, ?, ?)').run(me.id, u.id, now())
      db.prepare('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)').run(me.id, u.id, u.id, me.id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { blocked: true }
  })

  app.delete('/api/traders/:handle/block', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).send({ error: 'not found' })
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(me.id, u.id)
    return { blocked: false }
  })

  // Only the blocked traders' handles and avatars are listed, and only to their blocker.
  app.get('/api/me/blocks', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const rows = db
      .prepare('SELECT u.handle, u.avatar_ms FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY u.handle_lc')
      .all(me.id) as Row[]
    return { blocked: rows.map((r) => ({ handle: r.handle as string, avatarV: (r.avatar_ms as number | null) ?? null })) }
  })

  app.delete('/api/traders/:handle/follow', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).send({ error: 'not found' })
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(me.id, u.id)
    return { following: false }
  })

  app.get('/api/feed', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const followed = db
      .prepare(`SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? AND ${notBlocked(me.id, 'u.id')}`)
      .all(me.id) as Row[]
    // Followed traders only. Your own trades have their own section (see /api/traders/:handle/trades).
    const items = followed.flatMap((u) => visibleTrades(u, me, 50))
    items.sort((a, b) => b.executedAt.localeCompare(a.executedAt))
    return { trades: await named(items.slice(0, 100)) }
  })

  // Find a trader by ID (case-insensitive prefix). Only the handle is searchable; no other personal data is returned.
  app.get('/api/traders/search', async (req) => {
    const q = String((req.query as Row).q ?? '').trim().toLowerCase()
    if (!/^[a-z0-9_]{1,20}$/.test(q)) return { results: [] }
    const viewer = authUser(req)
    const rows = db
      .prepare(
        `SELECT handle, avatar_ms, EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = users.id) AS verified FROM users
         WHERE handle_lc LIKE ? || '%' AND ${notBlocked(viewer?.id, 'users.id')} ORDER BY handle_lc LIMIT 10`,
      )
      .all(q) as Row[]
    return {
      results: rows.map((r) => ({ handle: r.handle as string, avatarV: (r.avatar_ms as number | null) ?? null, verified: !!r.verified })),
    }
  })

  // ---------- followed traders who hold a stock (登入後，只看追蹤對象) ----------

  app.get('/api/market/stocks/:code/followed-holders', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    const code = String((req.params as Row).code)
    if (!/^[0-9A-Za-z]{2,8}$/.test(code)) return reply.code(400).send({ error: 'invalid code' })
    const followed = db
      .prepare(`SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? AND ${notBlocked(me.id, 'u.id')} ORDER BY u.handle_lc`)
      .all(me.id) as Row[]
    const holders: Row[] = []
    for (const u of followed) {
      // Same delay and privacy rules as anyone else sees: a hidden holding never shows up here.
      const h = await holdingsOf(u, me)
      // Holdings from an uploaded snapshot are unverified. This list reads as a signal, so they stay out of it.
      if (h.source === 'csv') continue
      const row = (h.holdings as Row[]).find((x) => x.symbol === code)
      if (!row) continue
      holders.push({
        handle: u.handle,
        avatarV: u.avatar_ms ?? null,
        mode: h.mode,
        qty: row.qty ?? null,
        weight: row.weight ?? null,
        asOf: h.asOf ?? null,
        level: 2,
      })
    }
    return { holders }
  })

  // ---------- notifications (in-app only) ----------
  // A notification is a trade of a followed trader that has become visible since the user last looked.
  // Visibility is executed time plus that trader's delay, so a notification can never arrive earlier than
  // the trader's own delay allows.

  app.get('/api/me/notifications', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    // First visit: start the clock now, so an old backlog does not show up as new.
    db.prepare('INSERT OR IGNORE INTO notification_seen (user_id, seen_ms) VALUES (?, ?)').run(me.id, now())
    const seen = (db.prepare('SELECT seen_ms FROM notification_seen WHERE user_id = ?').get(me.id) as Row).seen_ms as number
    const followed = db
      .prepare(`SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? AND ${notBlocked(me.id, 'u.id')}`)
      .all(me.id) as Row[]
    const items = followed
      .flatMap((u) => visibleTrades(u, me, 50).filter((t) => Date.parse(t.executedAt) + u.delay_sec * 1000 > seen))
    items.sort((a, b) => b.executedAt.localeCompare(a.executedAt))
    return { unread: items.length, trades: await named(items.slice(0, 50)) }
  })

  app.post('/api/me/notifications/seen', async (req, reply) => {
    const me = authUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthorized' })
    db.prepare(
      'INSERT INTO notification_seen (user_id, seen_ms) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET seen_ms = excluded.seen_ms',
    ).run(me.id, now())
    return { ok: true }
  })

  registerForum(app, db, { authUser, now })
  registerAvatar(app, db, { authUser, now })
  registerMarketRoutes(app, db, { authUser, now, market, syncHolders })

  // ---------- share pages, robots.txt and sitemap (for link previews and search engines) ----------

  const baseUrl = (req: FastifyRequest) => (opts.publicUrl ?? `${req.protocol}://${req.headers.host ?? req.hostname}`).replace(/\/$/, '')
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

  // Crawlers do not run the app, so each public trader gets a real page with preview tags. People are sent on to the app.
  app.get('/t/:handle', async (req, reply) => {
    const u = q.userByHandle.get((req.params as Row).handle) as Row | undefined
    if (!u) return reply.code(404).type('text/html; charset=utf-8').send('<!doctype html><title>找不到交易員</title><p>找不到這位交易員。</p>')
    const s = traderSummary(u)
    const verified = s.level === 2
    const ret = `${s.totalReturn > 0 ? '+' : ''}${(s.totalReturn * 100).toFixed(1)}%`
    const desc = verified
      ? `券商驗證的實盤績效，時間加權報酬 ${ret}，勝率 ${(s.winRate * 100).toFixed(0)}%。交易紀錄延遲公開，僅供追蹤，不構成投資建議。`
      : '在 Trakr 追蹤這位交易員的交易紀錄。僅供追蹤，不構成投資建議。'
    const title = `${u.handle} · Trakr`
    const url = `${baseUrl(req)}/t/${u.handle}`
    const page = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(url)}" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:site_name" content="Trakr" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta http-equiv="refresh" content="0; url=/#/t/${esc(u.handle)}" />
</head><body>
<p>${esc(u.handle)}${verified ? '（券商驗證）' : ''}</p>
<p>${esc(desc)}</p>
<p><a href="/#/t/${esc(u.handle)}">在 Trakr 查看</a></p>
</body></html>`
    return reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300').send(page)
  })

  app.get('/robots.txt', async (req, reply) =>
    reply.type('text/plain; charset=utf-8').send(`User-agent: *\nAllow: /\nSitemap: ${baseUrl(req)}/sitemap.xml\n`),
  )

  // Only traders who are on the leaderboard are listed; anyone else would be a thin page.
  app.get('/sitemap.xml', async (req, reply) => {
    const base = baseUrl(req)
    const users = db.prepare('SELECT * FROM users').all() as Row[]
    const urls = users.filter((u) => traderSummary(u).eligible).map((u) => `  <url><loc>${esc(`${base}/t/${u.handle}`)}</loc></url>`)
    return reply
      .type('application/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`)
  })

  // ---------- email digest (opt-in) ----------
  // Tests and the hourly timer call this; it does nothing unless a digest secret and mailer are configured.
  app.decorate("runDigest", runDigest)

  app.get('/api/digest/unsubscribe', async (req, reply) => {
    if (!opts.digest) return reply.code(404).send({ error: 'not found' })
    const q2 = req.query as Row
    const id = Number(q2.u)
    const token = typeof q2.t === 'string' ? q2.t : ''
    if (!Number.isInteger(id) || !unsubscribeTokenValid(id, token, opts.digest.secret)) {
      return reply.code(400).type('text/html; charset=utf-8').send('<!doctype html><p>連結無效。</p>')
    }
    db.prepare('UPDATE users SET email_digest = 0 WHERE id = ?').run(id)
    return reply.type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><p>已取消訂閱交易摘要信件。</p>')
  })

  /** Sends one digest per opted-in user for trades that became visible since their last digest. Failures are retried next time. */
  async function runDigest() {
    if (!opts.digest) return
    const { secret, mailer } = opts.digest
    const base = (opts.publicUrl ?? '').replace(/\/$/, '')
    const users = db.prepare('SELECT * FROM users WHERE email_digest = 1').all() as Row[]
    for (const u of users) {
      // First digest looks back one day; after that, only what is new since the last one.
      const since = (u.digest_sent_ms as number) || now() - 24 * 3_600_000
      const followed = db
        .prepare(`SELECT u2.* FROM follows f JOIN users u2 ON u2.id = f.followee_id WHERE f.follower_id = ? AND ${notBlocked(u.id as number, 'u2.id')}`)
        .all(u.id) as Row[]
      const fresh: DigestTrade[] = followed
        .flatMap((t) => visibleTrades(t, u, 50).filter((x) => Date.parse(x.executedAt) > since))
        .map((x) => ({ handle: x.handle as string, symbol: x.symbol as string, side: x.side as 'buy' | 'sell', qty: x.qty as number, price: x.price as number, executedAt: x.executedAt as string }))
        .sort((a, b) => b.executedAt.localeCompare(a.executedAt))
        .slice(0, 50)
      if (fresh.length === 0) continue
      const link = `${base}/api/digest/unsubscribe?u=${u.id}&t=${unsubscribeToken(u.id as number, secret)}`
      const msg = digestMessage(fresh, link)
      try {
        await mailer.send(u.email as string, msg.subject, msg.text)
        db.prepare('UPDATE users SET digest_sent_ms = ? WHERE id = ?').run(now(), u.id)
      } catch {
        // Leave digest_sent_ms alone so the same trades are tried again on the next run.
      }
    }
  }

  if (opts.autoSync) {
    // The ex-dividend list only shows a few weeks ahead. If nobody browses for a while, an announcement can pass
    // unarchived, so the archives are refreshed on a timer and not only when a page asks.
    const tick = () => {
      void syncHolders()
      void syncDividends()
    }
    tick()
    setInterval(tick, 6 * 3_600_000).unref()
    setInterval(() => void runDigest(), 3_600_000).unref()
  }

  return app
}
