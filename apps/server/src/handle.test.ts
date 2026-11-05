import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

function setup() {
  const db = openDb(':memory:')
  const app = buildApp(db)
  let n = 0
  // Every call gets its own valid email, so a test about IDs is never decided by the email check.
  const register = (handle: unknown, email = `user${++n}@example.test`, password = 'correct-horse-1') =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, handle, password } })
  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })
  return { db, app, register, get }
}

test('"Alice", "alice" and "ALICE" are one ID: only the first can register', async () => {
  const s = setup()
  const first = await s.register('Alice')
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().handle, 'Alice', 'the spelling the person chose is kept for display')

  for (const variant of ['alice', 'ALICE', 'aLiCe']) {
    const r = await s.register(variant)
    assert.equal(r.statusCode, 409, variant)
    assert.equal(r.json().code, 'handle_taken', variant)
  }
})

test("IDs are found regardless of capitalisation, and show the owner's spelling", async () => {
  const s = setup()
  await s.register('Alice')
  for (const path of ['Alice', 'alice', 'ALICE']) {
    const r = await s.get(`/api/traders/${path}`)
    assert.equal(r.statusCode, 200, path)
    assert.equal(r.json().handle, 'Alice')
  }
  assert.equal((await s.get('/api/traders/nobody')).statusCode, 404)
})

test('reserved and malformed IDs are refused with a reason the form can show', async () => {
  const s = setup()
  for (const reserved of ['admin', 'Admin', 'tot', 'trakr', 'trakr_official', 'admin2', 'support', 'twse', 'null']) {
    const r = await s.register(reserved)
    assert.equal(r.statusCode, 400, reserved)
    assert.equal(r.json().code, 'handle_reserved', reserved)
  }
  for (const bad of ['ab', 'x'.repeat(21), 'has space', 'dot.ted', '中文名字', 'аlice', '', undefined, 42]) {
    const r = await s.register(bad)
    assert.equal(r.statusCode, 400, String(bad))
    assert.equal(r.json().code, 'handle_format', String(bad))
  }
  assert.equal((await s.register('alice_admin')).statusCode, 200, 'containing a reserved word is fine')
})

test('the availability check reports every outcome, without regard to case', async () => {
  const s = setup()
  await s.register('Alice')
  const check = async (h: string) => (await s.get(`/api/auth/handle-available?handle=${encodeURIComponent(h)}`)).json()

  assert.deepEqual(await check('fresh_name'), { available: true })
  for (const taken of ['Alice', 'alice', 'ALICE']) {
    const r = await check(taken)
    assert.equal(r.available, false, taken)
    assert.equal(r.reason, 'taken', taken)
  }
  assert.equal((await check('admin')).reason, 'reserved')
  assert.equal((await check('ab')).reason, 'format')
  assert.equal((await check('')).reason, 'format')
  assert.match((await check('Alice')).message, /已經有人使用/)
})

test('the availability check is rate limited', async () => {
  const s = setup()
  for (let i = 0; i < 60; i++) assert.equal((await s.get('/api/auth/handle-available?handle=abc')).statusCode, 200)
  assert.equal((await s.get('/api/auth/handle-available?handle=abc')).statusCode, 429)
})

test('two sign-ups for the same ID at the same instant: exactly one wins, the other gets "taken" and not a crash', async () => {
  const s = setup()
  const [a, b] = await Promise.all([s.register('racer', 'one@example.test'), s.register('Racer', 'two@example.test')])
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409])
  const loser = a.statusCode === 409 ? a : b
  assert.equal(loser.json().code, 'handle_taken')
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1)
})

test('two sign-ups with the same email at the same instant also resolve cleanly', async () => {
  const s = setup()
  const [a, b] = await Promise.all([s.register('first_one', 'same@example.test'), s.register('second_one', 'same@example.test')])
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409])
  assert.equal((a.statusCode === 409 ? a : b).json().code, 'email_taken')
})

test('the database itself refuses a case-variant duplicate, whatever the application does', async () => {
  const s = setup()
  await s.register('Alice')
  const insert = () =>
    s.db
      .prepare('INSERT INTO users (email, handle, handle_lc, password_hash, created_ms) VALUES (?, ?, ?, ?, ?)')
      .run('x@example.test', 'ALICE', 'alice', 'hash', 1)
  assert.throws(insert, /UNIQUE/)
})

