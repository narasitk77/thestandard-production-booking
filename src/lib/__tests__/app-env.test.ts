// v1.159 — staging guardrails. These tests pin the fail-closed contract:
// a staging stack must be UNABLE to reach production resources, and every
// guard must be a strict no-op outside staging.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  isStaging, stagingDriveViolation, assertStagingDriveIsolation,
  stagingBlocksCalendar, PROD_DRIVE_IDS,
  stagingOptionalDriveViolation, stagingBlocksTarget,
} from '../app-env'

const ENV_KEYS = ['APP_ENV', 'DRIVE_FOOTAGE_ROOT', 'DRIVE_PRODUCTION_TEAM_ROOT', 'DRIVE_PHOTO_ROOT', 'STAGING_ALLOW_CALENDAR']
const saved: Record<string, string | undefined> = {}
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

// ── the pure check ───────────────────────────────────────────────────────────

test('a missing root is a violation (fail-closed against hardcoded prod fallbacks)', () => {
  const v = stagingDriveViolation({ DRIVE_FOOTAGE_ROOT: 'staging-id', DRIVE_PHOTO_ROOT: undefined })
  assert.match(v!, /DRIVE_PHOTO_ROOT/)
  assert.match(v!, /not set/)
})

test('every known production drive id is rejected by name', () => {
  for (const prodId of PROD_DRIVE_IDS) {
    const v = stagingDriveViolation({ DRIVE_FOOTAGE_ROOT: prodId })
    assert.match(v!, /PRODUCTION drive/)
  }
})

test('a full set of non-prod ids passes', () => {
  assert.equal(stagingDriveViolation({
    DRIVE_FOOTAGE_ROOT: '0AStaging111111111',
    DRIVE_PRODUCTION_TEAM_ROOT: '0AStaging222222222',
    DRIVE_PHOTO_ROOT: '0AStaging333333333',
  }), null)
})

test('whitespace-only counts as missing', () => {
  assert.match(stagingDriveViolation({ DRIVE_FOOTAGE_ROOT: '   ' })!, /not set/)
})

// ── the installed guard ──────────────────────────────────────────────────────

test('outside staging the guard is a strict no-op even with prod ids configured', () => {
  process.env.DRIVE_FOOTAGE_ROOT = PROD_DRIVE_IDS[0] // prod config = normal
  assert.equal(isStaging(), false)
  assert.doesNotThrow(() => assertStagingDriveIsolation())
})

test('APP_ENV=staging with missing roots throws before any Drive client can exist', () => {
  process.env.APP_ENV = 'staging'
  assert.throws(() => assertStagingDriveIsolation(), /staging-guard/)
})

test('APP_ENV=staging pointing at a prod drive throws', () => {
  process.env.APP_ENV = 'staging'
  process.env.DRIVE_FOOTAGE_ROOT = '0AStagingAAAAAAAA1'
  process.env.DRIVE_PRODUCTION_TEAM_ROOT = PROD_DRIVE_IDS[1] // the real landing drive
  process.env.DRIVE_PHOTO_ROOT = '0AStagingBBBBBBBB2'
  assert.throws(() => assertStagingDriveIsolation(), /PRODUCTION drive/)
})

test('APP_ENV=staging with a complete staging config passes', () => {
  process.env.APP_ENV = 'staging'
  process.env.DRIVE_FOOTAGE_ROOT = '0AStagingAAAAAAAA1'
  process.env.DRIVE_PRODUCTION_TEAM_ROOT = '0AStagingBBBBBBBB2'
  process.env.DRIVE_PHOTO_ROOT = '0AStagingCCCCCCCC3'
  assert.doesNotThrow(() => assertStagingDriveIsolation())
})

// ── calendar opt-in ──────────────────────────────────────────────────────────

test('calendar: blocked on staging by default, open with explicit opt-in, never blocked in prod', () => {
  assert.equal(stagingBlocksCalendar(), false) // prod/dev
  process.env.APP_ENV = 'staging'
  assert.equal(stagingBlocksCalendar(), true)  // staging default = dead
  process.env.STAGING_ALLOW_CALENDAR = '1'
  assert.equal(stagingBlocksCalendar(), false) // deliberate opt-in
})

// ── v1.159.1 review fixes ────────────────────────────────────────────────────

test('docs root set without opt-in is a violation; opt-in allows it; backup id always refused', () => {
  assert.match(stagingOptionalDriveViolation({ DRIVE_DOCS_ROOT: 'some-folder' })!, /DRIVE_DOCS_ROOT/)
  assert.equal(stagingOptionalDriveViolation({ DRIVE_DOCS_ROOT: 'some-folder', STAGING_ALLOW_DOCS: '1' }), null)
  assert.equal(stagingOptionalDriveViolation({}), null)
  assert.match(stagingOptionalDriveViolation({ BACKUP_DRIVE_FOLDER_ID: 'x', STAGING_ALLOW_DOCS: '1' })!, /BACKUP/)
})

test('the installed guard also rejects docs/backup misconfig on staging', () => {
  process.env.APP_ENV = 'staging'
  process.env.DRIVE_FOOTAGE_ROOT = '0AStagingAAAAAAAA1'
  process.env.DRIVE_PRODUCTION_TEAM_ROOT = '0AStagingBBBBBBBB2'
  process.env.DRIVE_PHOTO_ROOT = '0AStagingCCCCCCCC3'
  process.env.DRIVE_DOCS_ROOT = 'prod-docs-folder-id'
  try {
    assert.throws(() => assertStagingDriveIsolation(), /DRIVE_DOCS_ROOT/)
  } finally { delete process.env.DRIVE_DOCS_ROOT }
})

test('stagingBlocksTarget: refuses the prod id on staging only, never elsewhere', () => {
  const PROD = 'prod-id-123'
  assert.equal(stagingBlocksTarget(PROD, PROD), false) // not staging → never blocks
  process.env.APP_ENV = 'staging'
  assert.equal(stagingBlocksTarget(PROD, PROD), true)   // staging + prod target → block
  assert.equal(stagingBlocksTarget('copy-id-456', PROD), false) // repointed → fine
  assert.equal(stagingBlocksTarget(undefined, PROD), false)     // unset handled upstream
})
