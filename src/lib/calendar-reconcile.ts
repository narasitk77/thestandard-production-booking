import { createHash } from 'crypto'
import { prisma } from './db'
import { logAudit } from './audit'
import {
  computeEventTimes,
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEventAttendees,
  updateCalendarEventAttendees,
  updateCalendarEventDetails,
} from './google-calendar'
import { updateBookingRow } from './google-sheets'
import { bookingCalendarAttendees } from './calendar-attendees'
import { alertOps } from './ops-alert'
import { EPISODE_ORDER } from './episode-order'

const CANCELLED_EVENT_DELETE_FAILED =
  'งานถูกยกเลิก/ลบแล้ว แต่ลบ event ในปฏิทินไม่สำเร็จ — event ยังอยู่ในปฏิทินของทุกคน · reconciler ลองลบใหม่ทุก 10 นาที'
const DETAILS_PATCH_FAILED =
  'แก้ใบจองแล้วแต่ patch เวลา/ชื่อ/สถานที่ ของ event ในปฏิทินไม่สำเร็จ — ปฏิทินยังเป็นค่าเดิม · reconciler ลองใหม่ทุก 10 นาที'

/**
 * Delete the event of a booking that was just cancelled / soft-deleted, and
 * clear calendarEventId ONLY when Google confirms (404/410 count as gone).
 *
 * WHY. deleteCalendarEvent returns false on 429/5xx/unauthorized_client and
 * never throws, so every cancel path's `.catch(() => {})` saw nothing and then
 * nulled calendarEventId anyway — the event (all crew invited) stayed on every
 * calendar with nothing pointing back to it, and crew could turn up for a
 * cancelled shoot. Now a failed delete keeps the id + marks FAILED, and
 * sweepCancelledEvents (every reconcile tick) retries it and alerts ops.
 * Never throws.
 */
export async function removeCancelledBookingEvent(bookingId: string, eventId: string): Promise<boolean> {
  let ok = false
  try {
    ok = await deleteCalendarEvent(eventId)
  } catch (e: any) {
    console.error(`[calendar] delete of cancelled booking ${bookingId}'s event ${eventId} threw:`, e?.message || e)
  }
  if (!ok) console.error(`[calendar] cancelled booking ${bookingId}: event ${eventId} NOT deleted — kept the id for the reconcile sweep`)
  // CAS on the id: never clobber an event that something else re-pointed meanwhile
  const where = { id: bookingId, calendarEventId: eventId }
  try {
    if (!ok) {
      await prisma.booking.updateMany({
        where,
        data: { calendarSyncStatus: 'FAILED', calendarSyncError: CANCELLED_EVENT_DELETE_FAILED, calendarLastSyncedAt: new Date() },
      })
    } else {
      // Success clears the id + error but leaves calendarSyncStatus ALONE (prod
      // parity): PATCH/DELETE/MCP cancel always kept 'OK', soft-delete/routine
      // write NULL in their own update. A later force-status CANCELLED→CONFIRMED
      // relies on it — a CONFIRMED row with a sync status (or calendarLastSyncedAt)
      // and no event id is the reconciler's "create it + invite the crew" case,
      // which is how prod brings the event back today. The status is reset only
      // when it is this helper's OWN failure marker (a sweep retry that worked).
      const own = await prisma.booking.updateMany({
        where: { ...where, calendarSyncStatus: 'FAILED', calendarSyncError: CANCELLED_EVENT_DELETE_FAILED },
        data: { calendarEventId: null, calendarSyncError: null, calendarSyncStatus: null },
      })
      if (own.count === 0) {
        await prisma.booking.updateMany({ where, data: { calendarEventId: null, calendarSyncError: null } })
      }
    }
  } catch (e: any) {
    console.error(`[calendar] cancelled booking ${bookingId}: saving the event-delete result failed:`, e?.message || e)
  }
  return ok
}

/**
 * Edit paths patch the event's title/time/location fire-and-forget. A false
 * return (Google error — the function never throws) used to vanish: the save
 * showed success, calendarSyncStatus stayed OK, and the event kept the OLD time
 * for good. Now it marks FAILED (red chip + Re-sync on the admin card) and
 * processBooking re-pushes the details on the next tick. Never throws.
 */
export async function pushCalendarDetails(
  eventId: string,
  booking: Parameters<typeof updateCalendarEventDetails>[1],
  opts?: Parameters<typeof updateCalendarEventDetails>[2],
): Promise<boolean> {
  const ok = await updateCalendarEventDetails(eventId, booking, opts).catch(() => false)
  if (!ok) {
    console.error(`[calendar] details patch failed for ${booking.bookingCode || booking.id} (event ${eventId}) — marked FAILED`)
    await prisma.booking.updateMany({
      where: { id: booking.id, calendarEventId: eventId },
      data: { calendarSyncStatus: 'FAILED', calendarSyncError: DETAILS_PATCH_FAILED, calendarLastSyncedAt: new Date() },
    }).catch(e => console.error('[calendar] save FAILED (details) error:', e?.message || e))
  }
  return ok
}

function sameInstant(a: string, b: string | null | undefined): boolean {
  return !!b && new Date(a).getTime() === new Date(b).getTime()
}

type TimeDrift = { event: { start: string; end: string }; booking: { start: string; end: string } }
const DRIFT_SETTLE_MS = 5 * 60_000
/** the SAME drifting set is re-alerted once a day; a changed set is news at once (its own alertOps key) */
export const DRIFT_SAME_SET_EVERY_MS = 24 * 3_600_000

/** Fingerprint of the drifting set (codes + both sides' times) — the alertOps key suffix. */
export function driftSetKey(items: Array<Pick<ReconcileItem, 'bookingId' | 'bookingCode' | 'timeDrift'>>): string {
  const lines = items.map(i => {
    const d = i.timeDrift!
    return [i.bookingCode || i.bookingId, d.event.start, d.event.end, d.booking.start, d.booking.end].join('|')
  })
  return createHash('sha1').update(lines.sort().join('\n')).digest('hex').slice(0, 16)
}

