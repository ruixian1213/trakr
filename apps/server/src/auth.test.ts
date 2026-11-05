import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const T0 = Date.parse('2026-11-03T01:00:00.000Z')
const MIN = 60_000
const PASSWORD = 'correct-horse-1'

function setup() {
  let clock = T0
  const app = buildApp(openDb(':memory:'), { now: () => clock })
  const advance = (ms: number) => (clock += ms)

  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers })
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers })

  async function register(handle: string) {
    const r = await post('/api/auth/register', { email: `${handle}@example.test`, handle, password: PASSWORD })
    const cookie = String(r.headers['set-cookie']).split(';')[0]!
    const k = await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })
    return { cookie, key: k.json().key as string }
  }
  const login = (email: string, password = PASSWORD) => post('/api/auth/login', { email, password })
  const fp = (n: string) => n.padEnd(32, 'x')
  return { app, post, get, register, login, advance, fp }
}

test('register sets an HttpOnly session cookie and never returns the password', async () => {
  const s = setup()
  const r = await s.post('/api/auth/register', { email: 'Alice@Example.test', handle: 'alice', password: PASSWORD })
  assert.equal(r.statusCode, 200)
  const setCookie = String(r.headers['set-cookie'])
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.equal(r.json().email, 'alice@example.test') // normalized
  assert.equal(JSON.stringify(r.json()).includes('password'), false)
  assert.equal((await s.get('/api/me', { cookie: setCookie.split(';')[0]! })).statusCode, 200)
})

test('register validates input and rejects duplicates', async () => {
  const s = setup()
  const ok = { email: 'a@example.test', handle: 'alice', password: PASSWORD }
  assert.equal((await s.post('/api/auth/register', { ...ok, email: 'nope' })).statusCode, 400)
  assert.equal((await s.post('/api/auth/register', { ...ok, password: 'short' })).statusCode, 400)
  assert.equal((await s.post('/api/auth/register', { ...ok, handle: 'a b' })).statusCode, 400)
  assert.equal((await s.post('/api/auth/register', ok)).statusCode, 200)
  assert.equal((await s.post('/api/auth/register', { ...ok, handle: 'other' })).statusCode, 409)
  assert.equal((await s.post('/api/auth/register', { ...ok, email: 'b@example.test' })).statusCode, 409)
})

test('login gives one generic error for bad password and unknown email; logout kills the session', async () => {
  const s = setup()
  await s.register('alice')
  const bad = await s.login('alice@example.test', 'wrong-password')
  const unknown = await s.login('nobody@example.test')
  assert.equal(bad.statusCode, 401)
  assert.equal(unknown.statusCode, 401)
  assert.equal(bad.json().error, unknown.json().error)

  const good = await s.login('ALICE@example.test')
  assert.equal(good.statusCode, 200)
  const cookie = String(good.headers['set-cookie']).split(';')[0]!
  assert.equal((await s.get('/api/me', { cookie })).statusCode, 200)

  await s.post('/api/auth/logout', {}, { cookie })
  assert.equal((await s.get('/api/me', { cookie })).statusCode, 401)
})

test('repeated failed logins are rate limited until the window passes', async () => {
  const s = setup()
  await s.register('alice')
  for (let i = 0; i < 5; i++) assert.equal((await s.login('alice@example.test', 'wrong-password')).statusCode, 401)
  assert.equal((await s.login('alice@example.test')).statusCode, 429)
  s.advance(16 * MIN)
  assert.equal((await s.login('alice@example.test')).statusCode, 200)
})

test('sessions expire after 30 days', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.get('/api/me', { cookie: a.cookie })).statusCode, 200)
  s.advance(31 * 24 * 60 * MIN)
  assert.equal((await s.get('/api/me', { cookie: a.cookie })).statusCode, 401)
})

test('an agent key cannot act as a logged-in user, and a cookie cannot ingest', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.get('/api/me', { authorization: `Bearer ${a.key}` })).statusCode, 401)
  const viaCookie = await s.post('/api/ingest', { broker: 'shioaji', accountFingerprint: s.fp('acct-a') }, { cookie: a.cookie })
  assert.equal(viaCookie.statusCode, 401)
})

