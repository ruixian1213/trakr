import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const MIN = 60_000

function setup() {
  let clock = Date.parse('2026-11-03T01:00:00.000Z')
  const app = buildApp(openDb(':memory:'), { now: () => clock })
  const advance = (ms: number) => (clock += ms)

  async function register(handle: string) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' },
    })
    return { cookie: String(r.headers['set-cookie']).split(';')[0]! }
  }
  type U = Awaited<ReturnType<typeof register>>
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, who?: U, payload?: object) => {
    const res = await app.inject({ method, url, payload, headers: who ? { cookie: who.cookie } : {} })
    return { status: res.statusCode, body: res.json() as any }
  }
  return { register, call, advance }
}

test('anyone can read the forum, only signed-in users can post', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.call('POST', '/api/posts', undefined, { body: 'hi' })).status, 401)
  const made = await s.call('POST', '/api/posts', a, { body: '今天大盤怎麼看？' })
  assert.equal(made.status, 200)
  assert.equal(made.body.handle, 'alice')
  assert.equal(made.body.mine, true)

  const list = await s.call('GET', '/api/posts')
  assert.equal(list.body.posts.length, 1)
  assert.equal(list.body.posts[0].mine, false)
  assert.equal(list.body.posts[0].body, '今天大盤怎麼看？')
})

test('post bodies are validated and trimmed', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.call('POST', '/api/posts', a, { body: '   ' })).status, 400)
  assert.equal((await s.call('POST', '/api/posts', a, { body: 'x'.repeat(501) })).status, 400)
  assert.equal((await s.call('POST', '/api/posts', a, { body: 42 })).status, 400)
  const ok = await s.call('POST', '/api/posts', a, { body: '  hello  ' })
  assert.equal(ok.body.body, 'hello')
})

test('markup is stored as plain text, never interpreted by the server', async () => {
  const s = setup()
  const a = await s.register('alice')
  const r = await s.call('POST', '/api/posts', a, { body: '<script>alert(1)</script>' })
  assert.equal(r.body.body, '<script>alert(1)</script>') // the web app renders it as text
})

test('posts are newest first and paginate with before', async () => {
  const s = setup()
  const a = await s.register('alice')
  for (let i = 1; i <= 3; i++) await s.call('POST', '/api/posts', a, { body: `p${i}` })
  const all = (await s.call('GET', '/api/posts')).body.posts
  assert.deepEqual(all.map((p: any) => p.body), ['p3', 'p2', 'p1'])
  const older = (await s.call('GET', `/api/posts?before=${all[0].id}&limit=1`)).body.posts
  assert.deepEqual(older.map((p: any) => p.body), ['p2'])
})

test('comments appear on the post and count toward commentCount', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bob')
  const post = (await s.call('POST', '/api/posts', a, { body: 'question' })).body
  assert.equal((await s.call('POST', `/api/posts/${post.id}/comments`, undefined, { body: 'x' })).status, 401)
  assert.equal((await s.call('POST', `/api/posts/${post.id}/comments`, b, { body: 'answer' })).status, 200)
  assert.equal((await s.call('POST', '/api/posts/9999/comments', b, { body: 'x' })).status, 404)

  const detail = (await s.call('GET', `/api/posts/${post.id}`, b)).body
  assert.equal(detail.comments.length, 1)
  assert.equal(detail.comments[0].mine, true)
  assert.equal(detail.post.commentCount, 1)
})

test('only the author can delete a post or comment', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bob')
  const post = (await s.call('POST', '/api/posts', a, { body: 'mine' })).body
  const cid = (await s.call('POST', `/api/posts/${post.id}/comments`, b, { body: 'bobs' })).body.id

  assert.equal((await s.call('DELETE', `/api/posts/${post.id}`, b)).status, 404)
  assert.equal((await s.call('DELETE', `/api/comments/${cid}`, a)).status, 404)
  assert.equal((await s.call('DELETE', `/api/comments/${cid}`, b)).status, 200)
  assert.equal((await s.call('GET', `/api/posts/${post.id}`)).body.comments.length, 0)
  assert.equal((await s.call('DELETE', `/api/posts/${post.id}`, a)).status, 200)
  assert.equal((await s.call('GET', `/api/posts/${post.id}`)).status, 404)
  assert.equal((await s.call('GET', '/api/posts')).body.posts.length, 0)
})

test('three distinct reports hide a post; duplicates and bad targets do not count', async () => {
  const s = setup()
  const author = await s.register('author')
  const r1 = await s.register('rep1')
  const r2 = await s.register('rep2')
  const r3 = await s.register('rep3')
  const post = (await s.call('POST', '/api/posts', author, { body: 'spam' })).body
  const report = (who: any) => s.call('POST', '/api/report', who, { type: 'post', id: post.id, reason: 'spam' })

  assert.equal((await s.call('POST', '/api/report', undefined, { type: 'post', id: post.id })).status, 401)
  assert.equal((await s.call('POST', '/api/report', r1, { type: 'nope', id: 1 })).status, 400)
  assert.equal((await s.call('POST', '/api/report', r1, { type: 'post', id: 9999 })).status, 404)

  await report(r1)
  await report(r1) // same user twice is still one report
  await report(r2)
  assert.equal((await s.call('GET', '/api/posts')).body.posts.length, 1)
  await report(r3)
  assert.equal((await s.call('GET', '/api/posts')).body.posts.length, 0)
  assert.equal((await s.call('GET', `/api/posts/${post.id}`)).status, 404)
})

test('reported comments are hidden the same way', async () => {
  const s = setup()
  const a = await s.register('alice')
  const users = [await s.register('user1'), await s.register('user2'), await s.register('user3')]
  const post = (await s.call('POST', '/api/posts', a, { body: 'topic' })).body
  const cid = (await s.call('POST', `/api/posts/${post.id}/comments`, a, { body: 'bad comment' })).body.id
  for (const u of users) assert.equal((await s.call('POST', '/api/report', u, { type: 'comment', id: cid })).status, 200)
  const detail = (await s.call('GET', `/api/posts/${post.id}`)).body
  assert.equal(detail.comments.length, 0)
  assert.equal(detail.post.commentCount, 0)
})

test('posting is rate limited per user', async () => {
  const s = setup()
  const a = await s.register('alice')
  for (let i = 0; i < 10; i++) assert.equal((await s.call('POST', '/api/posts', a, { body: `p${i}` })).status, 200)
  assert.equal((await s.call('POST', '/api/posts', a, { body: 'one too many' })).status, 429)
  s.advance(11 * MIN)
  assert.equal((await s.call('POST', '/api/posts', a, { body: 'ok again' })).status, 200)
})
