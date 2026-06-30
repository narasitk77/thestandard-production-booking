import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, requireConsole } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { canViewBooking } from '@/lib/booking-access'
import { deleteCalendarEvent, updateCalendarEventDetails } from '@/lib/google-calendar'
import { updateBookingRow } from '@/lib/google-sheets'
import { syncBookingOT, clearBookingOT } from '@/lib/ot-sync'
import { assertStatusTransition } from '@/lib/booking-status'
import { isShootOver } from '@/lib/booking-complete'
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
        episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
        // v1.50.1 — select list: keep the fields the detail pages render, drop
        // storage internals (wasabi keys/multipart ids, sha256) from the wire.
        uploads: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            episodeId: true,
            camera: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            notes: true,
            status: true,
            uploadedBy: true,
            driveFileId: true,
            driveUrl: true,
            initiatedAt: true,
            completedAt: true,
            failureReason: true,
            createdAt: true,
            updatedAt: true,
            episode: { select: { episodeId: true } },
          },
        },
      },
    })

    if (!booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    // v1.51 — soft-deleted bookings are invisible except to ADMIN (who needs
    // the detail to inspect/restore from the Deleted tab).
    if (booking.deletedAt && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    // v1.50.1 — detail reads are scoped (src/lib/booking-access.ts): console
    // staff, or someone on the booking (requester / producer / assigned crew).
    // Previously any logged-in user could read any booking by id, incl.
    // adminNotes and the full upload history.
    if (!canViewBooking(session, booking)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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
    if (!(await requireConsole())) {
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
      videoType,
      category,
      producer,
      producerEmail,
      creative,
      agencyRef,
      adminNotes,
      assignedEmails,
      cameraCount,
      micCount,
      needsVan,
      specialEquipment,
      // v1.62.0 — Auto-Planning fields (replace the manual planning sheet)
      equipmentNote,
      rentalGearNote,
      itinerary,
      assignedEquipmentIds,
      episodeTitles, // Array<{ id: string, title: string }> — only updates titles, NOT episodeId
      clearCancelRequest, // staff "keep the job": dismiss a pending cancellation request
    } = body

    const existing = await prisma.booking.findUnique({
      where: { id: params.id },
      include: { episodes: true },
    })
    if (!existing) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    // v1.51 — a soft-deleted booking is frozen: restore it first (undelete)
    if (existing.deletedAt) {
      return NextResponse.json({ error: 'Booking is deleted — restore it first' }, { status: 409 })
    }

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
      // Guard: a booking can only be COMPLETED once its shoot day has ended
      // (Bangkok time) — same rule as the auto-completer. Stops an accidental
      // "Mark Complete" from closing a future booking before it's been shot.
      if (status === 'COMPLETED' && !isShootOver(existing)) {
        return NextResponse.json(
          { error: 'ยังถ่ายไม่เสร็จ — ปิดงาน (COMPLETED) ก่อนจบวันถ่ายไม่ได้', code: 'SHOOT_NOT_OVER' },
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
          ...(videoType !== undefined && { videoType: videoType || null }),
          ...(category && { category }),
          ...(producer && { producer }),
          ...(producerEmail !== undefined && { producerEmail: producerEmail || null }),
          ...(creative && Array.isArray(creative) && { creative }),
          ...(agencyRef !== undefined && { agencyRef: agencyRef || null }),
          ...(adminNotes !== undefined && { adminNotes: adminNotes || null }),
          ...(assignedEmails && Array.isArray(assignedEmails) && { assignedEmails }),
          ...(cameraCount !== undefined && { cameraCount: cameraCount === null || cameraCount === '' ? null : Math.max(0, parseInt(cameraCount, 10) || 0) }),
          ...(micCount !== undefined && { micCount: micCount === null || micCount === '' ? null : Math.max(0, parseInt(micCount, 10) || 0) }),
          ...(typeof needsVan === 'boolean' && { needsVan }),
          ...(Array.isArray(specialEquipment) && { specialEquipment: specialEquipment.filter((x: unknown) => typeof x === 'string' && x.trim() !== '') }),
          ...(equipmentNote !== undefined && { equipmentNote: equipmentNote || null }),
          ...(rentalGearNote !== undefined && { rentalGearNote: rentalGearNote || null }),
          ...(itinerary !== undefined && { itinerary: itinerary || null }),
          ...(Array.isArray(assignedEquipmentIds) && { assignedEquipmentIds: assignedEquipmentIds.filter((x: unknown) => typeof x === 'string' && x.trim() !== '') }),
          // Staff dismissed the cancellation request (keep the job) — clears the
          // flag so it leaves the "ขอยกเลิก" tab and the producer can re-request.
          ...(clearCancelRequest === true && { cancelRequestedAt: null, cancelReason: null, cancelRequestedBy: null }),
        },
        include: {
          outlet: true,
          program: true,
          episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
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
        updateBookingRow(existing.bookingCode || '', { status: 'CANCELLED' }).catch(() => {})
      }
      await prisma.booking.update({
        where: { id: params.id },
        data: { calendarEventId: null },
      })
      clearBookingOT(params.id).catch(e => console.error('clearBookingOT error:', e))
    } else if (booking.calendarEventId) {
      // v1.41.0 — edits to a synced booking (time, episode titles, location,
      // video type, equipment, van) must flow to the Google Calendar event.
      // Previously the DB updated but the event kept its old title/time. Patch
      // the event's core details (NOT attendees) so the calendar stays in sync.
      // Fire-and-forget: the booking is already saved; a calendar blip must not
      // fail the edit, and the 10-min reconciler is a safety net for guests.
      updateCalendarEventDetails(booking.calendarEventId, booking).catch(e =>
        console.error('updateCalendarEventDetails error:', e?.message || e),
      )
    }

    // Re-sync OT if scheduling fields changed and booking is active
    if (
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
      select: {
        id: true, status: true, bookingCode: true, createdByEmail: true,
        deletedAt: true, calendarEventId: true, sheetRowIndex: true,
      },
    })
    if (!before) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    if (before.deletedAt) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    // v1.54.1 — same transition rules as PATCH (CANCELLED is terminal;
    // COMPLETED can't be cancelled). Previously this path skipped the
    // whitelist entirely.
    try {
      assertStatusTransition(before.status as BookingStatus, 'CANCELLED')
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || 'Invalid status transition' }, { status: 400 })
    }

    // v1.50 — cancel is for the requester or console staff. Previously any
    // logged-in user could cancel any booking.
    const isOwner = (before.createdByEmail || '').toLowerCase() === session.email
    if (!isOwner && !hasConsoleAccess(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.booking.update({
      where: { id: params.id },
      data: { status: 'CANCELLED', calendarEventId: null },
    })

    // v1.54.1 — same cleanup as the PATCH cancel path: previously this route
    // flipped the status but left the Google Calendar event live (the
    // reconciler ignores CANCELLED rows, so it never got cleaned up), kept
    // the sheet row saying CONFIRMED, and let auto-OT rows keep counting.
    if (before.calendarEventId) {
      deleteCalendarEvent(before.calendarEventId).catch(() => {})
    }
    if (before.sheetRowIndex) {
      updateBookingRow(before.bookingCode || '', { status: 'CANCELLED' }).catch(() => {})
    }
    clearBookingOT(params.id).catch(e => console.error('clearBookingOT error:', e))

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
