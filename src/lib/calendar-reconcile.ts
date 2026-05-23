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
  locationName?: string | null
  producer: string
  assignedEmails: string[]
  crewRequired: string[]
  agencyRef?: string | null
  notes?: string | null
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
  locationName?: string | null
  producer: string
  assignedEmails: string[]
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ episodeId: string; title: string }>
  crewRequired: string[]
  agencyRef?: string | null
  notes?: string | null
}): Promise<{ eventId: string; htmlLink: string | null }> {
  const eventId = await createCalendarEvent(booking, {
    requireAttendees: booking.assignedEmails.length > 0,
  })
  if (!eventId) throw new Error('createCalendarEvent returned null')

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
        data: { calendarEventId: eventId },
      })
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
        data: { calendarEventId: eventId },
      })
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
          data: { calendarEventId: eventId },
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
    item.error = e?.message || String(e)
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

  const bookings = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      assignedEmails: { isEmpty: false },
    },
    include: {
      outlet: true,
      program: true,
      episodes: { orderBy: { sequence: 'asc' } },
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
      episodes: { orderBy: { sequence: 'asc' } },
    },
  })
  if (!booking) return null
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
