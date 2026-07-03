/**
 * v1.112 — one-off: bring existing AGN project boxes to the new per-booking
 * layout. Today a project box holds EP folders from ALL of the project's
 * bookings as siblings (plus loose ops folders and _SHOOT-<code>.txt files), so
 * nobody can tell which คิว shot what. This sweep, per project box:
 *
 *   - maps each EP folder ("<projectEpId> · <title>") to the booking whose
 *     episodes include that EP ID and MOVES it into "<job> (<bookingCode>)"
 *     (created on demand, matched by code so re-runs reuse it),
 *   - moves each box-level "_SHOOT-<code>.txt" into its booking folder,
 *   - reports (but does NOT touch) items it can't attribute: EP folders booked
 *     by SEVERAL active bookings, and ops-made folders with no EP-ID lead.
 *
 * Default is a dry run (full move plan, zero writes). Idempotent: a folder that
 * already matches a booking code is left alone, moves reuse existing targets.
 */
import { prisma } from './db'
import {
  listChildFolders, listFilesInFolder, moveFileToFolder, findProgramFolderId,
  ensureFolderPath, hasDriveCredentials,
} from './google-drive'
import {
  outletDriveFolderName, shootFolderLayers, buildBookingFolderName, folderNameMatchesCode,
} from './outlet-folders'

export interface AgnRestructureResult {
  skipped: boolean
  reason?: string
  dryRun: boolean
  projects: number
  moved: number
  errors: number
  results: Array<{
    projectId: string
    box?: string
    boxUrl?: string
    skipped?: string
    moves?: string[]      // '"<name>" → "<booking folder>"'
    ambiguous?: string[]  // EP booked by several active bookings — user decides
    unmapped?: string[]   // ops folders / unknown files — left alone
  }>
}

export async function runAgnRestructure(opts: { dryRun?: boolean; projectId?: string } = {}): Promise<AgnRestructureResult> {
  const base: AgnRestructureResult = { skipped: false, dryRun: !!opts.dryRun, projects: 0, moved: 0, errors: 0, results: [] }
  const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
  if (!root || !hasDriveCredentials()) return { ...base, skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials' }

  const bookings = await prisma.booking.findMany({
    where: {
      outlet: { code: 'AGN' },
      projectId: { not: null },
      bookingCode: { not: null },
      deletedAt: null,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
    },
    select: {
      bookingCode: true, status: true, projectId: true, projectName: true, category: true,
      episodes: { orderBy: { sequence: 'asc' }, select: { episodeId: true, title: true } },
    },
  })

  const byProject = new Map<string, typeof bookings>()
  for (const b of bookings) {
    const g = byProject.get(b.projectId!) || []
    g.push(b)
    byProject.set(b.projectId!, g)
  }

  const canon = outletDriveFolderName('AGN')
  for (const [projectId, group] of Array.from(byProject)) {
    base.projects++
    try {
      // Locate the project box: category box(es) → child matched by projectId.
      // Categories can differ per booking (rare) — try each distinct one.
      const catNames = Array.from(new Set(group.map(b =>
        shootFolderLayers({ outletCode: 'AGN', showName: '', category: b.category, projectId, projectName: b.projectName, bookingCode: b.bookingCode!, jobName: null }).programFolderName,
      )))
      let boxId: string | null = null, boxName = ''
      for (const cat of catNames) {
        const pid = await findProgramFolderId(root, canon, cat)
        if (!pid) continue
        const child = (await listChildFolders(pid)).find(f => folderNameMatchesCode(f.name, projectId))
        if (child) { boxId = child.id; boxName = child.name; break }
      }
      if (!boxId) { base.results.push({ projectId, skipped: 'project box not found on Drive' }); continue }

      // EP ownership: episodeId → ACTIVE bookings that booked it. Cancelled
      // bookings never own an EP folder (their shoot didn't happen).
      const owners = new Map<string, string[]>()
      const jobOf = new Map<string, string | null>()
      for (const b of group) {
        jobOf.set(b.bookingCode!, b.projectName?.trim() || b.episodes[0]?.title?.trim() || null)
        if (b.status === 'CANCELLED') continue
        for (const e of b.episodes) {
          const k = (e.episodeId || '').trim().toLowerCase()
          if (!k) continue
          const a = owners.get(k) || []
          if (!a.includes(b.bookingCode!)) a.push(b.bookingCode!)
          owners.set(k, a)
        }
      }
      const codes = group.map(b => b.bookingCode!)
      const targetName = (code: string) => buildBookingFolderName(code, jobOf.get(code) ?? null)

      const kids = await listChildFolders(boxId)
      const boxFiles = await listFilesInFolder(boxId)
      const plan: Array<{ id: string; name: string; toCode: string }> = []
      const ambiguous: string[] = []
      const unmapped: string[] = []

      for (const k of kids) {
        // already a per-booking folder → leave (it IS the new layout)
        if (codes.some(c => folderNameMatchesCode(k.name, c))) continue
        const lead = (k.name.split(' · ')[0] || '').trim().toLowerCase()
        const own = owners.get(lead) || []
        if (own.length === 1) plan.push({ id: k.id, name: k.name, toCode: own[0] })
        else if (own.length > 1) ambiguous.push(`${k.name} → จองโดย ${own.join(', ')}`)
        else unmapped.push(k.name)
      }
      for (const f of boxFiles) {
        const m = f.name.match(/^_SHOOT-([A-Z0-9-]+)\.txt$/i)
        if (!m) continue // other box-level files: leave alone
        const code = codes.find(c => c.toUpperCase() === m[1].toUpperCase())
        if (code) plan.push({ id: f.id, name: f.name, toCode: code })
        else unmapped.push(f.name)
      }

      const moves: string[] = []
      const folderIdByCode = new Map<string, string>()
      for (const mv of plan) {
        const tname = targetName(mv.toCode)
        moves.push(`"${mv.name}" → "${tname}"`)
        if (base.dryRun) { base.moved++; continue }
        let tid = folderIdByCode.get(mv.toCode)
        if (!tid) {
          // reuse an existing booking folder (matched by code) before creating
          tid = kids.find(f => folderNameMatchesCode(f.name, mv.toCode))?.id
            ?? await ensureFolderPath(boxId, [tname])
          folderIdByCode.set(mv.toCode, tid)
        }
        try { await moveFileToFolder(mv.id, tid, boxId); base.moved++ }
        catch (e: any) { base.errors++; moves.push(`ERROR "${mv.name}": ${e?.message || e}`) }
      }

      base.results.push({
        projectId, box: boxName, boxUrl: `https://drive.google.com/drive/folders/${boxId}`,
        moves, ambiguous, unmapped,
      })
    } catch (e: any) {
      base.errors++
      base.results.push({ projectId, skipped: `error: ${e?.message || String(e)}` })
    }
  }

  return base
}
