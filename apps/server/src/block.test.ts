import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const T0 = Date.parse('2026-11-03T02:00:00.000Z')

function harness() {
  const app = buildApp(openDb(':memory:'), { now: () => T0, minClosedTrades: 1, minSnapshots: 1 })
  const register = async (handle: string) => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    return { cookie: String(reg.headers['set-cookie']).split(';')[0]! }
  }
  return { app, register }
}

test('blocking hides both sides from each other: posts, comments, trades, profile, search and follows', async () => {
  const h = harness()
  const alice = await h.register('alice')
  const bob = await h.register('bob')
  const carol = await h.register('carol')
  const get = (url: string, cookie?: string) => h.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })
  const post = (url: string, cookie: string, payload?: object) => h.app.inject({ method: 'POST', url, headers: { cookie }, payload })

  // Alice posts, bob comments, and bob follows alice.
  const created = (await post('/api/posts', alice.cookie, { body: 'alice post' })).json()
  await post(`/api/posts/${created.id}/comments`, bob.cookie, { body: 'bob comment' })
  await post('/api/traders/alice/follow', bob.cookie)
  assert.equal((await get('/api/traders/alice')).json().followers, 1)

  // Bob blocks alice.
  const blockRes = await post('/api/traders/alice/block', bob.cookie)
  assert.equal(blockRes.statusCode, 200)
  assert.equal(blockRes.json().blocked, true)

  // The follow is gone in the blocker's direction.
  assert.equal((await get('/api/traders/alice')).json().followers, 0)
  assert.equal((await get('/api/feed', bob.cookie)).statusCode, 200)

  // Bob no longer sees alice's post, its comments, or alice in search.
  const bobPosts = (await get('/api/posts', bob.cookie)).json().posts.map((p: { id: number }) => p.id)
  assert.ok(!bobPosts.includes(created.id))
  assert.equal((await get(`/api/posts/${created.id}`, bob.cookie)).statusCode, 404)
  assert.deepEqual((await get('/api/traders/search?q=ali', bob.cookie)).json().results, [])

  // Alice cannot see bob at all (bob blocked her): profile, trades, holdings are 404.
  assert.equal((await get('/api/traders/bob', alice.cookie)).statusCode, 404)
  assert.equal((await get('/api/traders/bob/trades', alice.cookie)).statusCode, 404)
  assert.equal((await get('/api/traders/bob/holdings', alice.cookie)).statusCode, 404)
  // ...and bob's comment is hidden from alice too.
  const alicePostView = (await get(`/api/posts/${created.id}`, alice.cookie)).json()
  assert.equal(alicePostView.comments.length, 0)

  // Carol is not involved and still sees everything.
  assert.ok((await get('/api/posts', carol.cookie)).json().posts.map((p: { id: number }) => p.id).includes(created.id))
  assert.equal((await get(`/api/posts/${created.id}`, carol.cookie)).json().comments.length, 1)

  // Alice cannot follow bob while blocked, in either direction.
  assert.equal((await post('/api/traders/bob/follow', alice.cookie)).statusCode, 403)
  assert.equal((await post('/api/traders/alice/follow', bob.cookie)).statusCode, 403)
})

test('the blocker can still see the blocked trader’s profile to unblock them, and unblocking restores visibility', async () => {
  const h = harness()
  const alice = await h.register('alice')
  const bob = await h.register('bob')
  const get = (url: string, cookie?: string) => h.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })
  const post = (url: string, cookie: string, payload?: object) => h.app.inject({ method: 'POST', url, headers: { cookie }, payload })

  await post('/api/traders/alice/block', bob.cookie)
  const profile = (await get('/api/traders/alice', bob.cookie)).json()
  assert.equal(profile.blocked, true)
  assert.deepEqual((await get('/api/me/blocks', bob.cookie)).json().blocked.map((b: { handle: string }) => b.handle), ['alice'])
  assert.equal((await get('/api/traders/alice/trades', bob.cookie)).statusCode, 404)

  const off = await h.app.inject({ method: 'DELETE', url: '/api/traders/alice/block', headers: { cookie: bob.cookie } })
  assert.equal(off.json().blocked, false)
  assert.equal((await get('/api/traders/bob', alice.cookie)).statusCode, 200)
  assert.equal((await get('/api/traders/alice/trades', bob.cookie)).statusCode, 200)
  assert.deepEqual((await get('/api/me/blocks', bob.cookie)).json().blocked, [])
})

test('you cannot block yourself, and blocking needs a signed-in session', async () => {
  const h = harness()
  const alice = await h.register('alice')
  const self = await h.app.inject({ method: 'POST', url: '/api/traders/alice/block', headers: { cookie: alice.cookie } })
  assert.equal(self.statusCode, 400)
  const anon = await h.app.inject({ method: 'POST', url: '/api/traders/alice/block' })
  assert.equal(anon.statusCode, 401)
})
