import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const T0 = Date.parse('2026-11-03T02:00:00.000Z')

test('posts, comments and search say whether the author is broker-verified (blue check)', async () => {
  const app = buildApp(openDb(':memory:'), { now: () => T0, minClosedTrades: 1, minSnapshots: 1 })
  const register = async (handle: string) => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!
    const key = (await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })).json().key as string
    return { cookie, key }
  }
  const alice = await register('alice')
  const bob = await register('bob')

  // Alice links a broker account (Level 2). Bob only posts (no broker account).
  await app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${alice.key}` },
    payload: { broker: 'shioaji', accountFingerprint: 'acct-a'.padEnd(32, 'x'), trades: [], snapshot: { takenAt: new Date(T0).toISOString(), cash: 0, positions: [] } },
  })
  const ap = (await app.inject({ method: 'POST', url: '/api/posts', headers: { cookie: alice.cookie }, payload: { body: 'hi' } })).json()
  const bp = (await app.inject({ method: 'POST', url: '/api/posts', headers: { cookie: bob.cookie }, payload: { body: 'hello' } })).json()
  assert.equal(ap.verified, true)
  assert.equal(bp.verified, false)

  await app.inject({ method: 'POST', url: `/api/posts/${bp.id}/comments`, headers: { cookie: alice.cookie }, payload: { body: 'nice' } })
  const detail = (await app.inject({ method: 'GET', url: `/api/posts/${bp.id}` })).json()
  assert.equal(detail.comments[0].verified, true)

  const found = (await app.inject({ method: 'GET', url: '/api/traders/search?q=a' })).json().results
  assert.equal(found.find((r: { handle: string }) => r.handle === 'alice').verified, true)
  const bobFound = (await app.inject({ method: 'GET', url: '/api/traders/search?q=bo' })).json().results
  assert.equal(bobFound.find((r: { handle: string }) => r.handle === 'bob').verified, false)
})