test('an ID cannot be changed through any settings endpoint', async () => {
  const s = setup()
  const r = await s.register('stable_id')
  const cookie = String(r.headers['set-cookie']).split(';')[0]!
  const h = { cookie }
  await s.app.inject({ method: 'PUT', url: '/api/me/settings', headers: h, payload: { handle: 'hijacked', delaySec: 300 } })
  await s.app.inject({ method: 'PUT', url: '/api/me/profile', headers: h, payload: { handle: 'hijacked', bio: 'x' } })
  assert.equal((await s.get('/api/me', cookie)).json().handle, 'stable_id')
  assert.equal((await s.get('/api/traders/hijacked')).statusCode, 404)
})

test('public profiles expose the ID but never the email, the case key or an internal id', async () => {
  const s = setup()
  await s.register('Alice', 'private@example.test')
  const body = (await s.get('/api/traders/alice')).body
  assert.ok(!body.includes('private@example.test'))
  assert.ok(!body.includes('handle_lc'))
  assert.ok(!/"id"\s*:/.test(body), 'no internal numeric id')
})

// ---------- migrating a database from before IDs were case-insensitive ----------

function oldDatabase(path: string, handles: string[]) {
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    delay_sec INTEGER NOT NULL DEFAULT 300, holdings_visibility TEXT NOT NULL DEFAULT 'public',
    last_sync_ms INTEGER, created_ms INTEGER NOT NULL)`)
  const ins = old.prepare('INSERT INTO users (email, handle, password_hash, created_ms) VALUES (?, ?, ?, ?)')
  handles.forEach((h, i) => ins.run(`u${i}@example.test`, h, 'hash', 1))
  old.close()
}

/** Runs a test body against a scratch directory, closing databases before deleting it (Windows locks open files). */
async function inScratchDir(body: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'tot-'))
  try {
    await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('an older database is upgraded in place: IDs keep their spelling and gain a unique lower-case key', async () => {
  await inScratchDir(async (dir) => {
    const path = join(dir, 'old.db')
    oldDatabase(path, ['Alice', 'bob', 'admin'])
    const db = openDb(path)
    try {
      const rows = db.prepare('SELECT handle, handle_lc FROM users ORDER BY id').all() as { handle: string; handle_lc: string }[]
      assert.deepEqual(rows.map((r) => [r.handle, r.handle_lc]), [['Alice', 'alice'], ['bob', 'bob'], ['admin', 'admin']])
      const indexes = db.prepare("SELECT name FROM pragma_index_list('users')").all() as { name: string }[]
      assert.ok(indexes.some((i) => i.name === 'users_handle_lc'))

      const app = buildApp(db)
      // Existing accounts keep working, even one whose ID would now be reserved...
      assert.equal((await app.inject({ method: 'GET', url: '/api/traders/ADMIN' })).statusCode, 200)
      // ...while new sign-ups cannot take a variant of an existing ID.
      const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'n@example.test', handle: 'ALICE', password: 'correct-horse-1' } })
      assert.equal(dup.statusCode, 409)
    } finally {
      db.close()
    }
  })
})

test('an older database containing two spellings of one ID refuses to start and says which', async () => {
  await inScratchDir((dir) => {
    const path = join(dir, 'clash.db')
    oldDatabase(path, ['Alice', 'alice', 'bob'])
    assert.throws(() => openDb(path), /more than one capitalisation: alice/)
    // The failed start must not leave the file locked: opening it as a plain database still works.
    new DatabaseSync(path).close()
  })
})

test('opening an already-upgraded database again changes nothing', async () => {
  await inScratchDir((dir) => {
    const path = join(dir, 'twice.db')
    oldDatabase(path, ['Alice'])
    openDb(path).close()
    const again = openDb(path)
    try {
      assert.equal((again.prepare('SELECT handle_lc FROM users').get() as { handle_lc: string }).handle_lc, 'alice')
    } finally {
      again.close()
    }
  })
})
