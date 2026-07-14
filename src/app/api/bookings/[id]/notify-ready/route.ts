import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, canUploadToBooking } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import { sendEmail, isEmailConfigured } from '@/lib/email'
import { formatBytes } from '@/lib/footage-report'
import { getCachedFootagePayload } from '@/lib/footage-folders'
import { bookingDisplayName } from '@/lib/display'

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
        id: true, driveFolders: true, bookingCode: true, status: true, deletedAt: true, crewRequired: true,
        assignedEmails: true, createdByEmail: true, producer: true, producerEmail: true,
        projectId: true, projectName: true, category: true, callTime: true, shootDate: true,
        outlet: { select: { code: true, name: true } },
        program: { select: { name: true } },
        episodes: {
          orderBy: { sequence: 'asc' },
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

    // Everyone on the booking: producer + assigned crew + creator, plus the sender
    // (CC self). De-dupe case-insensitively; keep only address-like entries.
    const recipients = Array.from(new Set(
      [booking.producerEmail, booking.createdByEmail, ...(booking.assignedEmails || []), session.email]
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

    if (preview) {
      return NextResponse.json({ preview: true, recipients, folderCount: folders.length, fileCount, emailConfigured: isEmailConfigured() })
    }

    const shootDate = new Date(booking.shootDate).toISOString().slice(0, 10)
    const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
    const folderLines = folders.map(f => `• ${f.label} — ${f.fileCount} ไฟล์ · ${formatBytes(f.totalBytes)}\n  ${f.url}`).join('\n')

    let emailed = 0
    let emailError: string | null = null
    if (isEmailConfigured()) {
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
      emailed = results.filter(r => r.status === 'fulfilled').length
      const failed = results.length - emailed
      if (failed > 0) {
        emailError = `${failed}/${results.length} ส่งไม่สำเร็จ`
        console.error('[notify-ready] some emails failed:', results.filter(r => r.status === 'rejected'))
      }
    }

    // v1.147 — stamp the auto-notifier's send-once marker: a manual 📣 means
    // everyone already got the links, so the footage-ready worker must not
    // send a duplicate later. Manual clicks themselves stay unlimited (this
    // stamp only gates the AUTO path). Best-effort — never fails the send.
    prisma.booking.update({ where: { id: booking.id }, data: { readyNotifiedAt: new Date() } }).catch(() => {})

    logAudit({
      actorEmail: session.email,
      action: 'booking.notified_ready',
      entityType: 'Booking',
      entityId: booking.id,
      bookingCode: booking.bookingCode,
      changes: { recipients, folderCount: folders.length, fileCount, emailError },
    })

    return NextResponse.json({
      ok: true,
      emailed,
      recipients,
      folderCount: folders.length,
      fileCount,
      emailConfigured: isEmailConfigured(),
      emailError,
    })
  } catch (e: any) {
    console.error('POST /api/bookings/[id]/notify-ready error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
