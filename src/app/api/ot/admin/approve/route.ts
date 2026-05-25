import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'

/**
 * POST /api/ot/admin/approve  { email, month }
 *
 * Admin/manager-only. Bulk-approves every SUBMITTED OT record belonging to
 * the given user in the given month at once — "approve the whole report".
 * Records in DRAFT/APPROVED/REJECTED are left untouched (idempotent), so
 * pressing the button twice is harmless.
 *
 * Snapshots the approver's saved signature onto each approved record.
 *
 * Phase 3 extends this endpoint with two more modes (recordIds[],
 * allSubmitted) — Phase 1 keeps the original {email, month} shape only.
 *
 * Returns { ok, approved, email, month } where `approved` is the number of
 * records that flipped from SUBMITTED to APPROVED on this call.
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

    // Snapshot the approver's saved signature so changing it later does not
    // alter historical OT reports. Approvers without a saved signature can
    // still approve — the snapshot will simply be null and the PDF export
    // will print a typed-name fallback.
    const approver = await prisma.user.findUnique({
      where: { email: session.email },
      select: { signaturePng: true },
    })

    const result = await prisma.oTRecord.updateMany({
      where: { userEmail: email, month, approvalStatus: 'SUBMITTED' },
      data: {
        approvalStatus: 'APPROVED',
        approvedByEmail: session.email,
        approvedAt: new Date(),
        approverSignaturePng: approver?.signaturePng ?? null,
      },
    })

    return NextResponse.json({ ok: true, approved: result.count, email, month })
  } catch (e) {
    console.error('POST /api/ot/admin/approve error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
