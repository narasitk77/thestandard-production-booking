import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import {
  hasOutletFolderMapping, outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, episodeLeadUsesId,
} from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import {
  ensureUploadFolderPath, folderLiveness, classifyFootageTreeFolder, createChildFolderStrict,
  listFilesRecursive, findFoldersByCode, getFolderDriveId, getDriveParentFolderId, getDriveItemState, trashDriveItem,
} from '@/lib/google-drive'
import { getDriveLink } from '@/lib/drive-links'
import { isDriveAccessError } from '@/lib/drive-access'
import { latestNasState, nasManifestAge } from '@/lib/nas-sync'
import { clearFootageCache } from '@/lib/footage-folders'
import { notifyChat } from '@/lib/notify'
import { alertOps } from '@/lib/ops-alert'
import { logAudit } from '@/lib/audit'
import {
  CARD_PREFIX, HEARTBEAT_PHASES, cardFileName, newTicket, hashTicket, parseNotes, decideStart, decideComplete, isCardRow,
  type IngestManifest, type IngestNotes,
} from '@/lib/ingest'

export const dynamic = 'force-dynamic'

/**
 * POST /api/upload/ingest — v1.277 "ส่งฟุตเทจจากหน้างาน"
 *
 * rclone on the crew's laptop uploads a WHOLE Sony card straight into the
 * booking's box (never landing — the hourly merge moves folders mid-upload)
 * under a per-card folder, as the crew member. This route is the brain:
 *
 *   ticket    (session)  one ticket = one card = one Upload row `CARD_…` (PENDING)
 *   start     (ticket)   refuse-or-mint: resolves the box by stored id, EP/CAM as
 *                        the crew member (NO narasit.k@ fallback), mints the card
 *                        folder, row → UPLOADING with the manifest
 *   heartbeat (ticket)   bumps updatedAt + progress; revives ORPHANED (client came back)
 *   pause     (ticket)   proxies-ok (pass 1 verified, originals later) · quota-wait
 *   complete  (ticket)   the ONLY release: client's `rclone check` + server re-read
 *   fail      (ticket)   ORPHANED + alertOps — the notice stays held
 *   release   (ADMIN session, uploadId)  FAILED after a human looked — never touches Drive
 *
 * Auth for everything but `ticket` is the ticket itself: random 32 bytes the
 * client holds, sha256 in Upload.sha256. No new env, no shared secret.
 * footage-ready holds a booking while any CARD_ row is UPLOADING/ORPHANED, with
 * no expiry (see src/lib/ingest.ts for why).
 */

const DAY = 86_400_000
const PRODUCTION_TEAM_ROOT = () => process.env.DRIVE_PRODUCTION_TEAM_ROOT?.trim() || '0AGendsFHFQYKUk9PVA'
const CAMERA_RE = /^(CAM-[A-D]|AUDIO)$/
const SHOOT_STUB_RE = /^_SHOOT\b.*\.txt$/i

const BOOKING_SELECT = {
  id: true, bookingCode: true, status: true, assignedEmails: true, deletedAt: true, driveFolders: true,
  projectName: true, projectId: true, category: true,
  outlet: { select: { code: true, name: true } },
  program: { select: { name: true } },
  episodes: {
    orderBy: { sequence: 'asc' as const },
    select: { id: true, episodeId: true, title: true, sequence: true, program: { select: { name: true } } },
  },
} as const

type Card = NonNullable<Awaited<ReturnType<typeof loadCard>>>

async function loadCard(ticket: string) {
  if (!ticket || ticket.length < 20 || ticket.length > 128) return null
  return prisma.upload.findFirst({
    where: { sha256: hashTicket(ticket), fileName: { startsWith: CARD_PREFIX } },
    include: { booking: { select: BOOKING_SELECT } },
  })
}

const bad = (status: number, code: string, message: string) => NextResponse.json({ ok: false, code, error: message }, { status })
/** chat text from a client: no pings, bounded */
const quiet = (t: string, n: number) => t.replace(/@/g, '＠').slice(0, n)

async function writeNotes(id: string, notes: IngestNotes, extra: Record<string, unknown> = {}) {
  return prisma.upload.update({ where: { id }, data: { notes: JSON.stringify({ ...notes, at: new Date().toISOString() }), ...extra } })
}

