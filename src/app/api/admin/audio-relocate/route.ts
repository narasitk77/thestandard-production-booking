import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import {
  listChildFolders, listFilesRecursive, moveFileToFolder, hasDriveCredentials, isFolderAlive,
} from '@/lib/google-drive'
import { bookingNeedsSound } from '@/lib/outlet-folders'
import { getDriveLink } from '@/lib/drive-links'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CAMERAISH_RE = /^(CAM-|AUDIO$|DRONE$|SWITCHER$|PHOTO$|SCREEN$)/i

/**
 * v1.126 — one-off admin tool for the "ซิงค์ไม่เจอ Audio" bug: the merge used to
 * drop audio at `<booking>/AUDIO` while prep pre-created the crew-visible
 * `<booking>/<EP>/AUDIO` (left empty — the decoy the team kept opening).
 * This MOVES (never copies, never deletes) each file from the booking-level
 * AUDIO into the first EP's AUDIO, for every recent Sound booking with a known
 * box. Files already present in the EP AUDIO (same name+size) are skipped.
 *
 * POST /api/admin/audio-relocate   { execute?: true }   — dryRun by default.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const execute = body?.execute === true
  if (!hasDriveCredentials()) return NextResponse.json({ error: 'Drive ยังไม่ได้ตั้งค่า' }, { status: 400 })

  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const bookings = await prisma.booking.findMany({
    where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, deletedAt: null, bookingCode: { not: null }, shootDate: { gte: since } },
    select: { id: true, bookingCode: true, crewRequired: true, driveFolders: true },
  })

  const plan: Array<{ code: string; files: string[]; toEp: string; note?: string }> = []
  let scanned = 0
  for (const b of bookings) {
    if (!bookingNeedsSound(b.crewRequired)) continue
    const boxId = getDriveLink(b.driveFolders, 'box')
    if (!boxId || !(await isFolderAlive(boxId))) continue
    scanned++
    const kids = await listChildFolders(boxId)
    const directAudio = kids.find(k => k.name.trim().toUpperCase() === 'AUDIO')
    if (!directAudio) continue
    const files = (await listFilesRecursive(directAudio.id, { maxFiles: 500 }))
    if (files.length === 0) continue
    // the first EP subfolder that has (or should have) an AUDIO slot
    const epFolders = kids.filter(k => !CAMERAISH_RE.test(k.name.trim())).sort((a, c) => a.name.localeCompare(c.name))
    let epAudioId: string | null = null
    let epName = ''
    for (const ep of epFolders) {
      const epKids = await listChildFolders(ep.id)
      const audio = epKids.find(k => k.name.trim().toUpperCase() === 'AUDIO')
      if (audio) { epAudioId = audio.id; epName = ep.name; break }
    }
    if (!epAudioId) continue // no crew-visible slot — booking-level AUDIO is already the right home
    const already = new Set((await listFilesRecursive(epAudioId, { maxFiles: 500 })).map(f => `${f.name}|${f.size ?? ''}`))
    const toMove = files.filter(f => !already.has(`${f.name}|${f.size ?? ''}`))
    if (toMove.length === 0) continue
    plan.push({ code: b.bookingCode!, files: toMove.map(f => f.name), toEp: epName })

    if (execute) {
      for (const f of toMove) {
        try { await moveFileToFolder(f.id, epAudioId, directAudio.id) }
        catch (e: any) { plan[plan.length - 1].note = `move failed: ${e?.message || e}` }
      }
    }
  }

  if (execute) {
    logAudit({
      actorEmail: session.email, action: 'audio.relocate', entityType: 'Drive', entityId: 'audio-relocate',
      changes: { bookings: plan.length, files: plan.reduce((s, p) => s + p.files.length, 0) },
    })
  }
  return NextResponse.json({ dryRun: !execute, scanned, affected: plan.length, plan })
}
