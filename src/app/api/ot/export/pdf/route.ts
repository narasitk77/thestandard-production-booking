import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin, getSession } from '@/lib/session'
import { currentMonthYYYYMM } from '@/lib/ot-cleanup'
import { generateOTCoverSheetPdf, type OTPdfPerson, type OTPdfRecord } from '@/lib/ot-pdf'

/**
 * GET /api/ot/export/pdf?month=YYYY-MM[&email=...]
 *
 * - With `email`: returns a single-person, single-page cover sheet PDF.
 *   Accessible by the owner OR an admin.
 * - Without `email`: returns the multi-page cover sheet for every active
 *   user in the month. Admin-only.
 *
 * Each page embeds the snapshotted requester + approver signatures as
 * actual PNG images rendered into the signature boxes, so the printed
 * PDF is itself the signed artifact (no need to re-sign on paper).
 *
 * Output is application/pdf with a Content-Disposition that suggests
 * `OT-{month}-{email-or-all}.pdf` as the download filename.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const month = searchParams.get('month') || currentMonthYYYYMM()
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    }
    const emailParam = (searchParams.get('email') || '').trim().toLowerCase()

    // Access control: single-person mode is open to the owner OR an admin;
    // bulk export is admin-only.
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (emailParam) {
      if (session.email !== emailParam && session.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } else {
      if (!(await requireAdmin())) {
        return NextResponse.json({ error: 'Admin only' }, { status: 403 })
      }
    }

    // Fetch records — single user or month-wide
    const records = await prisma.oTRecord.findMany({
      where: {
        month,
        ...(emailParam ? { userEmail: emailParam } : {}),
      },
      orderBy: [{ userEmail: 'asc' }, { date: 'asc' }, { startTime: 'asc' }],
    })

    // Look up profile metadata for the emails in the result set so the
    // page header reads ชื่อ-นามสกุล / รหัสพนักงาน / ตำแหน่ง rather than
    // bare email addresses.
    const emails = Array.from(new Set(records.map(r => r.userEmail.toLowerCase())))
    const userRows = emails.length === 0 ? [] : await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { email: true, thaiName: true, employeeId: true, position: true },
    })
    const userMap = new Map(userRows.map(u => [u.email.toLowerCase(), u]))

    // Group records by user, preserving the userEmail order from the
    // ORDER BY above so emails without a User row still get a page
    // (rendered with email-only header).
    const byUser = new Map<string, OTPdfRecord[]>()
    for (const r of records) {
      const key = r.userEmail.toLowerCase()
      if (!byUser.has(key)) byUser.set(key, [])
      byUser.get(key)!.push({
        id: r.id,
        date: r.date.toISOString().slice(0, 10),
        startTime: r.startTime,
        endTime: r.endTime,
        jobTask: r.jobTask,
        justification: r.justification,
        approvalStatus: r.approvalStatus as OTPdfRecord['approvalStatus'],
        submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
        approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
        approvedByEmail: r.approvedByEmail,
        requesterSignaturePng: r.requesterSignaturePng,
        approverSignaturePng: r.approverSignaturePng,
        bookingId: r.bookingId,
      })
    }

    const people: OTPdfPerson[] = Array.from(byUser.entries()).map(([email, recs]) => {
      const u = userMap.get(email)
      return {
        email,
        thaiName: u?.thaiName ?? null,
        employeeId: u?.employeeId ?? null,
        position: u?.position ?? null,
        records: recs,
      }
    })

    const pdfBytes = await generateOTCoverSheetPdf(people, month)

    const safeName = emailParam
      ? emailParam.replace(/[^a-z0-9._-]/gi, '_')
      : 'all'
    const filename = `OT-${month}-${safeName}.pdf`

    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    console.error('GET /api/ot/export/pdf error:', e)
    return NextResponse.json({ error: 'Failed to generate PDF' }, { status: 500 })
  }
}
