import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// window.confirm / alert / prompt are suppressed by in-app browsers and webviews, which answer
// "cancel" instantly. Any action guarded by confirm() then silently does nothing. That is how the
// delete and remove-photo buttons ended up looking fake. Use confirmAction() and showToast() instead.

const dir = dirname(fileURLToPath(import.meta.url))

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('no source file calls window.confirm, alert or prompt', () => {
  const offenders: string[] = []
  for (const file of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(file) || file.endsWith('.test.ts')) continue
    const code = stripComments(readFileSync(join(dir, file), 'utf8'))
    // "confirmAction(" does not match: after "confirm" comes a letter, not "(".
    for (const m of code.matchAll(/\b(?:window\.)?(confirm|alert|prompt)\s*\(/g)) offenders.push(`${file}: ${m[0]}`)
  }
  assert.deepEqual(offenders, [], 'use confirmAction() / showToast() from ui.tsx')
})

test('the dialog host is mounted so confirmAction can actually show something', () => {
  const app = readFileSync(join(dir, 'App.tsx'), 'utf8')
  assert.match(app, /<DialogHost\s*\/>/)
})

test('every mutating button handler is guarded by attempt() or its own try/catch', () => {
  // A rejected promise inside a click handler is invisible to the user. Calls that send DELETE or
  // PUT from the UI must report failure somehow.
  const unguarded: string[] = []
  for (const file of ['App.tsx', 'Forum.tsx', 'Market.tsx', 'Profile.tsx']) {
    const lines = stripComments(readFileSync(join(dir, file), 'utf8')).split('\n')
    lines.forEach((line, i) => {
      if (!/method:\s*'(DELETE|PUT)'/.test(line)) return
      // Look a few lines back for attempt( or an enclosing try {.
      const context = lines.slice(Math.max(0, i - 6), i + 1).join('\n')
      if (!/attempt\(|\btry\s*\{/.test(context)) unguarded.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(unguarded, [])
})