/**
 * The reconciler retried an edit's failed details patch and Google refused again.
 * Keep the marker (next tick retries) — but ONE reconcile_failed audit row per
 * failing streak, not one every 10 minutes: skip when the newest of this
 * booking's failed/details_patched rows is already this same failure.
 * Never throws.
 */
async function markDetailsRetryFailed(
  booking: { id: string; bookingCode: string | null; calendarEventId?: string | null },
  assignedEmails: string[],
  options: ProcessOptions,
) {
  await prisma.booking.update({
    where: { id: booking.id },
    data: { calendarSyncStatus: 'FAILED', calendarSyncError: DETAILS_PATCH_FAILED, calendarLastSyncedAt: new Date() },
  }).catch(e => console.error('[calendar-reconcile] save FAILED (details retry) error:', e?.message || e))
  try {
    const last = await prisma.auditLog.findFirst({
      where: { entityType: 'Booking', entityId: booking.id, action: { in: ['calendar.reconcile_failed', 'calendar.reconcile_details_patched'] } },
      orderBy: { at: 'desc' },
      select: { action: true, changes: true },
    })
    const c: any = last?.changes
    if (last?.action === 'calendar.reconcile_failed' && c?.reason === 'details-retry-failed' && c?.eventId === (booking.calendarEventId ?? null)) return
  } catch (e: any) {
    console.warn(`[calendar-reconcile] details-retry audit lookup failed for ${booking.bookingCode || booking.id} — logging anyway:`, e?.message || e)
  }
  await logAudit({
    actorEmail: options.actorEmail ?? 'calendar-reconcile',
    action: 'calendar.reconcile_failed',
    entityType: 'Booking',
    entityId: booking.id,
    bookingCode: booking.bookingCode,
    changes: { eventId: booking.calendarEventId ?? null, assignedEmails, error: DETAILS_PATCH_FAILED, reason: 'details-retry-failed' },
  }).catch(e => console.error('[calendar-reconcile] details-retry audit write failed:', e?.message || e))
}

/**
 * One audit row per DISTINCT drift (same event times vs same booking times =
 * already recorded), not one per 10-minute tick. Never throws — reporting must
 * not turn the booking's reconcile into 'failed'.
 */
async function auditTimeDrift(
  booking: { id: string; bookingCode: string | null; calendarEventId?: string | null },
  drift: TimeDrift,
  options: ProcessOptions,
) {
  const changes = { eventId: booking.calendarEventId ?? null, ...drift }
  // field-by-field: jsonb reorders keys, so JSON.stringify of the stored row never matches
  const sig = (c: any) => [c?.eventId, c?.event?.start, c?.event?.end, c?.booking?.start, c?.booking?.end].join('|')
  try {
    const last = await prisma.auditLog.findFirst({
      where: { entityType: 'Booking', entityId: booking.id, action: 'calendar.reconcile_time_drift' },
      orderBy: { at: 'desc' },
      select: { changes: true },
    })
    if (last && sig(last.changes) === sig(changes)) return
  } catch (e: any) {
    console.warn(`[calendar-reconcile] drift audit lookup failed for ${booking.bookingCode || booking.id} — logging anyway:`, e?.message || e)
  }
  await logAudit({
    actorEmail: options.actorEmail ?? 'calendar-reconcile',
    action: 'calendar.reconcile_time_drift',
    entityType: 'Booking',
    entityId: booking.id,
    bookingCode: booking.bookingCode,
    changes,
  })
}

type ReconcileAction = 'ok' | 'patched' | 'created' | 'failed' | 'skipped'

/**
 * v1.148.0 — backfill a reconciler-created event id into the Bookings-tab row
 * (col W). The approve route writes the id on its own success path, but events
 * created/recreated HERE (because the approve-time create failed or the event
 * went stale) never reached the sheet, leaving Calendar Event ID blank — or
 * stale — forever. Downstream (PMDC's Airtable sync) dedupes Service Jobs by
 * this id, so a blank costs a merge. Fire-and-forget; benign 'not-found' when
 * the booking has no sheet row.
 */
function syncEventIdToSheet(
  booking: { sheetRowIndex?: number | null; bookingCode: string | null },
  eventId: string,
) {
  if (!booking.sheetRowIndex) return
  updateBookingRow(booking.bookingCode || '', { calendarEventId: eventId }).catch(() => {})
}

export type ReconcileItem = {
  bookingId: string
  bookingCode: string | null
  eventId: string | null
  htmlLink?: string | null
  action: ReconcileAction
  assignedEmails: string[]
  calendarAttendees?: string[]
  error?: string
  /** event start/end ≠ the booking's — reported (audit + alertOps), NOT patched */
  timeDrift?: TimeDrift
}

export type ReconcileResult = {
  checked: number
  ok: number
  patched: number
  created: number
  failed: number
  skipped: number
  items: ReconcileItem[]
  /** v1.185.2 — true = ชนเพดาน limit; ยังมีงานที่วันถ่ายไกลกว่านี้ที่ยังไม่ถูกตรวจ */
  truncated?: boolean
  /** ใบที่ยกเลิก/ลบแล้วแต่ยังถือ event อยู่ (ลบไม่สำเร็จตอนยกเลิก) — ดู sweepCancelledEvents */
  cancelledEvents?: { found: number; deleted: number; failed: number }
}

const DEFAULT_LIMIT = 200   // v1.233 — 65 ใบเข้าเงื่อนไขวันนี้ cap 50 = 15 ใบท้ายไม่เคยถูกแตะ

function cleanEmails(emails: string[] | null | undefined): string[] {
  return Array.from(new Set(
    (emails || [])
      .map(email => email.trim().toLowerCase())
      .filter(Boolean),
  )).sort()
}

function sameEmails(a: string[], b: string[]): boolean {
  return JSON.stringify(cleanEmails(a)) === JSON.stringify(cleanEmails(b))
}

function count(result: ReconcileResult, action: ReconcileAction) {
  result[action] += 1
}

