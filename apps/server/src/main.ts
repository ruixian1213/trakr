import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import { buildApp } from './app.ts'
import { openDb } from './db.ts'

const dbPath = process.env.TOT_DB ?? './data/tot.db'
mkdirSync(dirname(dbPath), { recursive: true })

const app = buildApp(openDb(dbPath), {
  secureCookies: process.env.NODE_ENV === 'production',
  trustProxy: process.env.TOT_TRUST_PROXY === '1',
  autoSync: true,
})

// Serve the built web app from the same origin as the API, so the login cookie works without CORS.
// Unknown non-API GET paths fall back to index.html, so direct links to client routes still load.
const webDir = resolve(process.env.TOT_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url)))
if (existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir, prefix: '/' })
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html')
    return reply.code(404).send({ error: 'not found' })
  })
} else {
  console.warn(`web build not found at ${webDir}; serving the API only`)
}

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' })
console.log(`tot server listening on :${port} (db: ${dbPath}, web: ${existsSync(webDir) ? webDir : 'none'})`)
