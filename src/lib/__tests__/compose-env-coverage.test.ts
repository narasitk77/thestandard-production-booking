import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'

// v1.214 — every env var the code reads must be declared in the Portainer
// compose file, or be listed here with a reason.
//
// WHY THIS EXISTS. Four separate features shipped "working" and were not,
// because the operator set a variable on the stack and compose never passed it
// into the container. `process.env.X` was `undefined` inside the app, so:
//
//   • AUTH_SECRET (v1.212)   — every /api/internal/* caller holding it got 401
//     for months. The Hermes cron's own alert guessed "prod rotated the secret".
//     The secret was right the whole time; the destination never received it.
//   • MCP_* (v1.213)         — /api/mcp answered 503 since v1.49. Setting a key
//     in Portainer did nothing, and nothing said so.
//   • QU_REMINDER_* (v1.214) — the kill switch could not kill: setting
//     QU_REMINDER_ENABLED=0 left the sweep mailing producers.
//   • NAS_DSM_* (v1.214)     — video-merge never entered its sync-gated mode.
//
// Every one of these is invisible from the outside: the config looks right, the
// code looks right, and the two never meet. A unit test is the only place this
// is cheap to catch, so it is checked on every build rather than by a person
// remembering.
//
// WHAT A FAILURE MEANS. You added `process.env.SOMETHING` in src/ or scripts/.
// Either add it to docker-compose.portainer.yml — and make the default there
// match the code's own default EXACTLY — or add it to ALLOWED_UNDECLARED below
// with a reason. Both are fine; silence is not.
//
// ⚠️ ON MATCHING DEFAULTS. compose sends an EMPTY STRING, not "unset". That is
// the same thing only when the code falls through on falsy (`||`, `?.trim() ||`,
// `if (!raw)`). It is NOT the same when the code uses `??` (empty is not
// nullish) or a numeric guard like `n >= 0` — `Number('')` is 0, which passes.
// A real example caught while writing this: `${QU_REMINDER_URGENT_DAYS:-}`
// would have set the urgent window to 0 days, so no booking is ever urgent
// again, silently. When in doubt, repeat the code's default explicitly.

const REPO_ROOT = join(__dirname, '..', '..', '..')
const COMPOSE = join(REPO_ROOT, 'docker-compose.portainer.yml')

/**
 * Variables that legitimately never travel through the Portainer stack.
 * Each needs a reason — "it was already failing" is not one.
 */
const ALLOWED_UNDECLARED: Record<string, string> = {
  // Set by the runtime/image, not by the operator.
  NODE_ENV: 'set by Next.js / the Dockerfile',
  APP_GIT_SHA: 'baked in at image build time',
  npm_package_version: 'read from package.json by npm at runtime',

  // Inlined at build time by Next.js — a stack value would arrive too late.
  NEXT_PUBLIC_GOOGLE_CALENDAR_ID: 'NEXT_PUBLIC_* is compiled into the bundle',
  NEXT_PUBLIC_APP_URL: 'NEXT_PUBLIC_* is compiled into the bundle',

  // Belongs to the staging compose file, not this one.
  APP_ENV: 'set by docker-compose.staging.yml to mark the staging deploy',
  STAGING_ALLOW_CALENDAR: 'staging-only guard, lives in the staging compose',
  STAGING_ALLOW_SHEETS: 'staging-only guard, lives in the staging compose',

  // Per-worker endpoint overrides. Deliberately undeclared: each worker resolves
  // its own URL via scripts/lib/env.js appBaseUrl(), and the shared
  // WORKER_APP_URL — already declared — is the knob anyone actually turns.
  // Declaring these would suggest they are a normal thing to set. They are not.
  BACKUP_URL: 'worker endpoint override; use WORKER_APP_URL',
  VIDEO_MERGE_URL: 'worker endpoint override; use WORKER_APP_URL',
  SOUND_MERGE_URL: 'worker endpoint override; use WORKER_APP_URL',
  PREP_FOLDERS_URL: 'worker endpoint override; use WORKER_APP_URL',
  FOLDER_INTEGRITY_URL: 'worker endpoint override; use WORKER_APP_URL',
  FOOTAGE_READY_URL: 'worker endpoint override; use WORKER_APP_URL',
  LARK_EXPORT_URL: 'worker endpoint override; use WORKER_APP_URL',
  ROOM_BOOKING_URL: 'worker endpoint override; use WORKER_APP_URL',
  SHOOT_REVIEW_URL: 'worker endpoint override; use WORKER_APP_URL',

  // Provider API endpoints — constants with a test seam, never operator config.
  RESEND_API_URL: 'provider endpoint, overridden only by tests',
  SENDGRID_API_URL: 'provider endpoint, overridden only by tests',

  // scripts/import-workspace.ts is a one-off migration run by hand from a
  // laptop, never inside the container.
  EQUIP_SHEET_ID: 'one-off import script, run by hand',
  FINANCE_SHEET_ID: 'one-off import script, run by hand',
  VENDORS_TAB: 'one-off import script, run by hand',
  INVENTORY_TAB: 'one-off import script, run by hand',
  FIXED_ASSETS_TAB: 'one-off import script, run by hand',
  LOANS_TAB: 'one-off import script, run by hand',
  RENTAL_TABS: 'one-off import script, run by hand',
  PURCHASE_TABS: 'one-off import script, run by hand',
  REPAIR_TABS: 'one-off import script, run by hand',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '.next') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(full)
  }
  return out
}

