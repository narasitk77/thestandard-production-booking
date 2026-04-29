import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createCalendarEvent } from '@/lib/google-calendar'
import { updateBookingRow } from '@/lib/google-sheets'
import { requireAdmin } from '@/lib/session'
import { syncBookingOT } from '@/lib/ot-sync'

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!(await requireAdmin())) {
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

    // 1) Update DB immediately so the user gets instant feedback
    const updated = await prisma.booking.update({
      where: { id: params.id },
      data: {
        status: 'CONFIRMED',
        approvedAt,
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
      },
    })

    // 2) Fire calendar + sheet + OT in background; user doesn't wait
    ;(async () => {
      try {
        const calendarEventId = await createCalendarEvent({
          id: booking.id,
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
        })
        if (calendarEventId) {
          await prisma.booking.update({
            where: { id: params.id },
            data: { calendarEventId },
          }).catch(e => console.error('save calendarEventId error:', e?.message))
        }

        if (booking.sheetRowIndex) {
          await updateBookingRow(booking.sheetRowIndex, {
            status: 'CONFIRMED',
            calendarEventId: calendarEventId || '',
            approvedAt: approvedAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
          }).catch(e => console.error('updateBookingRow error:', e?.message))
        }
      } catch (e) {
        console.error('approve background tasks error:', e)
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
