/**
 * Diagnostic: list the immediate child folders under DRIVE_FOOTAGE_ROOT.
 * Used by v1.35.x to confirm the per-outlet folder names in the team's
 * Shared Drive — so the upload code knows which folder to put new
 * files under for each outlet.
 *
 * Usage:
 *   npx tsx scripts/inspect-drive-outlets.ts
 *
 * Reads env from `.env` (Next.js convention) — make sure
 * DRIVE_FOOTAGE_ROOT and GOOGLE_SERVICE_ACCOUNT_* are set.
 *
 * Output: a table of folder name + Drive folder ID for every direct
 * child under the configured root. Compares against the outlet codes
 * currently in the Outlet table and prints a suggested mapping.
 *
 * Exits 0 always — diagnostic only, never writes to Drive or the DB.
 */

import { google, drive_v3 } from 'googleapis'
import { PrismaClient } from '@prisma/client'
import { getDriveReadAuth, hasDriveCredentials } from '../src/lib/google-drive'

async function main() {
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()

  console.log('=== Drive outlet-folder inspector ===')
  console.log(`  DRIVE_FOOTAGE_ROOT: ${root ?? '(unset)'}`)
  console.log('')

  if (!root) {
    console.error('FATAL: DRIVE_FOOTAGE_ROOT env var is not set.')
    process.exit(0)
  }
  if (!hasDriveCredentials()) {
    console.error('FATAL: GOOGLE_SERVICE_ACCOUNT_* env vars missing.')
    process.exit(0)
  }

  // 1. Pull immediate child folders under the root
  const drive = google.drive({ version: 'v3', auth: getDriveReadAuth() })
  let folders: Array<{ id: string; name: string }> = []
  let pageToken: string | undefined = undefined
  try {
    do {
      const res: { data: drive_v3.Schema$FileList } = await drive.files.list({
        q: `'${root}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
        fields: 'nextPageToken, files(id, name)',
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
      })
      for (const f of res.data.files ?? []) {
        if (f.id && f.name) folders.push({ id: f.id, name: f.name })
      }
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)
  } catch (e: any) {
    console.error('FATAL: Drive list failed:', e?.message || e)
    if (e?.code === 403 || /permission/i.test(String(e?.message))) {
      console.error('  → Hint: confirm the impersonated user has access to the Shared Drive.')
    }
    process.exit(0)
  }

  folders.sort((a, b) => a.name.localeCompare(b.name))

  console.log(`Found ${folders.length} folder(s) directly under root:`)
  for (const f of folders) {
    console.log(`  ${f.name.padEnd(30)} ${f.id}`)
  }
  console.log('')

  // 2. Cross-reference with the Outlet table
  const prisma = new PrismaClient()
  try {
    const outlets = await prisma.outlet.findMany({
      orderBy: [{ sort: 'asc' }, { code: 'asc' }],
      select: { code: true, name: true, storagePolicy: true },
    })

    console.log(`Outlets in DB (${outlets.length}):`)
    console.log('  code  name                              policy        suggested folder match')
    console.log('  ----  --------------------------------  ------------  ----------------------')
    for (const o of outlets) {
      // Try matching folder by: exact code, exact name, case-insensitive
      // partial. First hit wins.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ก-๙]/g, '')
      const code = norm(o.code)
      const name = norm(o.name)
      const hit = folders.find(f => {
        const fn = norm(f.name)
        return fn === code || fn === name || fn.includes(code) || fn.includes(name)
      })
      const match = hit ? `${hit.name} (${hit.id.slice(0, 12)}…)` : '(no match — folder missing?)'
      console.log(`  ${o.code.padEnd(4)}  ${(o.name || '').padEnd(32)}  ${o.storagePolicy.padEnd(12)}  ${match}`)
    }
    console.log('')

    // 3. Folders with no outlet match — useful "orphans"
    const matchedFolderIds = new Set<string>()
    for (const o of outlets) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ก-๙]/g, '')
      const code = norm(o.code)
      const name = norm(o.name)
      const hit = folders.find(f => {
        const fn = norm(f.name)
        return fn === code || fn === name || fn.includes(code) || fn.includes(name)
      })
      if (hit) matchedFolderIds.add(hit.id)
    }
    const orphans = folders.filter(f => !matchedFolderIds.has(f.id))
    if (orphans.length > 0) {
      console.log(`Drive folders not matched to any outlet (${orphans.length}):`)
      for (const f of orphans) {
        console.log(`  ${f.name.padEnd(30)} ${f.id}`)
      }
      console.log('  → Either rename these to match an outlet code/name, or leave them be (worker skips orphan trees).')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => {
  console.error('inspect-drive-outlets crashed:', e)
  process.exit(1)
})
