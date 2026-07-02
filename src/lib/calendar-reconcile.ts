import { prisma } from './db'
import { logAudit } from './audit'
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEventAttendees,
  updateCalendarEventAttendees,
} from './google-calendar'

type ReconcileAction = 'ok' | 'patched' | 'created' | 'failed' | 'skipped'

export type ReconcileItem = {
  bookingId: string
  bookingCode: string | null
  eventId: string | null
  htmlLink?: string | null
  action: ReconcileAction
  assignedEmails: string[]
  calendarAttendees?: string[]
  error?: string
}

export type ReconcileResult = {
  checked: number
  ok: number
  patched: number
  created: number
  failed: number
  skipped: number
  items: ReconcileItem[]
}

const DEFAULT_LIMIT = 50

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
  status: string
  shootDate: Date | string
  shootEndDate?: Date | string | null
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  videoType?: string | null
  locationName?: string | null
  producer: string
  cameraCount?: number | null
  micCount?: number | null
  needsVan?: boolean | null
  freelancers?: unknown
  assignedEmails: string[]
  crewRequired: string[]
  agencyRef?: string | null
  notes?: string | null
  adminNotes?: string | null
  calendarEventId?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ episodeId: string; title: string }>
}

type ProcessOptions = {
  actorEmail?: string | null
  dryRun?: boolean
}

async function createVerifiedCalendarEvent(booking: {
  id: string
  bookingCode?: string | null
  shootDate: Date | string
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  videoType?: string | null
  locationName?: string | null
  producer: string
  cameraCount?: number | null
  micCount?: number | null
  needsVan?: boolean | null
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

  const calendarEvent = await getCalendarEventAttendees(eventId)
  if (!sameEmails(booking.assignedEmails, calendarEvent.attendees)) {
    await deleteCalendarEvent(eventId)
    throw new Error(
      `created calendar event is missing assigned attendees (${booking.assignedEmails.join(', ') || 'none'})`,
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
  const item: ReconcileItem = {
    bookingId: booking.id,
    bookingCode: booking.bookingCode,
    eventId: booking.calendarEventId ?? null,
    action: 'skipped',
    assignedEmails,
  }

  try {
    if (assignedEmails.length === 0) {
      item.action = 'skipped'
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
        shootDate: booking.shootDate,
        callTime: booking.callTime,
        estimatedWrap: booking.estimatedWrap,
        shootType: booking.shootType,
        videoType: booking.videoType,
        locationName: booking.locationName,
        producer: booking.producer,
        cameraCount: booking.cameraCount,
        micCount: booking.micCount,
        needsVan: booking.needsVan,
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
      const saved = await prisma.booking.updateMany({
        where: { id: booking.id, calendarEventId: null },
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
        shootDate: booking.shootDate,
        callTime: booking.callTime,
        estimatedWrap: booking.estimatedWrap,
        shootType: booking.shootType,
        videoType: booking.videoType,
        locationName: booking.locationName,
        producer: booking.producer,
        cameraCount: booking.cameraCount,
        micCount: booking.micCount,
        needsVan: booking.needsVan,
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
      const savedRe = await prisma.booking.updateMany({
        where: { id: booking.id, calendarEventId: booking.calendarEventId },
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

    if (sameEmails(assignedEmails, calendarEvent.attendees)) {
      // Even when nothing changes, refresh the OK timestamp so the UI
      // can show "last verified N min ago" and the stale-PENDING
      // reconciler clause works correctly.
      if (!options.dryRun) {
        await prisma.booking.update({
          where: { id: booking.id },
          data: {
            calendarSyncStatus: 'OK',
            calendarSyncError: null,
            calendarLastSyncedAt: new Date(),
          },
        })
      }
      item.action = 'ok'
      return item
    }

    if (!options.dryRun) {
      const ok = await updateCalendarEventAttendees(booking.calendarEventId, assignedEmails, {
        bookingId: booking.id,
        bookingCode: booking.bookingCode,
      })
      if (!ok) {
        const oldEventId = booking.calendarEventId
        const { eventId, htmlLink } = await createVerifiedCalendarEvent({
          id: booking.id,
          bookingCode: booking.bookingCode,
          shootDate: booking.shootDate,
          callTime: booking.callTime,
          estimatedWrap: booking.estimatedWrap,
          shootType: booking.shootType,
          locationName: booking.locationName,
          producer: booking.producer,
          assignedEmails,
          outlet: booking.outlet,
          program: booking.program,
          episodes: booking.episodes,
          crewRequired: booking.crewRequired,
          agencyRef: booking.agencyRef,
          notes: booking.notes,
        })
        await prisma.booking.update({
          where: { id: booking.id },
          data: {
            calendarEventId: eventId,
            calendarSyncStatus: 'OK',
            calendarSyncError: null,
            calendarLastSyncedAt: new Date(),
          },
        })
        await deleteCalendarEvent(oldEventId)

        item.action = 'created'
        item.eventId = eventId
        item.htmlLink = htmlLink
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
      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          calendarSyncStatus: 'OK',
          calendarSyncError: null,
          calendarLastSyncedAt: new Date(),
        },
      })
    }
    await logAudit({
      actorEmail: options.actorEmail ?? 'calendar-reconcile',
      action: 'calendar.reconcile_patched',
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      changes: {
        eventId: booking.calendarEventId,
        fromAttendees: calendarEvent.attendees,
        toAttendees: assignedEmails,
        dryRun: Boolean(options.dryRun),
      },
    })
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
          calendarSyncError: errMsg.slice(0, 500),
          calendarLastSyncedAt: new Date(),
        },
      }).catch(err => console.error('save FAILED status error:', err?.message))
    }
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
          assignedEmails: { isEmpty: false },
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
      episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
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

  return result
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
      episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
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
