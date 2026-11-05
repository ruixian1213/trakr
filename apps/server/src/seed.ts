// Fills the database with SYNTHETIC demo traders so the UI has something to show.
// Nothing here comes from a broker. Run against a throwaway DB: `npm run seed`.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const dbPath = process.env.TOT_DB ?? './data/tot.db'
mkdirSync(dirname(dbPath), { recursive: true })

const DEMO_PASSWORD = 'demo-password-1' // demo accounts only; never reuse for a real one
let clock = Date.now() - 6 * 3600_000
const app = buildApp(openDb(dbPath), { now: () => clock })

let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

const demo = [
  { handle: 'demo_alpha', symbol: '2330', edge: 0.012 },
  { handle: 'demo_beta', symbol: '2317', edge: 0.004 },
  { handle: 'demo_gamma', symbol: '0050', edge: -0.006 },
]

for (const d of demo) {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: `${d.handle}@example.test`, handle: d.handle, password: DEMO_PASSWORD },
  })
  if (reg.statusCode !== 200) {
    console.log(`${d.handle}: ${reg.json().error} (skipped; use a fresh DB to reseed)`)
    continue
  }
  const cookie = String(reg.headers['set-cookie']).split(';')[0]!
  const key = (await app.inject({ method: 'POST', url: '/api/me/agent-keys', headers: { cookie } })).json().key as string
  const headers = { authorization: `Bearer ${key}` }
  const iso = (ms = clock) => new Date(ms).toISOString()
  const base = { broker: 'demo', accountFingerprint: `demo-${d.handle}`.padEnd(32, '0') }
  const send = (payload: object) => app.inject({ method: 'POST', url: '/api/ingest', headers, payload: { ...base, ...payload } })

  let cash = 1_000_000
  await send({ snapshot: { takenAt: iso(), cash, positions: [] } })
  const qty = 1000
  for (let i = 0; i < 6; i++) {
    clock += 10 * 60_000
    const buy = Math.round((100 + rand() * 20) * 10) / 10
    cash -= qty * buy
    await send({
      trades: [{ brokerTradeId: `${d.handle}-b${i}`, symbol: d.symbol, side: 'buy', qty, price: buy, executedAt: iso() }],
      snapshot: { takenAt: iso(clock + 1000), cash, positions: [{ symbol: d.symbol, qty, avgPrice: buy, lastPrice: buy }] },
    })
    clock += 10 * 60_000
    const sell = Math.round(buy * (1 + d.edge + (rand() - 0.5) * 0.04) * 10) / 10
    cash += qty * sell * (1 - (d.symbol.startsWith('00') ? 0.001 : 0.003))
    await send({
      trades: [{ brokerTradeId: `${d.handle}-s${i}`, symbol: d.symbol, side: 'sell', qty, price: sell, executedAt: iso() }],
      snapshot: { takenAt: iso(clock + 1000), cash, positions: [] },
    })
  }
  console.log(`${d.handle}: log in as ${d.handle}@example.test / ${DEMO_PASSWORD}`)
}
