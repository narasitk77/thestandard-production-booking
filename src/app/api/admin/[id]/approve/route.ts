import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createCalendarEvent, deleteCalendarEvent } from '@/lib/google-calendar'
import { updateBookingRow } from '@/lib/google-sheets'
import { requireConsole } from '@/lib/session'
import { syncBookingOT } from '@/lib/ot-sync'
import { logAudit } from '@/lib/audit'
// v1.70 (issue #5) — pre-create the Drive footage folders when CONFIRMED.
import { ensureShootCameraFolders, upsertTextFile, hasDriveCredentials } from '@/lib/google-drive'
import { outletDriveFolderName, programFolderName, buildBookingFolderName, camerasToPreCreate } from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import { renderBookingInfo } from '@/lib/booking-info'

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireConsole()
    if (!session) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
      },
    })

    if (!booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    // v1.51 — soft-deleted bookings can't be approved; restore first
    if (booking.deletedAt) {
      return NextResponse.json({ error: 'Booking is deleted — restore it first' }, { status: 409 })
    }
    // v1.54.1 — CANCELLED is terminal (booking-status.ts whitelist); the
    // sanctioned revival is /restore → REQUESTED → re-approve. Without this
    // guard one click resurrected a cancelled shoot straight onto calendars.
    if (booking.status === 'CANCELLED') {
      return NextResponse.json({ error: 'Booking is cancelled — restore it first' }, { status: 409 })
    }

    const approvedAt = new Date()

    // 1) Update DB immediately so the user gets instant feedback.
    //    v1.32.2 — also set calendarSyncStatus=PENDING so the UI shows
    //    a "sync pending" chip until the background task finishes.
    //    v1.54.1 — conditional write: only statuses that may become CONFIRMED
    //    (REQUESTED/ASSIGNED, plus COMPLETED = the sanctioned re-open path).
    //    count 0 means another admin cancelled/approved/deleted in the gap —
    //    409 instead of silently double-approving (and double-creating events).
    const writes = await prisma.booking.updateMany({
      where: {
        id: params.id,
        deletedAt: null,
        status: { in: ['REQUESTED', 'ASSIGNED', 'COMPLETED'] },
      },
      data: {
        status: 'CONFIRMED',
        approvedAt,
        calendarSyncStatus: 'PENDING',
        calendarSyncError: null,
        calendarLastSyncedAt: new Date(),
      },
    })
    if (writes.count === 0) {
      return NextResponse.json(
        { error: 'Booking changed state — reload the page (already confirmed, cancelled, or deleted)' },
        { status: 409 },
      )
    }
    const updated = await prisma.booking.findUnique({
      where: { id: params.id },
      include: {
        outlet: true,
        program: true,
        episodes: { orderBy: { sequence: 'asc' }, include: { program: { select: { code: true, name: true } } } },
      },
    })
    if (!updated) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }

    // 1b) v1.70 (issue #5) — best-effort Drive pre-create: make the shoot folder
    //     + CAM-A..CAM-{cameraCount} (+ AUDIO if mics) + _SHOOT.txt so the crew
    //     opens the new "VIDEO 2026 [JUL–DEC]" tree and sees the camera slots
    //     waiting (empty slot = that camera hasn't delivered). Own try/catch IIFE
    //     — never blocks approval, runs only when Drive is configured.
    ;(async () => {
      const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
      if (!root || !updated.bookingCode || !hasDriveCredentials()) return
      try {
        const jobName = updated.projectName?.trim() || updated.episodes[0]?.title?.trim() || null
        const { bookingFolderId } = await ensureShootCameraFolders({
          rootFolderId: root,
          outletCanonicalName: outletDriveFolderName(updated.outlet.code),
          programFolderName: programFolderName({
            outletCode: updated.outlet.code,
            showName: bookingShowName({ projectName: updated.projectName, program: updated.program, episodes: updated.episodes }),
            category: updated.category,
          }),
          bookingFolderName: buildBookingFolderName(updated.bookingCode, jobName),
          cameras: camerasToPreCreate(updated.cameraCount, updated.micCount),
        })
        await upsertTextFile({
          parentFolderId: bookingFolderId,
          name: '_SHOOT.txt',
          content: renderBookingInfo({
            bookingCode: updated.bookingCode,
            projectName: updated.projectName,
            projectId: updated.projectId,
            outletName: updated.outlet.name,
            outletCode: updated.outlet.code,
            category: updated.category,
            videoType: updated.videoType,
            shootType: updated.shootType,
            shootDate: updated.shootDate,
            shootEndDate: updated.shootEndDate,
            callTime: updated.callTime,
            estimatedWrap: updated.estimatedWrap,
            locationName: updated.locationName,
            producer: updated.producer,
            producerEmail: updated.producerEmail,
            director: updated.director,
            directorEmail: updated.directorEmail,
            mainVideographerEmail: updated.mainVideographerEmail,
            assignedEmails: updated.assignedEmails,
            crewRequired: updated.crewRequired,
            agencyRef: updated.agencyRef,
            notes: updated.notes,
            episodes: updated.episodes,
            generatedAt: new Date(),
          }),
        })
      } catch (e: any) {
        console.error('[approve] Drive pre-create failed (non-fatal):', e?.message || e)
      }
    })()

    // 2) Fire calendar + sheet + OT in background; user doesn't wait.
    //    v1.32.2 — record OK / FAILED on completion so the UI never
    //    shows CONFIRMED-but-no-event silently. Reconciler will retry
    //    FAILED rows every 10 min.
    ;(async () => {
      try {
        // v1.54.1 — a re-approved COMPLETED booking still has its live event;
        // creating another would duplicate it on the shared calendar. Keep the
        // existing event — the reconciler verifies/patches it on its next tick.
        if (booking.calendarEventId) {
          await prisma.booking.update({
            where: { id: params.id },
            data: { calendarSyncStatus: 'OK', calendarLastSyncedAt: new Date() },
          }).catch(e => console.error('save calendarSyncStatus error:', e?.message))
          if (booking.sheetRowIndex) {
            await updateBookingRow(booking.bookingCode || '', {
              status: 'CONFIRMED',
              calendarEventId: booking.calendarEventId,
              approvedAt: approvedAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
            }).catch(e => console.error('updateBookingRow error:', e?.message))
          }
          return
        }

        const calendarEventId = await createCalendarEvent({
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
          specialEquipment: booking.specialEquipment,
          projectName: booking.projectName,
          freelancers: booking.freelancers,
          assignedEmails: booking.assignedEmails,
          outlet: booking.outlet,
          program: booking.program,
          episodes: booking.episodes,
          crewRequired: booking.crewRequired,
          agencyRef: booking.agencyRef,
          notes: booking.notes,
          adminNotes: booking.adminNotes,
        }, {
          requireAttendees: booking.assignedEmails.length > 0,
        })
        if (calendarEventId) {
          // v1.54.1 — guarded persist: if the booking was cancelled or
          // deleted while the event was being created, drop the fresh event
          // instead of attaching it to a row nothing will ever reconcile.
          const saved = await prisma.booking.updateMany({
            where: { id: params.id, status: 'CONFIRMED', deletedAt: null },
            data: {
              calendarEventId,
              calendarSyncStatus: 'OK',
              calendarSyncError: null,
              calendarLastSyncedAt: new Date(),
            },
          }).catch(e => {
            console.error('save calendarEventId error:', e?.message)
            return null
          })
          if (saved && saved.count === 0) {
            console.warn(`[approve] booking ${params.id} changed state mid-create — deleting orphan event ${calendarEventId}`)
            deleteCalendarEvent(calendarEventId).catch(e =>
              console.warn(`[approve] orphan event delete failed: ${e}`))
          }
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
          await updateBookingRow(booking.bookingCode || '', {
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