// Shape used by processBooking. Mirrors the Prisma findMany() include
// (outlet, program, episodes) so the same input can come from a list query
// (reconcileCalendarGuests) or a single fetch (reconcileSingleBooking).
type BookingForReconcile = {
  id: string
  bookingCode: string | null
  readyNotifiedAt?: Date | string | null // v1.288 — a re-created event keeps ✅ + the box link
  driveFolders?: unknown
  status: string
  shootDate: Date | string
  shootEndDate?: Date | string | null
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  videoType?: string | null
  locationName?: string | null
  producer: string
  producerEmail?: string | null
  // Co-Producer is a guest (calendar-attendees) AND a description line — the
  // three create payloads below used to drop both, so a reconciler-created event
  // invited the Co-Producer only on the NEXT tick's attendee patch (re-notifying
  // every guest) and never got the "Co-Producer:" line.
  coProducer?: string | null
  coProducerEmail?: string | null
  directorEmail?: string | null
  director2Email?: string | null
  director3Email?: string | null
  calendarSyncStatus?: string | null
  /** DETAILS_PATCH_FAILED here = an edit's details patch never reached Google → retried with sendUpdates 'all' */
  calendarSyncError?: string | null
  /** a row saved in the last few minutes may have its edit patch in flight — not drift yet */
  updatedAt?: Date | string | null
  cameraCount?: number | null
  micCount?: number | null
  vanCount?: number | null
  isBlockShot?: boolean | null
  // v1.146 review fix — these two were missing from this type AND the three
  // create payloads below, so any event the reconciler created/recreated lost
  // the special-equipment list from its description and (for AGN) the project
  // show name from its title. Same class of bug as the v1.113.1 fix.
  specialEquipment?: string[] | null
  projectName?: string | null
  equipmentNote?: string | null
  rentalGearNote?: string | null
  freelancers?: unknown
  assignedEmails: string[]
  crewRequired: string[]
  agencyRef?: string | null
  notes?: string | null
  adminNotes?: string | null
  calendarEventId?: string | null
  // v1.148.0 — lets syncEventIdToSheet know whether the booking has a
  // Bookings-tab row to patch. Present on both the findMany() and the
  // single-booking fetch (all Booking scalars come with include).
  sheetRowIndex?: number | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ episodeId: string; title: string }>
}

type ProcessOptions = {
  actorEmail?: string | null
  dryRun?: boolean
}

// v1.131 — the Producer is invited as a calendar guest alongside crew (see
// google-calendar.ts createCalendarEvent). The reconciler's job is to keep
// calendar attendees matching "the correct set" — so that correct set must
// include the producer too, or the very next tick "fixes" the event by
// patching the producer back out. Same for the Director picked at booking
// time (v1.143) — omit them here and the reconciler un-invites them nightly.
async function createVerifiedCalendarEvent(booking: {
  id: string
  bookingCode?: string | null
  readyNotifiedAt?: Date | string | null // v1.288
  driveFolders?: unknown
  shootDate: Date | string
  shootEndDate?: Date | string | null
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  videoType?: string | null
  locationName?: string | null
  producer: string
  producerEmail?: string | null
  coProducer?: string | null
  coProducerEmail?: string | null
  directorEmail?: string | null
  director2Email?: string | null
  director3Email?: string | null
  calendarSyncStatus?: string | null
  cameraCount?: number | null
  micCount?: number | null
  vanCount?: number | null
  isBlockShot?: boolean | null
  specialEquipment?: string[] | null
  projectName?: string | null
  equipmentNote?: string | null
  rentalGearNote?: string | null
  freelancers?: unknown
  assignedEmails: string[]
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ episodeId: string; title: string }>
  crewRequired: string[]
  agencyRef?: string | null
  notes?: string | null
  adminNotes?: string | null
}): Promise<{ eventId: string; htmlLink: string | null }> {
  // v1.29.3 — createCalendarEvent now throws specific errors instead of
  // returning null silently. We still defend against an unexpected null
  // (Google response without event.data.id) below, but the common
  // configuration / API-rejection cases bubble a real message up to the UI.
  const eventId = await createCalendarEvent(booking, {
    requireAttendees: booking.assignedEmails.length > 0,
  })
  if (!eventId) {
    throw new Error(
      'Google Calendar API returned an event with no id — likely a transient API anomaly; try Re-sync again, or check the AuditLog for the upstream details.',
    )
  }

  // ตัวตรวจนี้ต้องคำนวณลิสต์แขก **ด้วยฟังก์ชันตัวเดียวกับที่ createCalendarEvent
  // ใช้ส่ง** ไม่ใช่คำนวณเองซ้ำ: ถ้าสองฝั่งไม่ตรงกัน โค้ดข้างล่างจะ "ลบ event ที่
  // เพิ่งสร้างสำเร็จทิ้ง" แล้ว throw — v1.146 เคยพลาดตรงการ์ด AGN ของ director
  // มาแล้ว และ v1.185 (เพิ่ม Co-Producer) ก็จะพลาดซ้ำถ้ายังแยกกันคำนวณ
  const wantedAttendees = bookingCalendarAttendees({
    assignedEmails: booking.assignedEmails,
    producerEmail: booking.producerEmail,
    coProducerEmail: booking.coProducerEmail,
    directorEmail: booking.directorEmail,
    // v1.231 — ผู้กำกับคนที่ 2/3 อยู่ใต้การ์ด AGN-only เดียวกันใน calendar-attendees
    director2Email: booking.director2Email,
    director3Email: booking.director3Email,
    outletCode: booking.outlet.code,
  })
  const calendarEvent = await getCalendarEventAttendees(eventId)
  if (!sameEmails(wantedAttendees, calendarEvent.attendees)) {
    await deleteCalendarEvent(eventId)
    throw new Error(
      `created calendar event is missing assigned attendees (${wantedAttendees.join(', ') || 'none'})`,
    )
  }

  return { eventId, htmlLink: calendarEvent.htmlLink || null }
}

