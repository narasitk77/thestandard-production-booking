/**
 * Diagnostic: read the configured footage-log sheet's header row, classify
 * each column under our canonical key map, and print a report. Run this
 * BEFORE flipping `FOOTAGE_WORKER_ENABLED=1` so we know the worker can
 * actually write Production IDs into the right column without disturbing
 * any user-owned columns.
 *
 * Usage:
 *   npx tsx scripts/inspect-footage-sheet.ts
 *
 * Reads env from `.env` (Next.js convention) — make sure
 * FOOTAGE_LOG_SHEET_ID and (optionally) FOOTAGE_LOG_TAB are set there
 * or exported in the shell.
 *
 * Output: sheet id (masked), tab name, raw headers, canonical-key map,
 * and any "unknown" headers (the user added a column we don't recognize).
 * Exits 0 always — diagnostic only, never modifies the sheet.
 */

import { probeSheet, clearFootageSheetCache } from '../src/lib/footage-sheet'
import { maskSheetId } from '../src/lib/google-config'

const EXPECTED_KEYS = [
  'productionId',
  'filename',
  'camera',
  'uploader',
  'timestamp',
  'driveLink',
] as const

async function main() {
  const sheetId = process.env.FOOTAGE_LOG_SHEET_ID?.trim()
  const tab = process.env.FOOTAGE_LOG_TAB?.trim() || 'Sheet1'

  console.log('=== Footage-log sheet inspector ===')
  console.log(`  FOOTAGE_LOG_SHEET_ID: ${maskSheetId(sheetId)}`)
  console.log(`  FOOTAGE_LOG_TAB:      ${tab}`)
  console.log('')

  if (!sheetId) {
    console.error('FATAL: FOOTAGE_LOG_SHEET_ID env var is not set.')
    console.error('Set it in .env (or export it) and try again.')
    process.exit(0)
  }

  clearFootageSheetCache()
  let result
  try {
    result = await probeSheet({ force: true })
  } catch (e: any) {
    console.error('FATAL: probeSheet failed:', e?.message || e)
    if (e?.code === 403 || /permission/i.test(String(e?.message))) {
      console.error('  → Hint: share the sheet with GOOGLE_SERVICE_ACCOUNT_EMAIL as Editor.')
    }
    process.exit(0)
  }

  if (!result) {
    console.error('probeSheet returned null — credentials missing (GOOGLE_SERVICE_ACCOUNT_JSON or _EMAIL+_PRIVATE_KEY).')
    process.exit(0)
  }

  console.log(`Raw header row (${result.rawHeaders.length} columns):`)
  result.rawHeaders.forEach((h, i) => {
    const col = String.fromCharCode(65 + i)
    console.log(`  ${col}: ${JSON.stringify(h)}`)
  })
  console.log('')

  console.log('Canonical key map (canonical → column index, 0-based):')
  const sorted = Object.entries(result.byKey).sort((a, b) => Number(a[1]) - Number(b[1]))
  if (sorted.length === 0) {
    console.log('  (empty — no headers matched any canonical key)')
  } else {
    for (const [k, idx] of sorted) {
      const col = String.fromCharCode(65 + Number(idx))
      console.log(`  ${k.padEnd(16)} → col ${col} (${result.rawHeaders[Number(idx)]})`)
    }
  }
  console.log('')

  console.log('Expected canonical keys not found in sheet:')
  const missing = EXPECTED_KEYS.filter(k => result.byKey[k] == null)
  if (missing.length === 0) {
    console.log('  (none — all expected columns present)')
  } else {
    for (const k of missing) console.log(`  - ${k}`)
    console.log('  → Add a column with one of the recognized header aliases or accept it stays blank.')
  }
  console.log('')

  if (result.unknown.length > 0) {
    console.log('Unrecognized headers (sheet owner added these — worker will leave them blank):')
    for (const h of result.unknown) console.log(`  - ${JSON.stringify(h)}`)
  } else {
    console.log('No unrecognized headers — every column is mapped.')
  }
  console.log('')
  console.log('OK. If the map above looks right, the worker is safe to enable.')
}

main().catch(e => {
  console.error('inspect-footage-sheet crashed:', e)
  process.exit(1)
})