test('revoked agent keys stop working at once; listings never contain the plaintext', async () => {
  const s = setup()
  const a = await s.register('alice')
  const body = { broker: 'shioaji', accountFingerprint: s.fp('acct-a') }
  const bearer = { authorization: `Bearer ${a.key}` }
  assert.equal((await s.post('/api/ingest', body, bearer)).statusCode, 200)

  const list = (await s.get('/api/me/agent-keys', { cookie: a.cookie })).json()
  assert.equal(list.keys.length, 1)
  assert.equal(JSON.stringify(list).includes(a.key), false)
  assert.ok(list.keys[0].lastUsedAt)

  const del = await s.app.inject({ method: 'DELETE', url: `/api/me/agent-keys/${list.keys[0].id}`, headers: { cookie: a.cookie } })
  assert.equal(del.statusCode, 200)
  assert.equal((await s.post('/api/ingest', body, bearer)).statusCode, 401)
})

test("one user cannot revoke another user's key", async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bob')
  const id = (await s.get('/api/me/agent-keys', { cookie: a.cookie })).json().keys[0].id
  const del = await s.app.inject({ method: 'DELETE', url: `/api/me/agent-keys/${id}`, headers: { cookie: b.cookie } })
  assert.equal(del.statusCode, 404)
  const still = await s.post('/api/ingest', { broker: 'x', accountFingerprint: s.fp('acct-a') }, { authorization: `Bearer ${a.key}` })
  assert.equal(still.statusCode, 200)
})

test('at most five active agent keys per user', async () => {
  const s = setup()
  const a = await s.register('alice') // already holds one
  for (let i = 0; i < 4; i++) {
    assert.equal((await s.post('/api/me/agent-keys', {}, { cookie: a.cookie })).statusCode, 200)
  }
  assert.equal((await s.post('/api/me/agent-keys', {}, { cookie: a.cookie })).statusCode, 400)
})

test('changing the password signs out other sessions but keeps this one', async () => {
  const s = setup()
  const a = await s.register('alice')
  const other = String((await s.login('alice@example.test')).headers['set-cookie']).split(';')[0]!

  const wrong = await s.post('/api/auth/password', { current: 'nope-nope-nope', next: 'new-password-9' }, { cookie: a.cookie })
  assert.equal(wrong.statusCode, 403)
  const ok = await s.post('/api/auth/password', { current: PASSWORD, next: 'new-password-9' }, { cookie: a.cookie })
  assert.equal(ok.statusCode, 200)

  assert.equal((await s.get('/api/me', { cookie: a.cookie })).statusCode, 200)
  assert.equal((await s.get('/api/me', { cookie: other })).statusCode, 401)
  assert.equal((await s.login('alice@example.test')).statusCode, 401) // old password is dead
  assert.equal((await s.login('alice@example.test', 'new-password-9')).statusCode, 200)
})

test('cross-origin writes are blocked, same-origin ones pass', async () => {
  const s = setup()
  const a = await s.register('alice')
  const put = (origin: string) =>
    s.app.inject({
      method: 'PUT',
      url: '/api/me/settings',
      headers: { cookie: a.cookie, origin, host: 'tot.example' },
      payload: { delaySec: 180 },
    })
  assert.equal((await put('https://evil.example')).statusCode, 403)
  assert.equal((await put('https://tot.example')).statusCode, 200)
})

test('behind a trusted proxy the origin is checked against X-Forwarded-Host', async () => {
  const app = buildApp(openDb(':memory:'), { trustProxy: true })
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'https://tot.example', host: '127.0.0.1:3000', 'x-forwarded-host': 'tot.example' },
    payload: { email: 'a@example.test', password: PASSWORD },
  })
  assert.equal(r.statusCode, 401) // reached the handler (bad credentials), not blocked as cross-origin
  const evil = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'https://evil.example', host: '127.0.0.1:3000', 'x-forwarded-host': 'tot.example' },
    payload: { email: 'a@example.test', password: PASSWORD },
  })
  assert.equal(evil.statusCode, 403)
})

test('API responses are never cacheable and carry basic hardening headers', async () => {
  const s = setup()
  for (const url of ['/api/leaderboard', '/api/me', '/api/posts']) {
    const r = await s.get(url)
    assert.equal(r.headers['cache-control'], 'no-store', url)
    assert.equal(r.headers['x-content-type-options'], 'nosniff', url)
    assert.equal(r.headers['referrer-policy'], 'no-referrer', url)
  }
})

test('the Secure flag is added when requested', async () => {
  const app = buildApp(openDb(':memory:'), { secureCookies: true })
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'a@example.test', handle: 'alice', password: PASSWORD },
  })
  assert.match(String(r.headers['set-cookie']), /; Secure/)
})
