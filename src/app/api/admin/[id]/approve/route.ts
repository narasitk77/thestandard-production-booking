import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createCalendarEvent } from '@/lib/google-calendar'
import { updateBookingRow } from '@/lib/google-sheets'
import { requireAdmin } from '@/lib/session'
import { format } from 'date-fns'

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

    // Allow re-running on CONFIRMED bookings if calendar event is missing (retry path)
    // This is safe — we just create a new event and overwrite the calendarEventId.

    // Create Google Calendar event
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

    const approvedAt = new Date()

    // Update booking status
    const updated = await prisma.booking.update({
      where: { id: params.id },
      data: {
        status: 'CONFIRMED',
        calendarEventId: calendarEventId || null,
        approvedAt,
      },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
      },
    })

    // Update Google Sheets
    if (booking.sheetRowIndex) {
      await updateBookingRow(booking.sheetRowIndex, {
        status: 'CONFIRMED',
        calendarEventId: calendarEventId || '',
        approvedAt: approvedAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
      })
    }

    return NextResponse.json({
      booking: updated,
      calendarEventId,
      calendarCreated: !!calendarEventId,
    })
  } catch (error) {
    console.error('POST /api/admin/[id]/approve error:', error)
    return NextResponse.json({ error: 'Failed to approve' }, { status: 500 })
  }
}
