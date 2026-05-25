import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { isMonthEditable } from '@/lib/ot-cleanup'

/**
 * POST /api/ot/submit  { month: "YYYY-MM" }
 *
 * User-facing. Flips every DRAFT or REJECTED record the signed-in user has
 * in the given month to SUBMITTED, stamping `submittedAt` and snapshotting
 * the user's current signature onto each record.
 *
 * - APPROVED rows are untouched (manager already signed off).
 * - Already-SUBMITTED rows are untouched (idempotent re-clicks).
 * - Rejection notes from the previous round are cleared so the manager
 *   sees a clean queue.
 *
 * Requires the user to have a saved signature at /profile/signature —
 * the signature is the legal sign-off, so submitting without one is
 * blocked at the API level.
 *
 * Returns { ok, submitted, month } where `submitted` is the number of
 * records that flipped on this call (DRAFT + REJECTED → SUBMITTED).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const month = String(body.month || '').trim()
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    }
    if (!isMonthEditable(month)) {
      return NextResponse.json({ error: 'เดือนนี้ปิดแล้ว — ไม่สามารถส่งใหม่ได้' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { email: session.email },
      select: { signaturePng: true },
    })
    if (!user?.signaturePng) {
      return NextResponse.json({
        error: 'ยังไม่ได้ตั้งลายเซ็น — ไปที่ /profile/signature เพื่อตั้งลายเซ็นก่อน',
        code: 'NO_SIGNATURE',
      }, { status: 400 })
    }

    const now = new Date()
    const result = await prisma.oTRecord.updateMany({
      where: {
        userEmail: session.email,
        month,
        approvalStatus: { in: ['DRAFT', 'REJECTED'] },
      },
      data: {
        approvalStatus: 'SUBMITTED',
        submittedAt: now,
        requesterSignaturePng: user.signaturePng,
        rejectionNote: null,
      },
    })

    return NextResponse.json({ ok: true, submitted: result.count, month })
  } catch (e) {
    console.error('POST /api/ot/submit error:', e)
    return NextResponse.json({ error: 'Failed to submit' }, { status: 500 })
  }
}
