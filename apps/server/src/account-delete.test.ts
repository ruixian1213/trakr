import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const T0 = Date.parse('2026-11-03T02:00:00.000Z')

function harness() {
  const db = openDb(':memory:')
  const app = buildApp(db, { now: () => T0, minClosedTrades: 1, minSnapshots: 1 })
  const register = async (handle: string) => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `${handle}@example.test`, handle, password: 'correct-horse-1' } })
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!
    const key = (await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })).json().key as string
    return { cookie, key }
  }
  return { app, db, register }
}

test('deleting an account needs the password, removes the user’s data, and frees the ID', async () => {
  const h = harness()
  const alice = await h.register('alice')
  const bob = await h.register('bob')
  await h.app.inject({ method: 'POST', url: '/api/traders/alice/follow', headers: { cookie: bob.cookie } })
  await h.app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${alice.key}` },
    payload: {
      broker: 'shioaji',
      accountFingerprint: 'acct-a'.padEnd(32, 'x'),
      trades: [{ brokerTradeId: 'o1:1', symbol: '2330', side: 'buy', qty: 1000, price: 600, executedAt: new Date(T0).toISOString() }],
      snapshot: { takenAt: new Date(T0).toISOString(), cash: 0, positions: [{ symbol: '2330', qty: 1000, avgPrice: 600, lastPrice: 600 }] },
    },
  })

  // Wrong password: nothing happens.
  const wrong = await h.app.inject({ method: 'POST', url: '/api/me/delete', headers: { cookie: alice.cookie }, payload: { password: 'nope-nope-nope' } })
  assert.equal(wrong.statusCode, 403)
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: alice.cookie } })).statusCode, 200)

  // Correct password: account and data are gone.
  const ok = await h.app.inject({ method: 'POST', url: '/api/me/delete', headers: { cookie: alice.cookie }, payload: { password: 'correct-horse-1' } })
  assert.equal(ok.statusCode, 200)
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: alice.cookie } })).statusCode, 401, 'old session is dead')
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/traders/alice' })).statusCode, 404)
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM trades').get()!.n, 0)
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()!.n, 0)
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()!.n, 1, 'only bob’s key remains')
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM follows').get()!.n, 0)
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n, 0)

  // Bob is untouched, and the handle can be registered again by someone else.
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: bob.cookie } })).statusCode, 200)
  const again = await h.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'new-alice@example.test', handle: 'alice', password: 'correct-horse-1' } })
  assert.equal(again.statusCode, 200)
})

test('deleting requires a signed-in session', async () => {
  const h = harness()
  const res = await h.app.inject({ method: 'POST', url: '/api/me/delete', payload: { password: 'correct-horse-1' } })
  assert.equal(res.statusCode, 401)
})