// Reconcile ONE booking. Used both by the bulk reconciler (worker every 10 min)
// and by the per-booking manual re-sync endpoint that powers the admin
// "Re-sync calendar" button. Same logic, same audit rows — the worker just
// loops over many bookings while the admin button triggers one.
async function processBooking(
  booking: BookingForReconcile,
  options: ProcessOptions,
): Promise<ReconcileItem> {
  const assignedEmails = cleanEmails(booking.assignedEmails)
  // v1.131 — "correct" calendar attendees = crew + producer; assignedEmails
  // (crew only) still drives the description's "Assigned:" line and the
  // ReconcileItem report below.
  // v1.146 review fix — Director auto-invite is AGN-only. Without this gate
  // the reconciler would actively PATCH the director back onto the calendar
  // event on every tick for non-AGN bookings, even though createCalendarEvent
  // never invites them at creation time for those outlets.
  // v1.185 — helper ที่เดียว (เพิ่ม Co-Producer เข้าลิสต์ด้วย) ดู calendar-attendees.ts
  const calendarAttendees = cleanEmails(bookingCalendarAttendees({
    assignedEmails,
    producerEmail: booking.producerEmail,
    coProducerEmail: booking.coProducerEmail,
    directorEmail: booking.directorEmail,
    // v1.231 — ผู้กำกับคนที่ 2/3 อยู่ใต้การ์ด AGN-only เดียวกันใน calendar-attendees
    director2Email: booking.director2Email,
    director3Email: booking.director3Email,
    outletCode: booking.outlet.code,
  }))
  const item: ReconcileItem = {
    bookingId: booking.id,
    bookingCode: booking.bookingCode,
    eventId: booking.calendarEventId ?? null,
    action: 'skipped',
    assignedEmails,
  }
  /** an edit's failed details patch was retried this tick and failed again */
  let detailsRetryFailed = false

  try {
    // v1.233 — เดิมเช็ค assignedEmails (ครูอย่างเดียว) ทั้งที่บรรทัดบนเพิ่งประกอบ
    // calendarAttendees = ครู + Producer + Co-Pro (+ Director ถ้า AGN) ซึ่งเป็น
    // ลิสต์ที่ createCalendarEvent ใช้จริง · ใบ routine มี assignedEmails ว่างแต่
    // มี producerEmail เสมอ → ลิสต์แขกไม่ว่าง แต่ถูก skip ทิ้งก่อนถึงทางสร้าง event
    // ผลคือใบ CONFIRMED ที่ยังไม่มี event ไม่เคยถูกสร้างให้ และไม่มีใครรู้
    if (calendarAttendees.length === 0) {
      item.action = 'skipped'
      item.error = 'ไม่มีผู้เข้าร่วมให้เชิญ (ไม่มีทั้งครู Producer และ Co-Producer)'
      // เขียนเวลาไว้ด้วย ไม่งั้นใบที่ค้าง PENDING + ไม่มีแขก จะเข้าเงื่อนไขสาขา 2
      // ทุก ๆ 10 นาทีตลอดไป กินสล็อตใน cap โดยไม่มีวันเปลี่ยนอะไร
      if (!options.dryRun && booking.calendarSyncStatus === 'PENDING') {
        await prisma.booking.update({
          where: { id: booking.id },
          data: { calendarLastSyncedAt: new Date() },
        }).catch(() => {})
      }
      return item
    }

    if (!booking.calendarEventId) {
      if (options.dryRun) {
        item.action = 'created'
        return item
      }
      const { eventId, htmlLink } = await createVerifiedCalendarEvent({
        id: booking.id,
        bookingCode: booking.bookingCode,
        readyNotifiedAt: booking.readyNotifiedAt,
        driveFolders: booking.driveFolders,
        shootDate: booking.shootDate,
        shootEndDate: booking.shootEndDate,
        callTime: booking.callTime,
        estimatedWrap: booking.estimatedWrap,
        shootType: booking.shootType,
        videoType: booking.videoType,
        locationName: booking.locationName,
        producer: booking.producer,
        producerEmail: booking.producerEmail,
        coProducer: booking.coProducer,
        coProducerEmail: booking.coProducerEmail,
        directorEmail: booking.directorEmail,
        director2Email: booking.director2Email,
        director3Email: booking.director3Email,
        cameraCount: booking.cameraCount,
        micCount: booking.micCount,
        vanCount: booking.vanCount,
        isBlockShot: booking.isBlockShot,
        specialEquipment: booking.specialEquipment,
        projectName: booking.projectName,
        equipmentNote: booking.equipmentNote,
        rentalGearNote: booking.rentalGearNote,
        freelancers: booking.freelancers,
        assignedEmails,
        outlet: booking.outlet,
        program: booking.program,
        episodes: booking.episodes,
        crewRequired: booking.crewRequired,
        agencyRef: booking.agencyRef,
        notes: booking.notes,
        adminNotes: booking.adminNotes,
      })
      // v1.111 — compare-and-swap: only claim if calendarEventId is STILL null.
      // Approve/assign background creates can win this window; blindly writing
      // overwrote their id and left their event as a calendar duplicate.
      // v1.146 review fix — also re-check status/deletedAt (matches approve.ts's
      // CAS): a booking cancelled/soft-deleted while this event was being
      // created must not get the fresh event attached to it.
      const saved = await prisma.booking.updateMany({
        where: { id: booking.id, status: 'CONFIRMED', deletedAt: null, calendarEventId: null },
        data: {
          calendarEventId: eventId,
          // v1.32.2 — record sync state alongside the event id so UI
          // and reconciler queries can rely on a single source of truth.
          calendarSyncStatus: 'OK',
          calendarSyncError: null,
          calendarLastSyncedAt: new Date(),
        },
      })
      if (saved.count === 0) {
        console.warn(`[calendar-reconcile] booking ${booking.id} got an event mid-create — deleting duplicate ${eventId}`)
        await deleteCalendarEvent(eventId).catch(() => {})
        const winner = await prisma.booking.findUnique({ where: { id: booking.id }, select: { calendarEventId: true } })
        item.action = 'ok'
        item.eventId = winner?.calendarEventId ?? null
        return item
      }
      item.action = 'created'
      item.eventId = eventId
      item.htmlLink = htmlLink
      syncEventIdToSheet(booking, eventId)
      await logAudit({
        actorEmail: options.actorEmail ?? 'calendar-reconcile',
        action: 'calendar.reconcile_created',
        entityType: 'Booking',
        entityId: booking.id,
        bookingCode: booking.bookingCode,
        changes: { eventId, assignedEmails },
      })
      return item
    }

    const calendarEvent = await getCalendarEventAttendees(booking.calendarEventId)
    item.calendarAttendees = calendarEvent.attendees
    item.htmlLink = calendarEvent.htmlLink || null

    if (!calendarEvent.exists) {
      if (options.dryRun) {
        item.action = 'created'
        return item
      }
      const { eventId, htmlLink } = await createVerifiedCalendarEvent({
        id: booking.id,
        bookingCode: booking.bookingCode,
        readyNotifiedAt: booking.readyNotifiedAt,
        driveFolders: booking.driveFolders,
        shootDate: booking.shootDate,
        shootEndDate: booking.shootEndDate,
        callTime: booking.callTime,
        estimatedWrap: booking.estimatedWrap,
        shootType: booking.shootType,
        videoType: booking.videoType,
        locationName: booking.locationName,
        producer: booking.producer,
        producerEmail: booking.producerEmail,
        coProducer: booking.coProducer,
        coProducerEmail: booking.coProducerEmail,
        directorEmail: booking.directorEmail,
        director2Email: booking.director2Email,
        director3Email: booking.director3Email,
        cameraCount: booking.cameraCount,
        micCount: booking.micCount,
        vanCount: booking.vanCount,
        isBlockShot: booking.isBlockShot,
        specialEquipment: booking.specialEquipment,
        projectName: booking.projectName,
        equipmentNote: booking.equipmentNote,
        rentalGearNote: booking.rentalGearNote,
        freelancers: booking.freelancers,
        assignedEmails,
        outlet: booking.outlet,
        program: booking.program,
        episodes: booking.episodes,
        crewRequired: booking.crewRequired,
        agencyRef: booking.agencyRef,
        notes: booking.notes,
        adminNotes: booking.adminNotes,
      })
      // v1.111 — compare-and-swap: replace ONLY if the id is still the vanished
      // one. If something else re-pointed the booking meanwhile, drop ours.
      // v1.146 review fix — also re-check status/deletedAt (matches approve.ts's
      // CAS): a booking cancelled/soft-deleted mid-recreate must not get the
      // fresh event attached to it.
      const savedRe = await prisma.booking.updateMany({
        where: { id: booking.id, status: 'CONFIRMED', deletedAt: null, calendarEventId: booking.calendarEventId },
        data: {
          calendarEventId: eventId,
          calendarSyncStatus: 'OK',
          calendarSyncError: null,
          calendarLastSyncedAt: new Date(),
        },
      })
      if (savedRe.count === 0) {
        console.warn(`[calendar-reconcile] booking ${booking.id} re-pointed mid-recreate — deleting duplicate ${eventId}`)
        await deleteCalendarEvent(eventId).catch(() => {})
        const winner = await prisma.booking.findUnique({ where: { id: booking.id }, select: { calendarEventId: true } })
        item.action = 'ok'
        item.eventId = winner?.calendarEventId ?? null
        return item
      }
      item.action = 'created'
      item.eventId = eventId
      item.htmlLink = htmlLink
      syncEventIdToSheet(booking, eventId)
      await logAudit({
        actorEmail: options.actorEmail ?? 'calendar-reconcile',
        action: 'calendar.reconcile_recreated',
        entityType: 'Booking',
        entityId: booking.id,
        bookingCode: booking.bookingCode,
        changes: { oldEventId: booking.calendarEventId, eventId, assignedEmails },
      })
      return item
    }

    // Details (time/title/location), not just guests.
    //
    // (a) RETRY a failed edit — ONLY a row pushCalendarDetails marked FAILED with
    //     DETAILS_PATCH_FAILED: the edit (new call time etc.) never reached Google,
    //     so the crew were never told → sendUpdates 'all', the email the edit path
    //     meant to send. A failed retry does NOT stop the tick: guests are still
    //     compared/patched below (a persistent Google 4xx must not lock the booking
    //     out of crew sync), then the row goes back to FAILED with the SAME marker
    //     so the next tick retries — one audit row per failing streak
    //     (markDetailsRetryFailed). Rows FAILED for other reasons (attendee patch,
    //     create) are NOT re-pushed here.
    // (b) Pure DRIFT (event start/end ≠ the booking — someone moved the event by
    //     hand in Google Calendar, or an old version wrote other times) is REPORTED,
    //     never patched: silently reverting a coordinator's hand move is a behaviour
    //     change Nat has not approved (maint 2026-11-08 R2). → item.timeDrift, a
    //     deduped audit row here, one alertOps per tick in reconcileCalendarGuests.
    //     Title is not compared — formats changed over versions.
    const wantTimes = computeEventTimes(booking)
    let detailsPatched = false
    if (booking.calendarSyncStatus === 'FAILED' && booking.calendarSyncError === DETAILS_PATCH_FAILED) {
      if (!options.dryRun) {
        const ok = await updateCalendarEventDetails(booking.calendarEventId, booking, { sendUpdates: 'all' })
          .catch((e: any) => { console.error(`[calendar-reconcile] details retry threw for ${booking.bookingCode || booking.id}:`, e?.message || e); return false })
        if (!ok) {
          detailsRetryFailed = true
          console.error(`[calendar-reconcile] ${booking.bookingCode || booking.id}: retry of the failed details patch failed again — guests still checked, row stays FAILED`)
        } else {
          await logAudit({
            actorEmail: options.actorEmail ?? 'calendar-reconcile',
            action: 'calendar.reconcile_details_patched',
            entityType: 'Booking',
            entityId: booking.id,
            bookingCode: booking.bookingCode,
            changes: {
              eventId: booking.calendarEventId,
              reason: 'retry-after-failed-edit',
              sendUpdates: 'all',
              from: { start: calendarEvent.start ?? null, end: calendarEvent.end ?? null },
              to: { start: wantTimes.startTime, end: wantTimes.endTime },
            },
          })
        }
      }
      detailsPatched = !detailsRetryFailed
    } else if (
      // no start/end from Google = unknown, not drift
      calendarEvent.start && calendarEvent.end
      // saved < 5 min ago: the edit path's own patch may still be in flight
      && !(booking.updatedAt && Date.now() - new Date(booking.updatedAt).getTime() < DRIFT_SETTLE_MS)
      && (!sameInstant(wantTimes.startTime, calendarEvent.start) || !sameInstant(wantTimes.endTime, calendarEvent.end))
    ) {
      item.timeDrift = {
        event: { start: calendarEvent.start, end: calendarEvent.end },
        booking: { start: wantTimes.startTime, end: wantTimes.endTime },
      }
      if (!options.dryRun) await auditTimeDrift(booking, item.timeDrift, options)
    }

    // End-of-tick state. 'OK' is written with a CAS on the updatedAt this tick
    // read: an edit's pushCalendarDetails can mark the row FAILED /
    // DETAILS_PATCH_FAILED while this tick runs, and an unconditional 'OK'
    // erased that marker — the edit's title/location never reached Google and
    // nothing retried it. Lost CAS = the row changed; the next tick re-checks.
    const finish = async () => {
      if (detailsRetryFailed) {
        await markDetailsRetryFailed(booking, assignedEmails, options)
        item.action = 'failed'
        item.error = DETAILS_PATCH_FAILED
        return
      }
      const saved = await prisma.booking.updateMany({
        where: { id: booking.id, ...(booking.updatedAt ? { updatedAt: new Date(booking.updatedAt) } : {}) },
        data: { calendarSyncStatus: 'OK', calendarSyncError: null, calendarLastSyncedAt: new Date() },
      })
      if (saved.count === 0) {
        console.warn(`[calendar-reconcile] ${booking.bookingCode || booking.id} changed during this tick — 'OK' not written (a concurrent edit's FAILED marker wins); next tick re-checks`)
      }
    }

    if (sameEmails(calendarAttendees, calendarEvent.attendees)) {
      item.action = detailsPatched ? 'patched' : 'ok'
      // Even when nothing changes, refresh the OK timestamp so the UI
      // can show "last verified N min ago" and the stale-PENDING
      // reconciler clause works correctly.
      if (!options.dryRun) await finish()
      return item
    }

    if (!options.dryRun) {
      const ok = await updateCalendarEventAttendees(booking.calendarEventId, calendarAttendees, {
        bookingId: booking.id,
        bookingCode: booking.bookingCode,
      })
      if (!ok) {
        const oldEventId = booking.calendarEventId
        const { eventId, htmlLink } = await createVerifiedCalendarEvent({
          id: booking.id,
          bookingCode: booking.bookingCode,
          readyNotifiedAt: booking.readyNotifiedAt,
          driveFolders: booking.driveFolders,
          shootDate: booking.shootDate,
          shootEndDate: booking.shootEndDate,
          callTime: booking.callTime,
          estimatedWrap: booking.estimatedWrap,
          shootType: booking.shootType,
          // v1.113.1 — this re-create path (attendees-patch failure) used to drop
          // these fields, so the replacement event lost 🚐/🧱 and equipment info.
          videoType: booking.videoType,
          locationName: booking.locationName,
          producer: booking.producer,
          producerEmail: booking.producerEmail,
          coProducer: booking.coProducer,
          coProducerEmail: booking.coProducerEmail,
          directorEmail: booking.directorEmail,
          director2Email: booking.director2Email,
          director3Email: booking.director3Email,
          cameraCount: booking.cameraCount,
          micCount: booking.micCount,
          vanCount: booking.vanCount,
          isBlockShot: booking.isBlockShot,
          specialEquipment: booking.specialEquipment,
          projectName: booking.projectName,
          equipmentNote: booking.equipmentNote,
          rentalGearNote: booking.rentalGearNote,
          freelancers: booking.freelancers,
          assignedEmails,
          outlet: booking.outlet,
          program: booking.program,
          episodes: booking.episodes,
          crewRequired: booking.crewRequired,
          agencyRef: booking.agencyRef,
          notes: booking.notes,
          adminNotes: booking.adminNotes,
        })
        // v1.146 review fix — this path previously wrote back with a plain
        // `update` (no compare-and-swap at all), unlike the two sibling
        // create/recreate paths above. A booking cancelled/soft-deleted while
        // the attendees-patch retry was in flight could get this fresh event
        // attached to it, with no cleanup path ever touching it afterward.
        const savedPatchFail = await prisma.booking.updateMany({
          where: { id: booking.id, status: 'CONFIRMED', deletedAt: null, calendarEventId: oldEventId },
          data: {
            calendarEventId: eventId,
            calendarSyncStatus: 'OK',
            calendarSyncError: null,
            calendarLastSyncedAt: new Date(),
          },
        })
        if (savedPatchFail.count === 0) {
          console.warn(`[calendar-reconcile] booking ${booking.id} changed state mid-recreate (attendees-patch-failure path) — deleting duplicate ${eventId}`)
          await deleteCalendarEvent(eventId).catch(() => {})
          const winner = await prisma.booking.findUnique({ where: { id: booking.id }, select: { calendarEventId: true } })
          item.action = 'ok'
          item.eventId = winner?.calendarEventId ?? null
          return item
        }
        await deleteCalendarEvent(oldEventId)

        item.action = 'created'
        delete item.timeDrift // the new event carries the booking's times
        item.eventId = eventId
        item.htmlLink = htmlLink
        syncEventIdToSheet(booking, eventId)
        await logAudit({
          actorEmail: options.actorEmail ?? 'calendar-reconcile',
          action: 'calendar.reconcile_recreated',
          entityType: 'Booking',
          entityId: booking.id,
          bookingCode: booking.bookingCode,
          changes: {
            oldEventId,
            eventId,
            assignedEmails,
            reason: 'attendees_patch_failed',
          },
        })
        return item
      }
    }

    item.action = 'patched'
    if (!options.dryRun) {
      // the guests WERE patched; a failed details retry still turns the item 'failed'
      await finish()
      // dryRun = the read-only check /admin/<id> runs on EVERY page load: it must
      // not write "patched" rows for a patch that never happened (offboard.py
      // counts reconcile_patched rows to verify a leaver was removed).
      await logAudit({
        actorEmail: options.actorEmail ?? 'calendar-reconcile',
        action: 'calendar.reconcile_patched',
        entityType: 'Booking',
        entityId: booking.id,
        bookingCode: booking.bookingCode,
        changes: {
          eventId: booking.calendarEventId,
          fromAttendees: calendarEvent.attendees,
          // v1.185.1 — เคยบันทึก `assignedEmails` (ลิสต์ครูเปล่า ๆ) ทั้งที่ค่าที่ patch
          // ไปจริงคือ `calendarAttendees` (ครู + Producer + Co-Producer + Director)
          // ผลคือ audit บอกว่า Producer/Co-Producer ไม่ได้อยู่ในลิสต์แขก ทั้งที่อยู่ —
          // เจอเพราะไล่เคส "แก้วมาปฏิทินหรือยัง" แล้ว audit ตอบว่าไม่มา แต่ปฏิทินจริงมี
          // audit ที่รายงานไม่ตรงของจริงแย่กว่าไม่มี audit เพราะมันทำให้สรุปผิด
          toAttendees: calendarAttendees,
          crewOnly: assignedEmails,
        },
      })
    }
    return item
  } catch (e: any) {
    item.action = 'failed'
    const errMsg = e?.message || String(e)
    item.error = errMsg
    // v1.32.2 — record FAILED on the booking row so the admin UI flips
    // to a red chip; the next 10-min reconciler tick will retry.
    if (!options.dryRun) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          calendarSyncStatus: 'FAILED',
          // the details marker is what makes the next tick re-push the edit —
          // a later step's error (guests/recreate, retried every tick anyway)
          // must not overwrite it; the real error is in the audit row
          calendarSyncError: (detailsRetryFailed ? DETAILS_PATCH_FAILED : errMsg).slice(0, 500),
          calendarLastSyncedAt: new Date(),
        },
      }).catch(err => console.error('save FAILED status error:', err?.message))
      // dryRun (admin page view) reports the error in the item; it is not a
      // reconciler failure and must not read like one in the audit log.
      await logAudit({
        actorEmail: options.actorEmail ?? 'calendar-reconcile',
        action: 'calendar.reconcile_failed',
        entityType: 'Booking',
        entityId: booking.id,
        bookingCode: booking.bookingCode,
        changes: {
          eventId: booking.calendarEventId,
          assignedEmails,
          error: item.error,
        },
      })
    }
    return item
  }
}

