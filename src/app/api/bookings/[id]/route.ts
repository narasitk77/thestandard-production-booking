import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { resolveLocationId } from '@/lib/location-resolve'
import { releaseRoomForBooking } from '@/lib/room-booking-sync'
import { getSession, requireConsole } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import { canViewBooking } from '@/lib/booking-access'
import { resolveBookingCrew } from '@/lib/crew-names'
import { deleteCalendarEvent, updateCalendarEventDetails } from '@/lib/google-calendar'
import { updateBookingRow, joinEpisodeTitles } from '@/lib/google-sheets'
import { quRuleEnabled, isAcceptableQuRef, normalizeQuRef, quRefRejectMessage } from '@/lib/agency-ref'
import { syncBookingOT, clearBookingOT } from '@/lib/ot-sync'
import { assertStatusTransition } from '@/lib/booking-status'
import { isShootOver } from '@/lib/booking-complete'
import { isValidHHMM } from '@/lib/shoot-window'
import { logAudit, diffBooking } from '@/lib/audit'
import { normalizeBuddhistYear } from '@/lib/thai-date'
import { refreshShootMarker } from '@/lib/shoot-marker'
import { hasDriveCredentials } from '@/lib/google-drive'
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
      // v1.111 — resolved crew names (team label / nickname / first name) so the
      // detail page shows WHO is assigned, not just raw emails.
      assignedCrew: await resolveBookingCrew(booking.assignedEmails || [], (booking as any).mainVideographerEmail),
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
      director,
      directorEmail,
      creative,
      agencyRef,
      adminNotes,
      assignedEmails,
      cameraCount,
      micCount,
      // v1.128 — admin can flip Block Shot + adjust videographer/switcher
      // headcounts after creation (block-shot jobs firm up their gear late).
      isBlockShot,
      videographerCount,
      switcherCount,
      vanCount,
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
      include: { episodes: true, outlet: { select: { code: true } } },
    })
    if (!existing) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    // v1.161 — กฏ QU: แก้ไข Agency ref ของงาน Agency (Advertorial) ต้องเป็น
    // รูปแบบ QU เท่านั้น (สอดคล้อง create); ค่าว่าง = ลบได้ตามเดิม
    // v1.183 — ตัวยึด "1234" (ยังไม่มีเลข QU) ผ่านได้เหมือนฝั่ง create ไม่งั้น
    // แอดมินจะแก้ใบที่ค้างตัวยึดอยู่ไม่ได้เลย
    let agencyRefValidated: string | null = agencyRef || null
    // v1.188 — ทุกบ้าน ไม่ใช่แค่ AGN
    if (agencyRef !== undefined && agencyRef && quRuleEnabled()
        && existing.category === 'ADVERTORIAL') {
      if (!isAcceptableQuRef(agencyRef)) {
        return NextResponse.json({ error: quRefRejectMessage(agencyRef) }, { status: 400 })
      }
      agencyRefValidated = normalizeQuRef(agencyRef)
    }

    // v1.51 — a soft-deleted booking is frozen: restore it first (undelete)
    if (existing.deletedAt) {
      return NextResponse.json({ error: 'Booking is deleted — restore it first' }, { status: 409 })
    }

    // v1.146 review fix — same HH:MM guard as createBookingFromPayload; this
    // route is reachable by API clients, not just the time-picker UI.
    if (callTime && !isValidHHMM(callTime)) {
      return NextResponse.json({ error: `Invalid callTime "${callTime}" — must be 24h HH:MM (e.g. 09:00)` }, { status: 400 })
    }
    if (estimatedWrap != null && estimatedWrap !== '' && !isValidHHMM(estimatedWrap)) {
      return NextResponse.json({ error: `Invalid estimatedWrap "${estimatedWrap}" — must be 24h HH:MM (e.g. 18:00)` }, { status: 400 })
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
    const statusChanging = Boolean(status && status !== existing.status)
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

      // v1.146 review fix — CAS on the status write: the transition was
      // validated against `existing.status` read BEFORE this transaction, but
      // the fire-and-forget autoCompleteBookings() (or another admin tab) can
      // flip the row in between. Writing unconditionally would then apply a
      // transition the ALLOWED map forbids (e.g. reverting COMPLETED back to
      // CANCELLED). Re-check the precondition at write time — 0 rows means the
      // status moved under us → 409, ask the caller to refresh.
      if (statusChanging) {
        const guarded = await tx.booking.updateMany({
          where: { id: params.id, status: existing.status, deletedAt: null },
          data: { status },
        })
        if (guarded.count === 0) throw new Error('STATUS_CONFLICT')
      }

      return tx.booking.update({
        where: { id: params.id },
        data: {
          ...(status && !statusChanging && { status }),
          ...(notes !== undefined && { notes: notes || null }),
          ...(callTime && { callTime }),
          ...(estimatedWrap !== undefined && { estimatedWrap: estimatedWrap || null }),
          // normalizeBuddhistYear: an admin could paste a พ.ศ. end date (2569) —
          // shootDate itself is immutable + guarded at creation, but shootEndDate
          // is editable here, so guard it too (feeds the marker date range + calendar).
          ...(shootEndDate !== undefined && { shootEndDate: shootEndDate ? (normalizeBuddhistYear(new Date(shootEndDate)) ?? null) : null }),
          ...(locationName !== undefined && {
            locationName: locationName || null,
            // v1.195 — สถานที่เปลี่ยน id ต้องเปลี่ยนตาม ไม่งั้นการจองห้องในระบบกลาง
            // จะยึดห้องเดิมค้างไว้ทั้งที่งานย้ายไปแล้ว
            locationId: resolveLocationId(locationName),
          }),
          ...(crewRequired && Array.isArray(crewRequired) && { crewRequired }),
          ...(shootType && { shootType }),
          ...(videoType !== undefined && { videoType: videoType || null }),
          ...(category && { category }),
          ...(producer && { producer }),
          ...(producerEmail !== undefined && { producerEmail: producerEmail || null }),
          ...(director !== undefined && { director: director || null }),
          ...(directorEmail !== undefined && { directorEmail: directorEmail || null }),
          ...(creative && Array.isArray(creative) && { creative }),
          ...(agencyRef !== undefined && { agencyRef: agencyRefValidated }),
          ...(adminNotes !== undefined && { adminNotes: adminNotes || null }),
          ...(assignedEmails && Array.isArray(assignedEmails) && { assignedEmails }),
          ...(cameraCount !== undefined && { cameraCount: cameraCount === null || cameraCount === '' ? null : Math.max(0, parseInt(cameraCount, 10) || 0) }),
          ...(micCount !== undefined && { micCount: micCount === null || micCount === '' ? null : Math.max(0, parseInt(micCount, 10) || 0) }),
          ...(typeof isBlockShot === 'boolean' && { isBlockShot }),
          ...(videographerCount !== undefined && { videographerCount: Math.max(1, Math.min(10, parseInt(videographerCount, 10) || 1)) }),
          ...(switcherCount !== undefined && { switcherCount: Math.max(1, Math.min(10, parseInt(switcherCount, 10) || 1)) }),
          ...(vanCount !== undefined && { vanCount: Math.max(0, Math.min(20, parseInt(vanCount, 10) || 0)) }),
          ...(Array.isArray(specialEquipment) && { specialEquipment: specialEquipment.filter((x: unknown) => typeof x === 'string' && x.trim() !== '') }),
          // v1.197 — ช่องระดับใบจองเป็น "สรุปที่คำนวณมา" จาก Episode แล้ว การเขียน
          // ตรงนี้จึงต้อง write-through ลงทุก Production ID ของใบนั้น ไม่งั้นสรุป
          // จะหลุดจากตัวจริงทันทีที่มีคนแก้จากหน้า Booking/Drawer
          // (แก้แยกราย ID ได้ที่หน้า Week Plan — ที่นี่ = ใช้กับทุก ID ของงานนี้)
          ...(equipmentNote !== undefined && {
            equipmentNote: equipmentNote || null,
            episodes: { updateMany: { where: {}, data: { equipmentNote: equipmentNote || null } } },
          }),
          ...(rentalGearNote !== undefined && {
            rentalGearNote: rentalGearNote || null,
            episodes: { updateMany: { where: {}, data: { rentalGearNote: rentalGearNote || null } } },
          }),
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
        // v1.148.0 — also blank col W: the event above was just deleted, and a
        // stale event id on a CANCELLED row can mislead PMDC's Airtable sync
        // (it merges Service Jobs by Calendar Event ID).
        // Cancel Reason (col AG) rides along when the booking has one (set by
        // the request-cancel flow; a direct staff cancel has none).
        updateBookingRow(existing.bookingCode || '', {
          status: 'CANCELLED',
          calendarEventId: '',
          ...(booking.cancelReason ? { cancelReason: booking.cancelReason } : {}),
        }).catch(() => {})
      }
      await prisma.booking.update({
        where: { id: params.id },
        data: { calendarEventId: null },
      })
      clearBookingOT(params.id).catch(e => console.error('clearBookingOT error:', e))
      // v1.201 — ยกเลิกคิว = ต้องคืนห้องในระบบกลางด้วย (operator 2026-08-25:
      // "เมื่อคิวยกเลิกจาก probook ห้องต้องยกเลิกด้วย") ไม่งั้นห้องถูกยึดค้างไว้
      // โดยไม่มีใครใช้ และไม่มีใครรู้ว่าต้องไปปลดที่ไหน
      // fire-and-forget เส้นเดียวกับปฏิทิน/OT — ยกเลิกคิวต้องไม่ล้มเพราะระบบเขาสะดุด
      releaseRoomForBooking(params.id, 'booking-cancelled')
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

    // Episode-title edits flow to the sheet's Episode Titles cell (col AH) —
    // col Q keeps only the IDs, so a renamed EP would otherwise go stale in
    // the Bookings tab forever. Same fire-and-forget shape as the cancel
    // patch above; `booking.episodes` is the post-update, sequence-ordered set.
    if (Array.isArray(episodeTitles) && existing.sheetRowIndex) {
      updateBookingRow(existing.bookingCode || '', {
        episodeTitles: joinEpisodeTitles(booking.episodes),
      }).catch(e => console.error('updateBookingRow (episodeTitles) error:', e?.message || e))
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

    // v1.149 — edits to a live booking must also flow to the Drive `_SHOOT.txt`
    // marker (same principle as the calendar patch above): episode titles, times,
    // location, crew all render into the marker the footage crawler reads.
    // Fire-and-forget find-only refresh — never creates folders, never blocks
    // the edit; the nightly marker reconciler is the backstop.
    //
    // v1.148.3 — gate on whether a field that actually RENDERS into the marker
    // was part of this edit (mirror the OT-sync gate above). A pure status flip
    // or an equipment/van/headcount-only edit no longer rewrites _SHOOT.txt —
    // that write is a non-atomic list-then-create, so churning it on every PATCH
    // was needless load and a drift risk. Fields below = the marker's rendered
    // set (see booking-info.ts renderBookingInfo); status isn't rendered.
    const markerFieldEdited =
      notes !== undefined ||
      callTime !== undefined ||
      estimatedWrap !== undefined ||
      shootEndDate !== undefined ||
      shootType !== undefined ||
      locationName !== undefined ||
      videoType !== undefined ||
      category !== undefined ||
      producer !== undefined ||
      producerEmail !== undefined ||
      director !== undefined ||
      directorEmail !== undefined ||
      agencyRef !== undefined ||
      Array.isArray(crewRequired) ||
      Array.isArray(assignedEmails) ||
      Array.isArray(episodeTitles)

    if (
      markerFieldEdited &&
      (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') &&
      hasDriveCredentials()
    ) {
      refreshShootMarker(booking).catch(e =>
        console.error('[booking-patch] marker refresh failed (non-fatal):', e?.message || e),
      )
    }

    return NextResponse.json({ booking })
  } catch (error: any) {
    if (error?.message === 'STATUS_CONFLICT') {
      return NextResponse.json(
        { error: 'สถานะงานถูกเปลี่ยนระหว่างการแก้ไข (เช่น ระบบปิดงานอัตโนมัติ) — รีเฟรชหน้าแล้วลองใหม่' },
        { status: 409 },
      )
    }
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
        cancelReason: true,
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

    // v1.146 review fix — CAS: the transition was validated against `before.status`,
    // but autoCompleteBookings() (or a concurrent edit) can flip the row between
    // that read and this write. Re-check at write time; 0 rows = state moved → 409.
    const cancelled = await prisma.booking.updateMany({
      where: { id: params.id, status: before.status, deletedAt: null },
      data: { status: 'CANCELLED', calendarEventId: null },
    })
    if (cancelled.count === 0) {
      return NextResponse.json(
        { error: 'สถานะงานถูกเปลี่ยนระหว่างการยกเลิก — รีเฟรชหน้าแล้วลองใหม่' },
        { status: 409 },
      )
    }

    // v1.54.1 — same cleanup as the PATCH cancel path: previously this route
    // flipped the status but left the Google Calendar event live (the
    // reconciler ignores CANCELLED rows, so it never got cleaned up), kept
    // the sheet row saying CONFIRMED, and let auto-OT rows keep counting.
    if (before.calendarEventId) {
      deleteCalendarEvent(before.calendarEventId).catch(() => {})
    }
    if (before.sheetRowIndex) {
      // v1.148.0 — blank col W too (see PATCH cancel path above). Cancel
      // Reason (col AG) rides along when set by the request-cancel flow.
      updateBookingRow(before.bookingCode || '', {
        status: 'CANCELLED',
        calendarEventId: '',
        ...(before.cancelReason ? { cancelReason: before.cancelReason } : {}),
      }).catch(() => {})
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