function readManifest(raw: any): IngestManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const n = (k: string) => Number(raw[k])
  const m = { files: n('files'), bytes: n('bytes'), videos: n('videos'), wavs: n('wavs'), sonyTree: !!raw.sonyTree, mediapro: !!raw.mediapro }
  return [m.files, m.bytes, m.videos, m.wavs].every(v => Number.isFinite(v) && v >= 0) ? m : null
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const action = String(body.action || '')

    // ── ticket: the only session-authenticated action ─────────────────────────
    if (action === 'ticket') {
      const session = await getSession()
      if (!session) return bad(401, 'UNAUTHORIZED', 'Unauthorized')
      const bookingId = String(body.bookingId || '').trim()
      const camera = String(body.camera || '').trim().toUpperCase()
      const episodeRowId = body.episodeRowId ? String(body.episodeRowId).trim() : ''
      if (!bookingId) return bad(400, 'BAD_REQUEST', 'bookingId is required')
      if (!CAMERA_RE.test(camera)) return bad(400, 'BAD_CAMERA', 'camera ต้องเป็น CAM-A…CAM-D หรือ AUDIO (Phase 1)')
      const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: BOOKING_SELECT })
      if (!booking) return bad(404, 'BOOKING_NOT_FOUND', 'Booking not found')
      if (!booking.bookingCode) return bad(400, 'NO_CODE', 'Booking has no Production ID')
      const check = await canUploadToBooking(session.email, booking)
      if (!check.ok) return bad(403, check.reason ?? 'FORBIDDEN', 'คุณอัปใบนี้ไม่ได้ (ต้องเป็นทีม video/sound ที่ถูกแจกงาน และใบต้อง CONFIRMED/COMPLETED)')
      if (!hasOutletFolderMapping(booking.outlet.code)) return bad(400, 'NO_OUTLET_FOLDER', `Outlet "${booking.outlet.code}" has no folder mapping`)
      let episodeId: string | null = null
      if (booking.episodes.length > 0) {
        const ep = episodeRowId ? booking.episodes.find(e => e.id === episodeRowId) : booking.episodes[0]
        if (!ep) return bad(400, 'BAD_EPISODE', 'episodeRowId does not match any episode on this booking')
        episodeId = ep.id
      } else if (episodeRowId) {
        return bad(400, 'BAD_EPISODE', 'episodeRowId provided but this booking has no episodes')
      }
      const ticket = newTicket()
      const row = await prisma.upload.create({
        data: {
          bookingId: booking.id, episodeId, camera, fileName: `${CARD_PREFIX}pending`, uploadedBy: session.email,
          sha256: hashTicket(ticket), status: 'PENDING', initiatedAt: new Date(),
          notes: JSON.stringify({ phase: 'start', at: new Date().toISOString() } satisfies IngestNotes),
        },
      })
      const cardName = cardFileName(camera, row.id)
      await prisma.upload.update({ where: { id: row.id }, data: { fileName: cardName } })
      return NextResponse.json({ ok: true, ticket, uploadId: row.id, cardName, bookingCode: booking.bookingCode, camera })
    }

    // ── release: the human override (ADMIN only). FAILED is the one state that lets go of the hold. ──
    if (action === 'release') {
      const session = await getSession()
      if (!session || session.role !== 'ADMIN') return bad(403, 'ADMIN_ONLY', 'ปลดการ์ดได้เฉพาะแอดมิน')
      const id = String(body.uploadId || '').trim()
      const row = id ? await prisma.upload.findUnique({ where: { id }, select: { id: true, fileName: true, status: true, bookingId: true, camera: true, driveUrl: true } }) : null
      if (!row || !isCardRow(row.fileName)) return bad(404, 'NOT_A_CARD', 'ไม่พบการ์ดส่งจากหน้างานนี้')
      if (row.status === 'COMPLETE' || row.status === 'FAILED') return NextResponse.json({ ok: true, idempotent: true, status: row.status })
      const why = quiet(String(body.reason || 'ปลดโดยแอดมิน').trim(), 300)
      await prisma.upload.update({ where: { id: row.id }, data: { status: 'FAILED', failureReason: `ปลดโดย ${session.email}: ${why}` } })
      await logAudit({ actorEmail: session.email, action: 'ingest.release', entityType: 'Upload', entityId: row.id, changes: { from: row.status, reason: why, camera: row.camera, card: row.fileName } })
      return NextResponse.json({ ok: true, status: 'FAILED' })
    }

    // ── everything else: ticket-authenticated ──────────────────────────────────
    const ticket = String(body.ticket || '').trim()
    const card = await loadCard(ticket)
    if (!card) return bad(401, 'BAD_TICKET', 'โค้ดส่งฟุตเทจไม่ถูกต้องหรือหมดอายุ')
    const b = card.booking
    const code = b.bookingCode || card.bookingId
    const notes = parseNotes(card.notes) || ({ phase: 'start' } as IngestNotes)
    const now = new Date()

    if (action === 'start') {
      // status may have changed since the ticket was issued (cancelled, ส่งงาน) — re-run the gate
      const check = await canUploadToBooking(card.uploadedBy, b)
      if (!check.ok) return bad(403, check.reason ?? 'FORBIDDEN', 'ใบนี้อัปไม่ได้แล้ว (สถานะเปลี่ยน หรือสิทธิ์ถูกถอน)')
      if (card.status === 'COMPLETE') return bad(409, 'ALREADY_COMPLETE', 'การ์ดนี้ส่งครบแล้ว')
      if (card.status === 'FAILED') return bad(409, 'RELEASED', 'การ์ดนี้ถูกแอดมินปิดแล้ว — ขอโค้ดใหม่')
      const manifest = readManifest(body.manifest)
      if (!manifest) return bad(400, 'BAD_MANIFEST', 'manifest ต้องมี files/bytes/videos/wavs/sonyTree/mediapro')

      // id-first box only (no name walk: it is create-on-miss and would fork the shoot's footage)
      const storedBox = b.outlet.code === 'AGN' ? null : getDriveLink(b.driveFolders, 'box')
      let hasBox = false
      if (storedBox) {
        const live = await folderLiveness(storedBox)
        if (live === 'unknown') return bad(503, 'DRIVE_UNAVAILABLE', 'ตรวจกล่องบน Drive ไม่ได้ตอนนี้ — ลองใหม่อีกสักครู่')
        const cls = live === 'alive' ? await classifyFootageTreeFolder(storedBox) : 'outside'
        if (cls === 'unknown') return bad(503, 'DRIVE_UNAVAILABLE', 'ตรวจกล่องบน Drive ไม่ได้ตอนนี้ — ลองใหม่อีกสักครู่')
        hasBox = live === 'alive' && cls === 'in-tree'
      }

      // one uploader per booking: landing (Production Team drive) must be empty, NAS must not be sending this code
      let landingHasFiles = false
      for (const f of await findFoldersByCode(code)) {
        // the Production Team drive IS the landing zone (isFootageTreeFolder would exclude exactly these)
        if ((await getFolderDriveId(f.id)) !== PRODUCTION_TEAM_ROOT()) continue
        const some = await listFilesRecursive(f.id, { maxFiles: 4 })
        if (some.some(x => !SHOOT_STUB_RE.test(x.name))) { landingHasFiles = true; break }
      }
      const nasState = await latestNasState().catch(() => ({ manifest: null, statuses: {} as Record<string, any> }))
      const nasFresh = nasState.manifest && !nasManifestAge(nasState.manifest.at, now).stale
      const nasPending = nasFresh ? Number(nasState.statuses?.[code]?.lastPending || 0) : 0
      const otherUploaderInFlight = (await prisma.upload.count({
        where: {
          bookingId: b.id, fileName: { startsWith: CARD_PREFIX }, status: 'UPLOADING',
          uploadedBy: { not: card.uploadedBy }, updatedAt: { gte: new Date(now.getTime() - DAY) },
        },
      })) > 0
      const mine24h = await prisma.upload.findMany({
        where: { uploadedBy: card.uploadedBy, fileName: { startsWith: CARD_PREFIX }, id: { not: card.id }, updatedAt: { gte: new Date(now.getTime() - DAY) } },
        select: { notes: true },
      })
      const usedBytes24h = mine24h.reduce((n, r) => n + (parseNotes(r.notes)?.bytes || 0), 0)
      // a rerun (after a kill, quota-wait, or for pass 2) only owes what is not on Drive yet
      let alreadyOnDrive = 0
      if (card.driveFileId && (await folderLiveness(card.driveFileId)) === 'alive') {
        alreadyOnDrive = (await listFilesRecursive(card.driveFileId, { maxFiles: 20000 })).reduce((n, f) => n + (f.size || 0), 0)
      }
      const owed = { ...manifest, bytes: Math.max(0, manifest.bytes - alreadyOnDrive) }

      const decision = decideStart(owed, { isAgency: b.outlet.code === 'AGN', hasBox, landingHasFiles, nasPending, otherUploaderInFlight, usedBytes24h })
      if (!decision.ok) {
        await logAudit({ actorEmail: card.uploadedBy, action: 'ingest.refused', entityType: 'Upload', entityId: card.id, bookingCode: code, changes: { code: decision.code, manifest } })
        return bad(409, decision.code, decision.message)
      }

      // resolve EP/CAM AS the crew member (Drive shows them as creator; no service-subject fallback)
      const ep = card.episodeId ? b.episodes.find(e => e.id === card.episodeId) ?? null : null
      const episodeFolderName = ep ? buildEpisodeFolderName(ep, { useEpisodeId: episodeLeadUsesId(b.outlet.code, b.episodes) }) : undefined
      const jobName = (b.projectName && b.projectName.trim()) || (b.episodes[0]?.title && b.episodes[0].title.trim()) || null
      const layers = shootFolderLayers({
        outletCode: b.outlet.code, showName: bookingShowName({ projectName: b.projectName, program: b.program, episodes: b.episodes }),
        category: b.category, projectId: b.projectId, projectName: b.projectName, bookingCode: code, jobName,
      })
      let camFolderId: string, cardFolderId: string
      try {
        const target = await ensureUploadFolderPath({
          knownBookingFolderId: storedBox!, rootFolderId: process.env.DRIVE_FOOTAGE_ROOT?.trim() || '',
          outletCanonicalName: outletDriveFolderName(b.outlet.code), programFolderName: layers.programFolderName,
          bookingFolderName: layers.bookingFolderName, bookingSubfolderName: layers.bookingSubfolderName,
          bookingSubfolderCode: b.bookingCode ?? undefined, bookingCode: b.bookingCode ?? undefined,
          episodeFolderName, camera: card.camera, subject: card.uploadedBy,
        })
        camFolderId = target.cameraFolderId
        // rerun (any phase, incl. after `fail`) → the folder this row minted; createChildFolderStrict refuses a dead one.
        // First mint → strict create, then CLAIM it: a second laptop that raced us trashes its own copy.
        cardFolderId = await createChildFolderStrict(camFolderId, card.fileName, card.uploadedBy, card.driveFileId)
        if (!card.driveFileId) {
          const claimed = await prisma.upload.updateMany({ where: { id: card.id, driveFileId: null }, data: { driveFileId: cardFolderId } })
          if (claimed.count === 0) {
            await trashDriveItem(cardFolderId, card.uploadedBy).catch(() => {})
            return bad(409, 'RACE', 'มีอีกเครื่องเริ่มส่งการ์ดนี้ไปแล้ว — ใช้เครื่องเดียวต่อการ์ด')
          }
        }
      } catch (e: any) {
        if (isDriveAccessError(e)) return bad(403, 'NO_DRIVE_ACCESS', `บัญชี ${card.uploadedBy} ยังไม่อยู่ในไดรฟ์ VIDEO — แจ้งนัท (${e?.message || e})`)
        return bad(502, 'DRIVE_ERROR', `Drive: ${e?.message || e}`)
      }
      // the client checks by PATH from the box: build it from the names Drive actually has
      let pathFromBox: string
      try {
        const epFolderId = episodeFolderName ? await getDriveParentFolderId(camFolderId) : null
        const [ep, cam] = await Promise.all([epFolderId ? getDriveItemState(epFolderId) : null, getDriveItemState(camFolderId)])
        if (!cam || (episodeFolderName && !ep)) throw new Error('EP/CAM folder vanished')
        pathFromBox = [ep?.name, cam.name, card.fileName].filter(Boolean).join('/')
      } catch (e: any) {
        return bad(503, 'DRIVE_UNAVAILABLE', `อ่านชื่อโฟลเดอร์ปลายทางไม่ได้: ${e?.message || e}`)
      }
      await writeNotes(card.id, { ...notes, phase: 'pass1', bytes: notes.bytes || 0, files: 0, manifest, camFolderId, pathFromBox }, {
        status: 'UPLOADING', driveFileId: cardFolderId, driveUrl: `https://drive.google.com/drive/folders/${cardFolderId}`,
        fileSize: BigInt(Math.round(manifest.bytes)), failureReason: null,
      })
      await logAudit({ actorEmail: card.uploadedBy, action: 'ingest.start', entityType: 'Upload', entityId: card.id, bookingCode: code, changes: { camera: card.camera, cardFolderId, manifest, resumed: !!card.driveFileId } })
      return NextResponse.json({
        ok: true, bookingCode: code, cardName: card.fileName, boxId: storedBox, camFolderId, cardFolderId, pathFromBox,
        budgetBytes: decision.budgetBytes, resumed: !!card.driveFileId,
      })
    }

    if (action === 'heartbeat' || action === 'pause') {
      if (card.status === 'COMPLETE' || card.status === 'FAILED') return bad(409, 'CLOSED', `การ์ดนี้ปิดแล้ว (${card.status})`)
      if (!card.driveFileId) return bad(409, 'NOT_STARTED', 'ยังไม่ได้ start')
      const phase = String(body.phase || notes.phase)
      if (action === 'pause' && phase !== 'proxies-ok' && phase !== 'quota-wait') return bad(400, 'BAD_PHASE', 'pause ต้องเป็น proxies-ok หรือ quota-wait')
      // a heartbeat must not park itself (that silences the stale alert) or claim a closing state
      if (action === 'heartbeat' && !HEARTBEAT_PHASES.has(phase)) return bad(400, 'BAD_PHASE', 'heartbeat phase ต้องเป็น pass1/check1/pass2/check2')
      const next: IngestNotes = {
        ...notes, phase: phase as IngestNotes['phase'],
        bytes: Number.isFinite(Number(body.bytes)) ? Math.max(notes.bytes || 0, Number(body.bytes)) : notes.bytes,
        files: Number.isFinite(Number(body.files)) ? Number(body.files) : notes.files,
        eta: body.eta ? quiet(String(body.eta), 40) : undefined,
      }
      if (action === 'pause' && phase === 'proxies-ok' && body.check) next.check = { matching: Number(body.check.matching), differences: Number(body.check.differences) }
      const announce = action === 'pause' && phase === 'proxies-ok' && !notes.announcedProxiesAt
      if (announce) next.announcedProxiesAt = now.toISOString()
      // a client that reappears after being marked dead is alive again — the hold never lapsed in between
      await writeNotes(card.id, next, card.status === 'ORPHANED' ? { status: 'UPLOADING', failureReason: null } : {})
      if (announce) {
        const gb = ((next.bytes || 0) / 1e9).toFixed(1)
        await notifyChat(`🎞️ [Proxy พร้อม] ${code} · ${card.camera} · ส่งจากหน้างานโดย ${card.uploadedBy.split('@')[0]} · ${next.files ?? '?'} ไฟล์ ${gb} GB ตรวจ md5 แล้ว · ต้นฉบับยังไม่มา (ห้าม format การ์ด) · ${card.driveUrl}`, 'footage')
        await logAudit({ actorEmail: card.uploadedBy, action: 'ingest.proxies', entityType: 'Upload', entityId: card.id, bookingCode: code, changes: { files: next.files, bytes: next.bytes } })
      }
      return NextResponse.json({ ok: true, status: 'UPLOADING', phase: next.phase })
    }

    if (action === 'complete') {
      if (card.status === 'COMPLETE') return NextResponse.json({ ok: true, idempotent: true })
      if (card.status === 'FAILED') return bad(409, 'RELEASED', 'การ์ดนี้ถูกแอดมินปิดแล้ว')
      if (!card.driveFileId || !notes.manifest || !notes.camFolderId) return bad(409, 'NOT_STARTED', 'ยังไม่ได้ start')
      const check = { matching: Number(body.check?.matching), differences: Number(body.check?.differences) }
      // the server reads the card folder itself — a trashed ancestor, twins or a short count all refuse
      const storedBox = getDriveLink(b.driveFolders, 'box')
      for (const [label, id] of [['box', storedBox], ['CAM', notes.camFolderId], ['card', card.driveFileId]] as const) {
        const live = id ? await folderLiveness(id) : 'dead'
        if (live !== 'alive') return bad(409, 'FOLDER_NOT_ALIVE', `โฟลเดอร์ ${label} บน Drive ${live === 'dead' ? 'ถูกทิ้ง/หายไป' : 'ตรวจไม่ได้'} — ไฟล์อาจตกถังขยะ ห้าม format การ์ด`)
      }
      const files = await listFilesRecursive(card.driveFileId, { maxFiles: 20000 })
      const paths = files.map(f => [...f.folderPath, f.name].join('/'))
      const decision = decideComplete(check, { paths }, notes.manifest.files)
      if (!decision.ok) {
        await writeNotes(card.id, { ...notes, phase: 'check2', check }, { status: 'ORPHANED', failureReason: `complete ปฏิเสธ: ${decision.message}` })
        await alertOps(`ingest-complete-refused:${code}`, `⛔ ส่งจากหน้างาน ${code} ${card.camera}: ${decision.code}`, `${decision.message}\nการ์ด ${card.fileName} โดย ${card.uploadedBy}\n${card.driveUrl}`)
        return bad(409, decision.code, decision.message)
      }
      const bytes = files.reduce((n, f) => n + (f.size || 0), 0)
      await writeNotes(card.id, { ...notes, phase: 'complete', bytes, files: files.length, check }, { status: 'COMPLETE', completedAt: now, failureReason: null })
      await clearFootageCache(b.id)
      await notifyChat(`✅ ${code} · ${card.camera} · การ์ด ${card.fileName} ส่งครบจากหน้างาน (${card.uploadedBy.split('@')[0]}) · ${files.length} ไฟล์ ${(bytes / 1e9).toFixed(1)} GB · md5 ตรงทั้งหมด · ${card.driveUrl}`, 'footage')
      await logAudit({ actorEmail: card.uploadedBy, action: 'ingest.complete', entityType: 'Upload', entityId: card.id, bookingCode: code, changes: { files: files.length, bytes, check } })
      // sheet rows: the footage-sheet worker walks the box and appends per file (FootageLog dedupe) — nothing to do here
      return NextResponse.json({ ok: true, status: 'COMPLETE', files: files.length, bytes })
    }

    if (action === 'fail') {
      if (card.status === 'COMPLETE' || card.status === 'FAILED') return bad(409, 'CLOSED', `การ์ดนี้ปิดแล้ว (${card.status})`)
      // a ticket nobody started never touched Drive — failing it would only create a hold out of nothing
      if (!card.driveFileId) return bad(409, 'NOT_STARTED', 'ยังไม่ได้ start')
      if (card.status === 'ORPHANED' && notes.phase === 'failed') return NextResponse.json({ ok: true, status: 'ORPHANED', idempotent: true })
      const reason = quiet(String(body.reason || 'client reported failure'), 500)
      await writeNotes(card.id, { ...notes, phase: 'failed' }, { status: 'ORPHANED', failureReason: reason })
      await alertOps(`ingest-fail:${code}`, `❌ ส่งจากหน้างาน ${code} ${card.camera} ล้ม`, `${reason}\nการ์ด ${card.fileName} โดย ${card.uploadedBy} — ห้าม format การ์ด · footage พร้อม ถูกถือไว้จนกว่าจะส่งใหม่หรือแอดมินปิด\n${card.driveUrl || ''}`)
      await notifyChat(`❌ ${code} · ${card.camera} · ส่งจากหน้างานล้ม (${card.uploadedBy.split('@')[0]}): ${reason.slice(0, 160)} — ห้าม format การ์ด`, 'footage')
      await logAudit({ actorEmail: card.uploadedBy, action: 'ingest.fail', entityType: 'Upload', entityId: card.id, bookingCode: code, changes: { reason } })
      return NextResponse.json({ ok: true, status: 'ORPHANED' })
    }

    return bad(400, 'BAD_ACTION', 'action ต้องเป็น ticket | start | heartbeat | pause | complete | fail')
  } catch (e: any) {
    console.error('POST /api/upload/ingest error:', e)
    return NextResponse.json({ ok: false, error: e?.message || 'Failed' }, { status: 500 })
  }
}
