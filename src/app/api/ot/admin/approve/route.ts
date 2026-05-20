import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'

/**
 * POST /api/ot/admin/approve  { email, month }
 *
 * Admin/manager-only. Bulk-approves every PENDING OT record belonging to
 * the given user in the given month at once — "approve the whole report".
 * Records that are already APPROVED are left untouched (idempotent), so
 * pressing the button twice is harmless.
 *
 * Returns { ok, approved, email, month } where `approved` is the number of
 * records that flipped from PENDING to APPROVED on this call.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()
    const month = String(body.month || '').trim()
    if (!email) {
      return NextResponse.json({ error: 'email is required' }, { status: 400 })
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    }

    const result = await prisma.oTRecord.updateMany({
      where: { userEmail: email, month, approvalStatus: 'PENDING' },
      data: {
        approvalStatus: 'APPROVED',
        approvedByEmail: session.email,
        approvedAt: new Date(),
      },
    })

    return NextResponse.json({ ok: true, approved: result.count, email, month })
  } catch (e) {
    console.error('POST /api/ot/admin/approve error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
