// 2026-11-08 maintenance — env coverage PER SERVICE, not per file.
//
// compose-env-coverage.test.ts counts a name as declared if it appears ANYWHERE
// in docker-compose.portainer.yml, so it could not see that the `worker` service
// (profile `workers`, v1.168 — not on in prod yet) lacked what the worker scripts
// read: FOLDER_INTEGRITY_APPLY (→ report-only forever while health stays green),
// ROOM_BOOKING_WORKER_ENABLED (→ room reconcile exits), NAS_DSM_* (→ video-merge
// PLAIN mode), per-worker secrets (→ 401). Nor that RECONCILE_SECRET reached only
// the worker while the route that checks it runs in `app`, or that FEEDBACK_EMAIL
// existed only inside other vars' defaults. Two invariants:
//   1. a var a worker script reads and the app service declares → the worker
//      service declares it too (flipping it on the stack must reach both);
//   2. a var the worker service declares and src/ reads → the app declares it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..', '..')
const COMPOSE = join(ROOT, 'docker-compose.portainer.yml')
const SKIP = existsSync(COMPOSE) ? false
  : 'docker-compose.portainer.yml is not in the Docker build context (.dockerignore); runs in CI/locally'

/** Keys of one service's `environment:` block (comments ignored). */
function serviceEnv(service: string): Set<string> {
  const lines = readFileSync(COMPOSE, 'utf8').split('\n')
  const start = lines.findIndex((l) => l === `  ${service}:`)
  assert.ok(start >= 0, `service ${service} not found`)
  const keys = new Set<string>()
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) || /^ {2}\S/.test(l)) break   // next top-level key or next service
    const m = l.match(/^ {6}([A-Z][A-Z0-9_]*):/)
    if (m) keys.add(m[1])
  }
  return keys
}

/**
 * `process.env.X` reads, plus — with `secretNames` — `'X_SECRET'` string literals:
 * routes on internalSecretAllowed(req, header, ['A_SECRET', …]) read env by NAME.
 */
function envReads(files: string[], secretNames = false): Map<string, string> {
  const out = new Map<string, string>()
  const re = secretNames
    ? /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|['"]([A-Z][A-Z0-9_]*_SECRET)['"]/g
    : /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(re)) {
      const name = m[1] || m[2] || m[3]
      if (!out.has(name)) out.set(name, f.slice(ROOT.length + 1))
    }
  }
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js)$/.test(e.name)) out.push(p)
  }
  return out
}

test('every var a worker script reads that the app declares is declared on the worker service too', { skip: SKIP }, () => {
  const scripts = [
    ...readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('-worker.js')).map((f) => join(ROOT, 'scripts', f)),
    ...readdirSync(join(ROOT, 'scripts/lib')).filter((f) => f.endsWith('.js')).map((f) => join(ROOT, 'scripts/lib', f)),
  ]
  const app = serviceEnv('app')
  const worker = serviceEnv('worker')
  const missing = [...envReads(scripts)]
    .filter(([name]) => app.has(name) && !worker.has(name))
    .map(([name, file]) => `${name}  (read in ${file})`)
  assert.deepEqual(missing, [], 'worker service is missing:\n  ' + missing.join('\n  '))
})

test('every var the worker service declares that src/ reads is declared on the app service', { skip: SKIP }, () => {
  const app = serviceEnv('app')
  const worker = serviceEnv('worker')
  const src = envReads(walk(join(ROOT, 'src')), true)
  const missing = [...worker].filter((n) => src.has(n) && !app.has(n)).map((n) => `${n}  (read in ${src.get(n)})`)
  assert.deepEqual(missing, [], 'app service is missing:\n  ' + missing.join('\n  '))
})

test('FEEDBACK_EMAIL is passed into the app, not only used inside other defaults', { skip: SKIP }, () => {
  assert.ok(serviceEnv('app').has('FEEDBACK_EMAIL'))
})
