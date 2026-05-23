import { prisma } from './db'
import { logAudit } from './audit'
import {
  createCalendarEvent,
  getCalendarEventAttendees,
  updateCalendarEventAttendees,
} from './google-calendar'

type ReconcileAction = 'ok' | 'patched' | 'created' | 'failed' | 'skipped'

type ReconcileItem = {
  bookingId: string
  bookingCode: string | null
  eventId: string | null
  action: ReconcileAction
  assignedEmails: string[]
  calendarAttendees?: string[]
  error?: string
}

type ReconcileResult = {
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
    const assignedEmails = cleanEmails(booking.assignedEmails)
    const item: ReconcileItem = {
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      eventId: booking.calendarEventId,
      action: 'skipped',
      assignedEmails,
    }

    try {
      if (assignedEmails.length === 0) {
        item.action = 'skipped'
        result.items.push(item)
        count(result, 'skipped')
        continue
      }

      if (!booking.calendarEventId) {
        if (options.dryRun) {
          item.action = 'created'
          result.items.push(item)
          count(result, 'created')
          continue
        }
        const eventId = await createCalendarEvent({
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
        if (!eventId) throw new Error('createCalendarEvent returned null')
        await prisma.booking.update({
          where: { id: booking.id },
          data: { calendarEventId: eventId },
        })
        item.action = 'created'
        item.eventId = eventId
        result.items.push(item)
        count(result, 'created')
        await logAudit({
          actorEmail: options.actorEmail ?? 'calendar-reconcile',
          action: 'calendar.reconcile_created',
          entityType: 'Booking',
          entityId: booking.id,
          bookingCode: booking.bookingCode,
          changes: { eventId, assignedEmails },
        })
        continue
      }

      const calendarEvent = await getCalendarEventAttendees(booking.calendarEventId)
      item.calendarAttendees = calendarEvent.attendees

      if (!calendarEvent.exists) {
        if (options.dryRun) {
          item.action = 'created'
          result.items.push(item)
          count(result, 'created')
          continue
        }
        const eventId = await createCalendarEvent({
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
        if (!eventId) throw new Error('createCalendarEvent returned null after missing event')
        await prisma.booking.update({
          where: { id: booking.id },
          data: { calendarEventId: eventId },
        })
        item.action = 'created'
        item.eventId = eventId
        result.items.push(item)
        count(result, 'created')
        await logAudit({
          actorEmail: options.actorEmail ?? 'calendar-reconcile',
          action: 'calendar.reconcile_recreated',
          entityType: 'Booking',
          entityId: booking.id,
          bookingCode: booking.bookingCode,
          changes: { oldEventId: booking.calendarEventId, eventId, assignedEmails },
        })
        continue
      }

      if (sameEmails(assignedEmails, calendarEvent.attendees)) {
        item.action = 'ok'
        result.items.push(item)
        count(result, 'ok')
        continue
      }

      if (!options.dryRun) {
        const ok = await updateCalendarEventAttendees(booking.calendarEventId, assignedEmails, {
          bookingId: booking.id,
          bookingCode: booking.bookingCode,
        })
        if (!ok) throw new Error('updateCalendarEventAttendees returned false')
      }

      item.action = 'patched'
      result.items.push(item)
      count(result, 'patched')
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
    } catch (e: any) {
      item.action = 'failed'
      item.error = e?.message || String(e)
      result.items.push(item)
      count(result, 'failed')
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
  }

  return result
}