export async function reconcileCalendarGuests(options: {
  limit?: number
  actorEmail?: string | null
  dryRun?: boolean
} = {}): Promise<ReconcileResult> {
  const limit = Math.max(1, Math.min(options.limit || DEFAULT_LIMIT, 200))
  const result: ReconcileResult = {
    checked: 0,
    ok: 0,
    patched: 0,
    created: 0,
    failed: 0,
    skipped: 0,
    items: [],
  }

  // v1.32.2 — also pick up rows orphaned by a mid-task container restart
  // (calendarSyncStatus stays PENDING because the background task never
  // completed). 5-minute staleness threshold so a normal in-flight approve
  // isn't double-processed by the next reconciler tick.
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
  const bookings = await prisma.booking.findMany({
    where: {
      // v1.51 — never manage calendar events for soft-deleted bookings
      deletedAt: null,
      OR: [
        {
          status: 'CONFIRMED',
          // v1.233 — เดิมกรอง assignedEmails ไม่ว่าง ทำให้ใบไร้ครู (งาน routine
          // ทุกใบ) ที่สร้าง event ไม่สำเร็จ ค้าง FAILED โดยไม่เข้าสาขาไหนเลย
          // = CONFIRMED แต่ไม่มีปฏิทิน ตลอดไป แบบไม่มีใครเห็น
          // processBooking กรองด้วยลิสต์แขกจริงอยู่แล้ว ตรงนี้จึงไม่ต้องกรองซ้ำ
          // v1.54.1 — skip rows whose approve background-create is still in
          // flight (fresh PENDING) so the reconciler can't double-create the
          // event in the seconds between approve commit and eventId save.
          NOT: {
            calendarSyncStatus: 'PENDING',
            calendarLastSyncedAt: { gte: fiveMinutesAgo },
          },
        },
        {
          // v1.54.1 — status filter added: a booking cancelled while stuck
          // PENDING must not get a brand-new event minted for it.
          status: 'CONFIRMED',
          calendarSyncStatus: 'PENDING',
          calendarLastSyncedAt: { lt: fiveMinutesAgo },
        },
      ],
    },
    include: {
      outlet: true,
      program: true,
      episodes: { orderBy: EPISODE_ORDER, include: { program: { select: { code: true, name: true } } } },
    },
    orderBy: [{ shootDate: 'asc' }, { updatedAt: 'desc' }],
    take: limit,
  })

  for (const booking of bookings) {
    result.checked += 1
    const item = await processBooking(booking as BookingForReconcile, {
      actorEmail: options.actorEmail,
      dryRun: options.dryRun,
    })
    result.items.push(item)
    count(result, item.action)
  }

  // v1.185.2 — NO SILENT CAPS. `take: limit` + `orderBy shootDate asc` หมายความว่า
  // ถ้าคิวยาวเกิน limit **งานที่ถ่ายไกลออกไปจะไม่เคยถูก reconcile เลย** ไม่ใช่
  // "ช้าหน่อย" แต่คือไม่มีวันถึง เพราะลำดับคงที่ทุกรอบ
  //
  // เจอจริง 2026-08-21: prod มี CONFIRMED+มีครู 62 ใบ, worker default limit=50 →
  // งาน 22 ก.ย.–11 ธ.ค. (แถวที่ 51-62) ไม่ถูกแตะเลย ต้องยิงมือด้วย ?limit=200
  // ปฏิทินของงานพวกนั้นจึงเพี้ยนค้างได้เรื่อย ๆ โดยไม่มีใครรู้
  if (bookings.length >= limit) {
    result.truncated = true
    console.warn(
      `[calendar-reconcile] hit limit ${limit} — งานที่วันถ่ายไกลกว่านี้ยังไม่ถูกตรวจ ` +
      `(ลำดับคงที่ทุกรอบ จึงไม่ใช่ว่ารอบหน้าจะถึง) เพิ่ม ?limit= หรือขยาย default`,
    )
  }

  // Pure time drift is reported, never auto-patched (see processBooking). One
  // alert per tick listing every drifted job, keyed by a fingerprint of the
  // drifting SET: a changed set (new job, or an event moved again) is news at
  // once; the same set repeats only once a day (a fixed key re-sent the same
  // list every 6 h until someone fixed every legacy event).
  const drifted = result.items.filter(i => i.timeDrift)
  if (drifted.length > 0 && !options.dryRun) {
    const fmt = (s: string) => new Date(s).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' })
    const lines = drifted.slice(0, 20).map(i =>
      `${i.bookingCode || i.bookingId}: ปฏิทิน ${fmt(i.timeDrift!.event.start)}–${fmt(i.timeDrift!.event.end)} · ใบจอง ${fmt(i.timeDrift!.booking.start)}–${fmt(i.timeDrift!.booking.end)}`)
    if (drifted.length > 20) lines.push(`…และอีก ${drifted.length - 20} ใบ`)
    await alertOps(`calendar-time-drift:${driftSetKey(drifted)}`,
      `⚠️ เวลาใน Google Calendar ไม่ตรงใบจอง — ${drifted.length} ใบ`,
      `เวลา event ในปฏิทินไม่ตรงกับใบจอง (มีคนย้าย event ในปฏิทินเอง หรือแก้ใบจองแล้วปฏิทินไม่ตาม) — ระบบไม่แก้ให้เอง ` +
      `เพราะไม่รู้ว่าฝั่งไหนถูก:\n  ${lines.join('\n  ')}\n` +
      `ถ้าใบจองถูก → แก้เวลาใบจองแล้วบันทึกซ้ำ (ส่งเวลาเข้า event + เมลแจ้งทีม) · ถ้าปฏิทินถูก → แก้เวลาในใบจองให้ตรง\n` +
      `(ชุดเดิมเตือนซ้ำวันละครั้ง · ชุดเปลี่ยน = เตือนใหม่)`,
      DRIFT_SAME_SET_EVERY_MS)
  }

  await sweepCancelledEvents(result, options)
  return result
}

