import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createCalendarEvent, deleteCalendarEvent } from '@/lib/google-calendar'
import { updateBookingRow } from '@/lib/google-sheets'
import { requireConsole } from '@/lib/session'
import { syncBookingOT } from '@/lib/ot-sync'
import { logAudit } from '@/lib/audit'
import { sendBookingConfirmedEmail } from '@/lib/email'
import { getValidGoogleAccessToken } from '@/lib/google-token'
import { getToken } from 'next-auth/jwt'
// v1.70 (issue #5) — pre-create the Drive footage folders when CONFIRMED.
import { ensureShootCameraFolders, ensurePhotoAlbumFolder, ensureSoundStagingFolder, upsertTextFile, hasDriveCredentials } from '@/lib/google-drive'
import { outletDriveFolderName, shootFolderLayers, buildEpisodeFolderName, buildBookingFolderName, landingBookingFolderName, camerasToPreCreate, isPhotoAlbumBooking, bookingNeedsSound, soundStagingCategoryName } from '@/lib/outlet-folders'
import { bookingShowName } from '@/lib/display'
import { renderBookingInfo, bookingInfoInput } from '@/lib/booking-info'
// v1.114 — id-first Drive linkage: remember created folder IDs on the booking.
import { rememberDriveLinks } from '@/lib/drive-links'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireConsole()
    if (!session) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }
    // v1.131 — for the confirmed-email, sent "as" the approving admin (same
    // Gmail-OAuth-else-SMTP pattern as the assign route's assignment email).
    const authToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })
    const senderAccessToken = await getValidGoogleAccessToken(authToken)
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
      if (!updated.bookingCode || !hasDriveCredentials()) return
      try {
        const jobName = updated.projectName?.trim() || updated.episodes[0]?.title?.trim() || null
        // v1.102.8 — Photo album jobs (Episode Type A) → ONE flat folder in the
        // Photographer Shared Drive (not the VIDEO 2026 tree). Photographers drop
        // the photos inside; no camera/EP layers.
        if (isPhotoAlbumBooking(updated.episodes)) {
          const { bookingFolderId } = await ensurePhotoAlbumFolder({ bookingCode: updated.bookingCode, bookingFolderName: buildBookingFolderName(updated.bookingCode, jobName, bookingShowName({ projectName: updated.projectName, program: updated.program, episodes: updated.episodes })) })
          await rememberDriveLinks(updated.id, { photo: bookingFolderId })
          await upsertTextFile({ parentFolderId: bookingFolderId, name: '_SHOOT.txt', content: renderBookingInfo(bookingInfoInput(updated)) })
          return
        }
        const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
        if (!root) return
        // v1.94 — AGN groups footage by Project (no per-booking folder; EP folders
        // keyed by project EP ID); every other outlet keeps <show>/<Production ID>.
        const isAgency = updated.outlet.code === 'AGN'
        const layers = shootFolderLayers({
          outletCode: updated.outlet.code,
          showName: bookingShowName({ projectName: updated.projectName, program: updated.program, episodes: updated.episodes }),
          category: updated.category,
          projectId: updated.projectId,
          projectName: updated.projectName,
          bookingCode: updated.bookingCode,
          jobName,
        })
        const { bookingFolderId } = await ensureShootCameraFolders({
          rootFolderId: root,
          outletCanonicalName: outletDriveFolderName(updated.outlet.code),
          programFolderName: layers.programFolderName,
          bookingFolderName: layers.bookingFolderName,
          // v1.112 — AGN: per-booking layer inside the project box (EP/CAM nest there).
          bookingSubfolderName: layers.bookingSubfolderName,
          bookingSubfolderCode: updated.bookingCode,
          // AGN box is keyed by projectId (not bookingCode) → keep exact-name match.
          bookingCode: updated.outlet.code === 'AGN' ? undefined : updated.bookingCode,
          cameras: camerasToPreCreate(updated.cameraCount, updated.micCount),
          // v1.93 — one folder per episode; empty for no-episode bookings.
          episodeFolderNames: updated.episodes.length ? updated.episodes.map(e => buildEpisodeFolderName(e, { useEpisodeId: isAgency })) : undefined,
        })
        await rememberDriveLinks(updated.id, { box: bookingFolderId })
        await upsertTextFile({
          parentFolderId: bookingFolderId,
          // v1.112 — AGN now gets its own booking layer, so a plain _SHOOT.txt
          // inside it is unambiguous (the old _SHOOT-<code>.txt sat box-level).
          name: '_SHOOT.txt',
          content: renderBookingInfo(bookingInfoInput(updated)),
        })
      } catch (e: any) {
        console.error('[approve] Drive pre-create failed (non-fatal):', e?.message || e)
      }
    })()

    // 1c) v1.108 — Sound team drops audio DIRECT into a staging tree OUTSIDE the
    //     video project folder (so the videographer's wholesale folder overwrite
    //     can't wipe it); the sound-merge routine folds it into the box AUDIO.
    //     Best-effort, additive to the video box. Only for Sound-crew bookings.
    ;(async () => {
      if (!updated.bookingCode || !hasDriveCredentials() || !bookingNeedsSound(updated.crewRequired)) return
      const root = process.env.DRIVE_FOOTAGE_ROOT?.trim()
      if (!root) return
      try {
        const jobName = updated.projectName?.trim() || updated.episodes[0]?.title?.trim() || null
        const { stagingFolderId } = await ensureSoundStagingFolder({
          rootFolderId: root,
          bookingCode: updated.bookingCode,
          bookingFolderName: landingBookingFolderName({ bookingCode: updated.bookingCode, projectName: updated.projectName, program: updated.program, episodes: updated.episodes }),
          // v1.125 — mirrors VIDEO 2026's outlet layer: _SOUND-STAGING/<NN · Outlet>/<รายการ>/<booking>/
          outletFolderName: outletDriveFolderName(updated.outlet.code),
          categoryName: soundStagingCategoryName({ outletCode: updated.outlet.code, projectName: updated.projectName, program: updated.program, episodes: updated.episodes }),
        })
        await rememberDriveLinks(updated.id, { staging: stagingFolderId })
      } catch (e: any) {
        console.error('[approve] sound staging pre-create failed (non-fatal):', e?.message || e)
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
              approvedAt: approvedAt.toLocaleString('th-TH-u-ca-gregory', { timeZone: 'Asia/Bangkok' }),
            }).catch(e => console.error('updateBookingRow error:', e?.message))
          }
          return
        }

        const calendarEventId = await createCalendarEvent({
          id: booking.id,
          bookingCode: booking.bookingCode,
          shootDate: booking.shootDate,
          shootEndDate: booking.shootEndDate,
          callTime: booking.callTime,
          estimatedWrap: booking.estimatedWrap,
          shootType: booking.shootType,
          videoType: booking.videoType,
          locationName: booking.locationName,
          producer: booking.producer,
          producerEmail: booking.producerEmail,
          cameraCount: booking.cameraCount,
          micCount: booking.micCount,
          vanCount: booking.vanCount,
          isBlockShot: booking.isBlockShot,
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
          // v1.111 — ALSO compare-and-swap on calendarEventId:null. Approve,
          // assign's auto-recover, and the reconciler can all create while the
          // id is still empty; without this CAS the later persist OVERWROTE the
          // earlier id, leaving that event on the calendar as a duplicate
          // (ops report 2026-07-02: two events per booking, created ~3s apart).
          const saved = await prisma.booking.updateMany({
            where: { id: params.id, status: 'CONFIRMED', deletedAt: null, calendarEventId: null },
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
            console.warn(`[approve] booking ${params.id} changed state or already has an event — deleting duplicate event ${calendarEventId}`)
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
            approvedAt: approvedAt.toLocaleString('th-TH-u-ca-gregory', { timeZone: 'Asia/Bangkok' }),
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

    // v1.131 — confirmation email to the original requester (best-effort,
    // never blocks the response — approve must succeed even if Gmail/SMTP is
    // down). Decoupled from the calendar IIFE above so it doesn't wait on
    // event creation; links to /dashboard/[id], viewable now that a CONFIRMED
    // booking is visible to any signed-in user (see booking-access.ts).
    const bookerEmail = (updated.createdByEmail || '').trim()
    if (bookerEmail && bookerEmail.toLowerCase() !== session.email.toLowerCase()) {
      sendBookingConfirmedEmail({
        to: bookerEmail,
        toName: bookerEmail.split('@')[0],
        bookingId: updated.id,
        bookingCode: updated.bookingCode,
        outletName: updated.outlet.name,
        programName: updated.program.name,
        shootDate: new Date(updated.shootDate).toISOString().slice(0, 10),
        shootEndDate: updated.shootEndDate ? new Date(updated.shootEndDate).toISOString().slice(0, 10) : null,
        callTime: updated.callTime,
        estimatedWrap: updated.estimatedWrap,
        shootType: updated.shootType,
        locationName: updated.locationName,
        producer: updated.producer,
        episodes: updated.episodes,
        notes: updated.notes,
        senderAccessToken,
        senderEmail: session.email,
      }).catch(e => console.error('[approve] booker confirmation email failed (non-fatal):', e?.message || e))
    }

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