/** Names the compose file declares, either as a key or as a ${VAR} reference. */
function declaredInCompose(): Set<string> {
  const text = readFileSync(COMPOSE, 'utf8')
  const names = new Set<string>()
  for (const m of text.matchAll(/^\s{4,}([A-Z][A-Z0-9_]*):\s/gm)) names.add(m[1])
  for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}]/g)) names.add(m[1])
  return names
}

/** Every `process.env.FOO` / `process.env['FOO']` in shipped code. */
function usedInCode(): Map<string, string> {
  const found = new Map<string, string>()
  for (const dir of ['src', 'scripts']) {
    for (const file of walk(join(REPO_ROOT, dir))) {
      const text = readFileSync(file, 'utf8')
      const rel = file.slice(REPO_ROOT.length + 1)
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        if (!found.has(m[1])) found.set(m[1], rel)
      }
      for (const m of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) {
        if (!found.has(m[1])) found.set(m[1], rel)
      }
    }
  }
  return found
}

/**
 * The compose file is deliberately NOT in the Docker build context —
 * `.dockerignore` drops `docker-compose*.yml` because the running app never
 * reads it, and that list is kept narrow on purpose. But the Dockerfile runs
 * `npm run build`, which runs `npm test`, so this test executes inside the image
 * build with the file absent. Left alone it fails there and takes the whole
 * image with it (caught on v1.215: CI green, "Build and Push Docker Image" red).
 *
 * So: skip when the file genuinely is not there, and say why in the output
 * rather than passing quietly. The guarantee is unaffected — CI and every local
 * `npm test` run with the file present, which is where a missing declaration
 * would be introduced in the first place. A silent `if (!exists) return` is what
 * would have made this guard worthless.
 */
const COMPOSE_MISSING = !existsSync(COMPOSE)
const SKIP_REASON =
  'docker-compose.portainer.yml is not in the Docker build context (.dockerignore). ' +
  'This guard runs in CI and locally, where the file is present.'

test('every env var the code reads is declared in the Portainer compose file', {
  skip: COMPOSE_MISSING ? SKIP_REASON : false,
}, () => {
  const declared = declaredInCompose()
  const used = usedInCode()

  const missing: string[] = []
  for (const [name, file] of used) {
    if (declared.has(name)) continue
    if (name in ALLOWED_UNDECLARED) continue
    missing.push(`${name}  (first read in ${file})`)
  }

  assert.deepEqual(
    missing,
    [],
    'These env vars are read by the code but never passed into the container, so ' +
      'setting them on the Portainer stack does nothing:\n  ' + missing.join('\n  ') +
      '\n\nAdd each to docker-compose.portainer.yml with a default that matches the ' +
      "code's own default, or list it in ALLOWED_UNDECLARED with a reason.",
  )
})

test('the allowlist does not rot — every entry is still read somewhere', () => {
  const used = usedInCode()
  const stale = Object.keys(ALLOWED_UNDECLARED).filter(
    (n) => !used.has(n) && n !== 'npm_package_version' && n !== 'NEXT_PUBLIC_APP_URL',
  )
  assert.deepEqual(
    stale,
    [],
    'ALLOWED_UNDECLARED lists names the code no longer reads — delete them: ' + stale.join(', '),
  )
})

test('the allowlist is documented — every entry carries a reason', () => {
  const blank = Object.entries(ALLOWED_UNDECLARED)
    .filter(([, reason]) => !reason || reason.trim().length < 10)
    .map(([name]) => name)
  assert.deepEqual(blank, [], 'every allowlist entry needs a real reason: ' + blank.join(', '))
})