const CANCELLED_SWEEP_LIMIT = 50

/**
 * Cancelled / soft-deleted bookings that still hold a calendarEventId = the
 * cancel-time delete failed (removeCancelledBookingEvent kept the id). Nothing
 * else ever looks at these rows (the main query is CONFIRMED-only and
 * calendar-dedupe leaves CANCELLED alone), so this is the only retry. A failure
 * here is loud: alertOps, plus result.failed so the worker log line fires.
 * Rotates by updatedAt (a failed retry bumps it) so a stuck row can't starve the rest.
 */
async function sweepCancelledEvents(result: ReconcileResult, options: { actorEmail?: string | null; dryRun?: boolean }) {
  const rows = await prisma.booking.findMany({
    where: {
      calendarEventId: { not: null },
      OR: [{ status: 'CANCELLED' }, { deletedAt: { not: null } }],
    },
    select: { id: true, bookingCode: true, calendarEventId: true, assignedEmails: true },
    orderBy: { updatedAt: 'asc' },
    take: CANCELLED_SWEEP_LIMIT,
  })
  const stats = { found: rows.length, deleted: 0, failed: 0 }
  result.cancelledEvents = stats
  if (rows.length === 0 || options.dryRun) return

  const failedCodes: string[] = []
  for (const r of rows) {
    const ok = await removeCancelledBookingEvent(r.id, r.calendarEventId!)
    if (ok) {
      stats.deleted += 1
      await logAudit({
        actorEmail: options.actorEmail ?? 'calendar-reconcile',
        action: 'calendar.cancelled_event_deleted',
        entityType: 'Booking',
        entityId: r.id,
        bookingCode: r.bookingCode,
        changes: { eventId: r.calendarEventId },
      })
      continue
    }
    stats.failed += 1
    failedCodes.push(r.bookingCode || r.id)
    result.failed += 1
    result.items.push({
      bookingId: r.id,
      bookingCode: r.bookingCode,
      eventId: r.calendarEventId,
      action: 'failed',
      assignedEmails: cleanEmails(r.assignedEmails),
      error: CANCELLED_EVENT_DELETE_FAILED,
    })
  }
  if (failedCodes.length > 0) {
    await alertOps('calendar-cancelled-events',
      `⚠️ งานยกเลิกแล้วแต่ event ยังอยู่ในปฏิทิน — ${failedCodes.length} ใบ`,
      `ลบ event ของงานที่ยกเลิก/ลบแล้วไม่สำเร็จ (Google ตอบ error) — ทีมยังเห็นงานในปฏิทินและอาจไปถ่ายงานที่ยกเลิก:\n  ${failedCodes.join('\n  ')}` +
      `\nreconciler ลองใหม่ทุก 10 นาทีเอง · ถ้ายังค้าง ลบ event ในปฏิทินด้วยมือ (Production ID อยู่ในรายละเอียด event)`)
  }
}

