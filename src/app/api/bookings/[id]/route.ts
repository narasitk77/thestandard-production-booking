import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, requireAdmin } from '@/lib/session'
import { deleteCalendarEvent } from '@/lib/google-calendar'
import { updateBookingRow } from '@/lib/google-sheets'
import { syncBookingOT, clearBookingOT } from '@/lib/ot-sync'
import { assertStatusTransition } from '@/lib/booking-status'
import { logAudit, diffBooking } from '@/lib/audit'
import type { BookingStatus } from '@prisma/client'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' } },
        uploads: { orderBy: { createdAt: 'desc' } },
      },
    })

    if (!booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    // Serialize BigInt fileSize to string (JSON can't handle BigInt)
    const safeBooking = {
      ...booking,
      uploads: booking.uploads.map(u => ({
        ...u,
        fileSize: u.fileSize === null ? null : u.fileSize.toString(),
      })),
    }

    return NextResponse.json({ booking: safeBooking })
  } catch (error) {
    console.error('GET /api/bookings/[id] error:', error)
    return NextResponse.json({ error: 'Failed to fetch booking' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const body = await request.json()

    // Editable fields (do NOT affect Episode ID — outletCode/programCode/shootDate/sequence are immutable)
    const {
      status,
      notes,
      callTime,
      estimatedWrap,
      shootEndDate,
      locationName,
      crewRequired,
      shootType,
      category,
      producer,
      creative,
      agencyRef,
      adminNotes,
      assignedEmails,
      episodeTitles, // Array<{ id: string, title: string }> — only updates titles, NOT episodeId
    } = body

    const existing = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { episodes: true },
    })
    if (!existing) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    // Reject illegal status transitions (e.g. COMPLETED → REQUESTED) before
    // touching the DB. Returns 400 with the rule it violated.
    if (status && status !== existing.status) {
      try {
        assertStatusTransition(existing.status, status as BookingStatus)
      } catch (e: any) {
        return NextResponse.json(
          { error: e?.message || 'Invalid status transition' },
          { status: 400 },
        )
      }
    }

    // Update booking fields in a transaction along with episode titles
    const booking = await prisma.$transaction(async (tx) => {
      // Update episode titles if provided (NEVER episodeId or sequence)
      if (Array.isArray(episodeTitles)) {
        for (const ep of episodeTitles) {
          if (!ep?.id || typeof ep.title !== 'string') continue
          // Verify episode belongs to this booking
          const owns = existing.episodes.find(e => e.id === ep.id)
          if (!owns) continue
          await tx.episode.update({
            where: { id: ep.id },
            data: { title: ep.title.trim() },
          })
        }
      }

      return tx.booking.update({
        where: { id: params.id },
        data: {
          ...(status && { status }),
          ...(notes !== undefined && { notes: notes || null }),
          ...(callTime && { callTime }),
          ...(estimatedWrap !== undefined && { estimatedWrap: estimatedWrap || null }),
          ...(shootEndDate !== undefined && { shootEndDate: shootEndDate ? new Date(shootEndDate) : null }),
          ...(locationName !== undefined && { locationName: locationName || null }),
          ...(crewRequired && Array.isArray(crewRequired) && { crewRequired }),
          ...(shootType && { shootType }),
          ...(category && { category }),
          ...(producer && { producer }),
          ...(creative && Array.isArray(creative) && { creative }),
          ...(agencyRef !== undefined && { agencyRef: agencyRef || null }),
          ...(adminNotes !== undefined && { adminNotes: adminNotes || null }),
          ...(assignedEmails && Array.isArray(assignedEmails) && { assignedEmails }),
        },
        include: {
          outlet: true,
          program: true,
          episodes: { orderBy: { sequence: 'asc' } },
        },
      })
    })

    // Audit — fire-and-forget. Status changes get a dedicated row; other
    // edits get a `booking.update` row with a field-level diff. We log both
    // when status AND other fields change in one request.
    if (status && status !== existing.status) {
      logAudit({
        actorEmail: session.email,
        action: 'booking.status_change',
        entityType: 'Booking',
        entityId: booking.id,
        bookingCode: booking.bookingCode,
        fromStatus: existing.status,
        toStatus: booking.status,
      })
    }
    const otherDiff = diffBooking(existing, booking)
    if (otherDiff && (!status || Object.keys(otherDiff).some(k => k !== 'status'))) {
      // Drop the status key from the diff — already captured above
      const { status: _omit, ...rest } = otherDiff
      if (Object.keys(rest).length > 0) {
        logAudit({
          actorEmail: session.email,
          action: 'booking.update',
          entityType: 'Booking',
          entityId: booking.id,
          bookingCode: booking.bookingCode,
          changes: rest,
        })
      }
    }

    // On cancellation, remove calendar event, sheet row, and auto-OT records
    if (status === 'CANCELLED') {
      if (existing.calendarEventId) {
        deleteCalendarEvent(existing.calendarEventId).catch(() => {})
      }
      if (existing.sheetRowIndex) {
        updateBookingRow(existing.sheetRowIndex, { status: 'CANCELLED' }).catch(() => {})
      }
      await prisma.booking.update({
        where: { id: params.id },
        data: { calendarEventId: null },
      })
      clearBookingOT(params.id).catch(e => console.error('clearBookingOT error:', e))
    } else if (
      // Re-sync OT if scheduling fields changed and booking is active
      booking.status !== 'CANCELLED' && (
        callTime !== undefined ||
        estimatedWrap !== undefined ||
        Array.isArray(assignedEmails)
      )
    ) {
      syncBookingOT(params.id).catch(e => console.error('syncBookingOT error:', e))
    }

    return NextResponse.json({ booking })
  } catch (error) {
    console.error('PATCH /api/bookings/[id] error:', error)
    return NextResponse.json({ error: 'Failed to update booking' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Soft-delete: flip status to CANCELLED. We snapshot the previous status
    // for the audit log so retrospective reads can see what we cancelled.
    const before = await prisma.booking.findUnique({
      where: { id: params.id },
      select: { id: true, status: true, bookingCode: true },
    })
    if (!before) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    await prisma.booking.update({
      where: { id: params.id },
      data: { status: 'CANCELLED' },
    })

    logAudit({
      actorEmail: session.email,
      action: 'booking.delete',
      entityType: 'Booking',
      entityId: before.id,
      bookingCode: before.bookingCode,
      fromStatus: before.status,
      toStatus: 'CANCELLED',
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('DELETE /api/bookings/[id] error:', error)
    return NextResponse.json({ error: 'Failed to cancel booking' }, { status: 500 })
  }
}
