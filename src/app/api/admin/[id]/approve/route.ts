import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createCalendarEvent } from '@/lib/google-calendar'
import { updateBookingRow } from '@/lib/google-sheets'
import { requireAdmin } from '@/lib/session'
import { syncBookingOT } from '@/lib/ot-sync'
import { logAudit } from '@/lib/audit'

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireAdmin()
    if (!session) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
      },
    })

    if (!booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    const approvedAt = new Date()

    // 1) Update DB immediately so the user gets instant feedback.
    //    v1.32.2 — also set calendarSyncStatus=PENDING so the UI shows
    //    a "sync pending" chip until the background task finishes.
    const updated = await prisma.booking.update({
      where: { id: params.id },
      data: {
        status: 'CONFIRMED',
        approvedAt,
        calendarSyncStatus: 'PENDING',
        calendarSyncError: null,
        calendarLastSyncedAt: new Date(),
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
      },
    })

    // 2) Fire calendar + sheet + OT in background; user doesn't wait.
    //    v1.32.2 — record OK / FAILED on completion so the UI never
    //    shows CONFIRMED-but-no-event silently. Reconciler will retry
    //    FAILED rows every 10 min.
    ;(async () => {
      try {
        const calendarEventId = await createCalendarEvent({
          id: booking.id,
          bookingCode: booking.bookingCode,
          shootDate: booking.shootDate,
          callTime: booking.callTime,
          estimatedWrap: booking.estimatedWrap,
          shootType: booking.shootType,
          locationName: booking.locationName,
          producer: booking.producer,
          assignedEmails: booking.assignedEmails,
          outlet: booking.outlet,
          program: booking.program,
          episodes: booking.episodes,
          crewRequired: booking.crewRequired,
          agencyRef: booking.agencyRef,
          notes: booking.notes,
        }, {
          requireAttendees: booking.assignedEmails.length > 0,
        })
        if (calendarEventId) {
          await prisma.booking.update({
            where: { id: params.id },
            data: {
              calendarEventId,
              calendarSyncStatus: 'OK',
              calendarSyncError: null,
              calendarLastSyncedAt: new Date(),
            },
          }).catch(e => console.error('save calendarEventId error:', e?.message))
        } else {
          // createCalendarEvent returned null without throwing — unusual
          // (post-v1.29.3 it should always throw). Treat as failure so
          // the UI surfaces it instead of leaving PENDING forever.
          await prisma.booking.update({
            where: { id: params.id },
            data: {
              calendarSyncStatus: 'FAILED',
              calendarSyncError: 'createCalendarEvent returned null without throwing — investigate google-calendar.ts',
              calendarLastSyncedAt: new Date(),
            },
          }).catch(e => console.error('save calendarSyncStatus error:', e?.message))
        }

        if (booking.sheetRowIndex) {
          await updateBookingRow(booking.sheetRowIndex, {
            status: 'CONFIRMED',
            calendarEventId: calendarEventId || '',
            approvedAt: approvedAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
          }).catch(e => console.error('updateBookingRow error:', e?.message))
        }
      } catch (e: any) {
        console.error('approve background tasks error:', e)
        // v1.32.2 — record the failure on the booking so /admin shows
        // a red chip + reconciler picks it up on its next tick.
        await prisma.booking.update({
          where: { id: params.id },
          data: {
            calendarSyncStatus: 'FAILED',
            calendarSyncError: (e?.message || String(e)).slice(0, 500),
            calendarLastSyncedAt: new Date(),
          },
        }).catch(err => console.error('save FAILED status error:', err?.message))
        logAudit({
          actorEmail: session.email,
          action: 'calendar.approve_failed',
          entityType: 'Booking',
          entityId: booking.id,
          bookingCode: booking.bookingCode,
          changes: {
            error: e?.message || String(e),
            assignedEmails: booking.assignedEmails,
          },
        })
      }
    })()

    syncBookingOT(updated.id).catch(e => console.error('syncBookingOT error:', e))

    return NextResponse.json({
      booking: updated,
      queued: true,
      message: 'Confirmed — calendar event being created in background',
    })
  } catch (error) {
    console.error('POST /api/admin/[id]/approve error:', error)
    return NextResponse.json({ error: 'Failed to approve' }, { status: 500 })
  }
}