// Reconcile a single booking by id. Powers /api/admin/[id]/calendar-resync
// (the "Re-sync calendar" button on the booking card). Returns null if the
// booking doesn't exist; otherwise the same ReconcileItem shape used by the
// bulk worker — so the UI can display the same { action, eventId, htmlLink,
// error } regardless of how the reconcile was triggered.
export async function reconcileSingleBooking(
  bookingId: string,
  options: ProcessOptions = {},
): Promise<ReconcileItem | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      outlet: true,
      program: true,
      episodes: { orderBy: EPISODE_ORDER, include: { program: { select: { code: true, name: true } } } },
    },
  })
  if (!booking) return null
  if (booking.deletedAt) {
    // v1.51 — soft-deleted bookings never get calendar events
    return {
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      eventId: null,
      action: 'skipped',
      assignedEmails: cleanEmails(booking.assignedEmails),
      error: 'booking is deleted',
    }
  }
  if (booking.status !== 'CONFIRMED') {
    // Don't create calendar events for bookings that aren't approved.
    // Same invariant the bulk reconciler enforces via its WHERE clause.
    return {
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      eventId: booking.calendarEventId ?? null,
      action: 'skipped',
      assignedEmails: cleanEmails(booking.assignedEmails),
      error: `booking status is ${booking.status} — only CONFIRMED bookings get a calendar event`,
    }
  }
  return processBooking(booking as BookingForReconcile, options)
}
