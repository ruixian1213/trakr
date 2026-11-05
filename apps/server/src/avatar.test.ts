import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'
import { avatarProblem, inspectImage } from './image.ts'

/** A structurally valid JPEG header with the given declared size. Enough for signature and dimension checks. */
function jpeg(width: number, height: number, padTo = 0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.alloc(19)
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08])
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof.set([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 9)
  const parts = [Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(Math.max(0, padTo - 40)), Buffer.from([0xff, 0xd9])]
  return Buffer.concat(parts)
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr.set([8, 2, 0, 0, 0], 16)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])])
}

function setup() {
  let clock = Date.parse('2026-11-03T01:00:00.000Z')
  const app = buildApp(openDb(':memory:'), { now: () => clock })
  async function register(handle: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    return String(r.headers['set-cookie']).split(';')[0]!
  }
  const put = (cookie: string | undefined, body: Buffer | string, type = 'image/jpeg') =>
    app.inject({ method: 'PUT', url: '/api/me/avatar', payload: body, headers: { 'content-type': type, ...(cookie ? { cookie } : {}) } })
  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })
  return { app, register, put, get, advance: (ms: number) => (clock += ms) }
}

test('inspectImage reads type and size from the bytes, not from any claim', () => {
  assert.deepEqual(inspectImage(jpeg(256, 256)), { mime: 'image/jpeg', width: 256, height: 256 })
  assert.deepEqual(inspectImage(png(300, 200)), { mime: 'image/png', width: 300, height: 200 })
  assert.equal(inspectImage(Buffer.from('<html><script>alert(1)</script></html>')), null)
  assert.equal(inspectImage(Buffer.from('GIF89a\x01\x00\x01\x00')), null)
  assert.equal(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
})

test('truncated or malformed images are rejected rather than crashing the parser', () => {
  assert.equal(inspectImage(Buffer.from([0xff, 0xd8])), null)
  assert.equal(inspectImage(jpeg(256, 256).subarray(0, 25)), null)
  assert.equal(inspectImage(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00])), null) // not a marker
  assert.equal(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00])), null) // scan before any frame header
  assert.equal(inspectImage(png(10, 10).subarray(0, 20)), null)
  assert.equal(inspectImage(Buffer.alloc(0)), null)
})

test('size limits: too small, too large a canvas, too many bytes', () => {
  assert.equal(avatarProblem(jpeg(256, 256)), null)
  assert.match(avatarProblem(jpeg(16, 16))!, /太小/)
  assert.match(avatarProblem(jpeg(5000, 5000))!, /尺寸過大/)
  assert.match(avatarProblem(jpeg(65535, 65535))!, /尺寸過大/)
  assert.match(avatarProblem(jpeg(256, 256, 250_000))!, /太大/)
})

test('a signed-in user uploads a photo and anyone can fetch it with hardened headers', async () => {
  const s = setup()
  const a = await s.register('alice')
  const img = jpeg(256, 256, 2000)
  const up = await s.put(a, img)
  assert.equal(up.statusCode, 200)
  const v = up.json().avatarV as number
  assert.ok(v > 0)

  const res = await s.get(`/api/users/alice/avatar?v=${v}`) // no login needed
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/jpeg')
  assert.ok(res.rawPayload.equals(img))
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.match(String(res.headers['content-security-policy']), /sandbox/)
  assert.match(String(res.headers['cache-control']), /immutable/, 'a URL with the current version is cached forever')
  assert.match(String((await s.get('/api/users/alice/avatar?v=1')).headers['cache-control']), /max-age=300/, 'an old version link is cached briefly')
})

test('the stored type follows the file signature even if the client lies about it', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.put(a, png(256, 256), 'image/jpeg')).statusCode, 200)
  assert.equal((await s.get('/api/users/alice/avatar')).headers['content-type'], 'image/png')
})

test('disguised and unsupported uploads are refused', async () => {
  const s = setup()
  const a = await s.register('alice')
  assert.equal((await s.put(a, '<html><script>alert(1)</script></html>', 'image/jpeg')).statusCode, 400)
  assert.equal((await s.put(a, 'GIF89a\x01\x00\x01\x00', 'image/jpeg')).statusCode, 400)
  assert.equal((await s.put(a, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'image/svg+xml')).statusCode, 415)
  assert.equal((await s.put(a, jpeg(5000, 5000))).statusCode, 400)
  assert.equal((await s.put(a, jpeg(16, 16))).statusCode, 400)
  assert.equal((await s.put(a, Buffer.alloc(300_000, 1))).statusCode, 413)
  assert.equal((await s.get('/api/users/alice/avatar')).statusCode, 404, 'nothing was stored by any failed attempt')
})

test('uploading requires login and a user only changes their own photo', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bobby')
  assert.equal((await s.put(undefined, jpeg(256, 256))).statusCode, 401)
  assert.equal((await s.app.inject({ method: 'DELETE', url: '/api/me/avatar' })).statusCode, 401)

  await s.put(a, jpeg(256, 256))
  await s.app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: { cookie: b } })
  assert.equal((await s.get('/api/users/alice/avatar')).statusCode, 200, "bobby's delete must not touch alice's photo")
})

test('replacing bumps the version; deleting removes the photo', async () => {
  const s = setup()
  const a = await s.register('alice')
  const v1 = (await s.put(a, jpeg(256, 256))).json().avatarV
  s.advance(1000)
  const v2 = (await s.put(a, png(256, 256))).json().avatarV
  assert.ok(v2 > v1)
  assert.equal((await s.get('/api/users/alice/avatar')).headers['content-type'], 'image/png')

  const del = await s.app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: { cookie: a } })
  assert.equal(del.json().avatarV, null)
  assert.equal((await s.get('/api/users/alice/avatar')).statusCode, 404)
  assert.equal((await s.get('/api/users/nobody/avatar')).statusCode, 404)
})

test('the photo version appears wherever a person is shown, so the UI never requests a missing photo', async () => {
  const s = setup()
  const a = await s.register('alice')
  const b = await s.register('bobby')
  const v = (await s.put(a, jpeg(256, 256))).json().avatarV

  assert.equal((await s.get('/api/me', a)).json().avatarV, v)
  assert.equal((await s.get('/api/traders/alice')).json().avatarV, v)
  assert.equal((await s.get('/api/traders/bobby')).json().avatarV, null)

  const post = await s.app.inject({ method: 'POST', url: '/api/posts', headers: { cookie: a }, payload: { body: 'hello' } })
  assert.equal(post.json().avatarV, v)
  assert.equal((await s.get('/api/posts')).json().posts[0].avatarV, v)
  await s.app.inject({ method: 'POST', url: `/api/posts/${post.json().id}/comments`, headers: { cookie: b }, payload: { body: 'hi' } })
  const detail = (await s.get(`/api/posts/${post.json().id}`)).json()
  assert.equal(detail.post.avatarV, v)
  assert.equal(detail.comments[0].avatarV, null)
})

test('uploads are rate limited per user', async () => {
  const s = setup()
  const a = await s.register('alice')
  for (let i = 0; i < 10; i++) assert.equal((await s.put(a, jpeg(256, 256))).statusCode, 200)
  assert.equal((await s.put(a, jpeg(256, 256))).statusCode, 429)
  s.advance(61 * 60_000)
  assert.equal((await s.put(a, jpeg(256, 256))).statusCode, 200)
})
