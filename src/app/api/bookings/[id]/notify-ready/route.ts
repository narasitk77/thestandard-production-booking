import { NextRequest, NextResponse } from 'next/server'
import { readHeld, heldStill } from '@/lib/footage-ready-health'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { formatBytes } from '@/lib/footage-report'
import { getCachedFootagePayload } from '@/lib/footage-folders'
import { bookingDisplayName } from '@/lib/display'
import { footageReadyRecipients, inactiveUserEmails, markReadyOnCalendarWithin } from '@/lib/footage-ready'
import { CARD_PREFIX } from '@/lib/ingest'
import { EPISODE_ORDER } from '@/lib/episode-order'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // resolving footage folders does a recursive Drive walk

/**
 * POST /api/bookings/:id/notify-ready
 *
 * v1.102.4 — "📣 แจ้งทุกคนว่าไฟล์พร้อม": email EVERYONE on the booking (producer +
 * assigned crew + creator, CC the sender) the footage folder links once the files
 * are in place. User-initiated (a deliberate outbound email), so each click sends.
 *
 * `?preview=1` (or body { preview: true }) returns the recipient list + folder
 * count WITHOUT sending — used for a confirm step (and safe to call in testing).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const preview = request.nextUrl.searchParams.get('preview') === '1' || body?.preview === true

    const booking = await prisma.booking.findUnique({
      where: { id: params.id },
      select: {
        id: true, driveFolders: true, bookingCode: true, status: true, deletedAt: true, crewRequired: true, readySnapshot: true, calendarEventId: true,
        assignedEmails: true, createdByEmail: true, producer: true, producerEmail: true, coProducerEmail: true,
        directorEmail: true, director2Email: true, director3Email: true,
        projectId: true, projectName: true, category: true, callTime: true, shootDate: true,
        outlet: { select: { code: true, name: true } },
        program: { select: { name: true } },
        episodes: {
          orderBy: EPISODE_ORDER,
          select: { episodeId: true, sequence: true, title: true, program: { select: { name: true } } },
        },
      },
    })
    if (!booking || booking.deletedAt) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    // Same gate as "ส่งงาน": assigned crew (CONFIRMED/COMPLETED) or admin.
    const check = await canUploadToBooking(session.email, {
      id: booking.id, status: booking.status, assignedEmails: booking.assignedEmails,
    })
    if (!check.ok && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'คุณไม่ได้รับมอบหมายงานนี้', code: check.reason ?? 'FORBIDDEN' }, { status: 403 })
    }

    // Everyone on the booking (same rule as the auto notice — v1.264 adds the Co-Producer), plus the
    // sender (CC self). De-dupe case-insensitively; keep only address-like entries.
    const team = footageReadyRecipients('everyone', booking, null, await inactiveUserEmails())
    const skippedInactive = team.inactive // v1.264 — คนที่ออกไปแล้วไม่ได้เมล (บอกใน preview + audit)
    const recipients = Array.from(new Set(
      [...team.people, session.email]
        .filter(Boolean).map(e => e!.trim().toLowerCase()).filter(e => e.includes('@')),
    ))

    const show = bookingDisplayName({ projectName: booking.projectName, program: booking.program, episodes: booking.episodes })
    const code = booking.bookingCode || booking.id

    // Resolve the footage folders SERVER-SIDE (don't trust client-supplied links in
    // an email that goes to many people). v1.111 — reuse the cached detect payload
    // the upload page just populated, so this is instant instead of re-walking Drive
    // twice (preview + send).
    let payload = await getCachedFootagePayload(booking, { refresh: false })
    // v1.111 — if the cache says empty, re-check with a FRESH walk before blocking:
    // a stale/uninvalidated empty cache must never falsely block a real "ready" send.
    if (payload.folders.length === 0) payload = await getCachedFootagePayload(booking, { refresh: true })
    const { folders, fileCount, bookingFolderUrl } = payload
    if (folders.length === 0) {
      return NextResponse.json({ error: 'ยังไม่เจอ footage ในโฟลเดอร์ Drive ของงานนี้ — ตรวจสอบก่อนแจ้ง' }, { status: 400 })
    }

    // v1.277 — a field-ingest card still open (proxies only, or a dead laptop) means the originals are not
    // here: same hold as the auto notice. A 📣 now would stamp readyNotifiedAt and the real notice never follows.
    const openCards = await prisma.upload.findMany({
      where: { bookingId: booking.id, fileName: { startsWith: CARD_PREFIX }, status: { in: ['UPLOADING', 'ORPHANED'] } },
      select: { fileName: true, camera: true, status: true },
    })
    if (openCards.length > 0) {
      const list = openCards.map(c => `${c.camera} ${c.fileName} (${c.status === 'ORPHANED' ? 'ขาดการติดต่อ' : 'ยังส่งอยู่/รอต้นฉบับ'})`).join(', ')
      return NextResponse.json({ error: `ส่งจากหน้างานยังไม่ครบ: ${list} — รอให้ครบ หรือให้แอดมินปลดการ์ดก่อนแจ้ง`, code: 'INGEST_OPEN' }, { status: 409 })
    }

    if (preview) {
      // v1.274 — this button does not run the MEDIAPRO gate; say what the auto path saw before a human overrides it
      const held = heldStill(readHeld(booking.readySnapshot), fileCount, folders.reduce((n: number, f: any) => n + (f.totalBytes || 0), 0))
      return NextResponse.json({ preview: true, recipients, skippedInactive, folderCount: folders.length, fileCount, emailConfigured: isEmailConfigured(),
        held })
    }

    const shootDate = new Date(booking.shootDate).toISOString().slice(0, 10)
    const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.thestandard.co'
    const folderLines = folders.map(f => `• ${f.label} — ${f.fileCount} ไฟล์ · ${formatBytes(f.totalBytes)}\n  ${f.url}`).join('\n')

    // Nothing can be delivered → say so BEFORE anything is stamped or logged as sent.
    // (This used to answer ok:true and stamp readyNotifiedAt with no mail sent; the
    // auto notifier only looks at readyNotifiedAt:null rows, so once SMTP came back
    // nobody on the booking ever got the footage-ready notice.)
    if (!isEmailConfigured()) {
      return NextResponse.json({ error: 'ระบบอีเมลยังไม่ได้ตั้งค่า — ยังไม่มีใครได้รับแจ้ง (ไม่ได้บันทึกว่าแจ้งแล้ว ระบบอัตโนมัติจะยังแจ้งให้เมื่อพร้อม)', code: 'EMAIL_NOT_CONFIGURED' }, { status: 503 })
    }

    const subject = `[Footage พร้อม] ${code} — ${show}`
    const text = `footage ของ ${code} พร้อมแล้ว ✅
${booking.outlet.name} · ${show} · ${shootDate} ${booking.callTime}
แจ้งโดย: ${session.email}

— โฟลเดอร์ footage (${folders.length} โฟลเดอร์ · ${fileCount} ไฟล์) —
${folderLines}
${bookingFolderUrl ? `\nเปิดกล่องงานทั้งหมด: ${bookingFolderUrl}` : ''}

เปิดในระบบ: ${appUrl}/upload?bookingId=${booking.id}

THE STANDARD Production Booking`
    // Send INDIVIDUALLY (one email per recipient) so people don't see each
    // other's addresses — assignedEmails can include external freelancers
    // (admin free-text, often personal gmail) and sendEmail has no BCC.
    // Mirrors the per-recipient send in the admin assign route.
    const results = await Promise.allSettled(recipients.map(to => sendEmail({ to: [to], subject, text })))
    // a record is not delivery: report and log only the addresses that were accepted
    const delivered = recipients.filter((_, i) => results[i].status === 'fulfilled')
    const failedRecipients = recipients.filter((_, i) => results[i].status === 'rejected')
    const emailed = delivered.length
    const emailError = failedRecipients.length
      ? `${failedRecipients.length}/${results.length} ส่งไม่สำเร็จ: ${failedRecipients.join(', ')}`
      : null
    if (failedRecipients.length > 0) {
      console.error('[notify-ready] some emails failed:', results.filter(r => r.status === 'rejected'))
    }

    // Delivery is counted over the PEOPLE ON THE JOB (team.people), not the
    // clicker's CC: if every team address bounced and only the clicker's own copy
    // was accepted, stamping readyNotifiedAt would stop the auto notice from ever
    // reaching the crew. (A clicker who is on the team is one of the team.)
    const teamSet = new Set(team.people.map(e => e.trim().toLowerCase()).filter(e => e.includes('@')))
    const teamDelivered = delivered.filter(e => teamSet.has(e))
    if (teamSet.size > 0 ? teamDelivered.length === 0 : emailed === 0) {
      // Not 'booking.notified_ready' — that row is relayed as "ฟุตเทจพร้อม" and
      // counted by the follow-up notifier as a notice that went out.
      logAudit({
        actorEmail: session.email,
        action: 'booking.notify_ready_failed',
        entityType: 'Booking',
        entityId: booking.id,
        bookingCode: booking.bookingCode,
        changes: { recipients, delivered, failedRecipients, folderCount: folders.length, fileCount, emailError },
      })
      const who = emailed === 0 ? 'ใครเลย' : `คนในงานเลย (ถึงแค่ ${delivered.join(', ')})`
      return NextResponse.json({
        error: `ส่งเมลไม่ถึง${who} (${emailError}) — ยังไม่ได้บันทึกว่าแจ้งแล้ว ลองใหม่ภายหลัง`,
        code: 'EMAIL_FAILED', emailed, recipients: delivered, failedRecipients, emailError,
      }, { status: 502 })
    }

    // v1.147 — stamp the auto-notifier's send-once marker: a manual 📣 that
    // reached people means the footage-ready worker must not send a duplicate
    // later. Manual clicks themselves stay unlimited (this stamp only gates the
    // AUTO path). Stamped only when someone on the job got it (above).
    // A partial failure still stamps (one bad freelancer address must not make
    // the auto path re-mail everyone) — emailError names who missed it.
    const readyAt = new Date()
    prisma.booking.update({ where: { id: booking.id }, data: { readyNotifiedAt: readyAt } })
      .catch(e => console.error('[notify-ready] readyNotifiedAt stamp failed (auto notice may duplicate):', e?.message || e))

    logAudit({
      actorEmail: session.email,
      action: 'booking.notified_ready',
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      changes: { recipients: delivered, ...(failedRecipients.length ? { failedRecipients } : {}), ...(skippedInactive.length ? { skippedInactive } : {}), folderCount: folders.length, fileCount, emailError },
    })

    // v1.288 — ✅ + box link on the calendar event now; a failure is retried by the footage-ready sweep (never fails the 📣)
    // the box the mail links to (resolved by name/code when the booking has no stored id) — review v1.288
    const resolvedBox = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(bookingFolderUrl || '')?.[1] || null
    const calendar = await markReadyOnCalendarWithin({ ...booking, readyNotifiedAt: readyAt }, session.email, resolvedBox)
    if (!calendar.ok) console.error('[notify-ready] calendar ✅ failed (sweep retries):', booking.bookingCode, calendar.error)

    return NextResponse.json({
      ok: true,
      emailed,
      calendar: calendar.ok ? calendar.state : 'retry-later', // 'no-event' = this booking has no calendar event
      // delivered only — the card says "ส่งแล้ว N คน" from this list
      recipients: delivered,
      failedRecipients,
      folderCount: folders.length,
      fileCount,
      emailConfigured: true,
      emailError,
    })
  } catch (e: any) {
    console.error('POST /api/bookings/[id]/notify-ready error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
