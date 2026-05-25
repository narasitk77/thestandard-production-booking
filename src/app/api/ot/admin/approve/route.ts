import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireOTApprover } from '@/lib/session'

/**
 * POST /api/ot/admin/approve
 *
 * Admin/manager-only. Approves SUBMITTED OT records in one of three modes:
 *
 *   1) { email, month }              — bulk-approve every SUBMITTED row for
 *                                      one user in one month (legacy mode
 *                                      from v1.32, kept stable).
 *   2) { recordIds: string[] }       — approve a hand-picked set of rows
 *                                      (used by manager bulk-select on
 *                                      /ot/admin and per-row approve on
 *                                      /ot/admin/review/[email]).
 *   3) { month, allSubmitted: true } — "approve every SUBMITTED row in this
 *                                      month across all users" — the
 *                                      one-click month close button.
 *
 * Modes are mutually exclusive — `recordIds` takes precedence, then
 * `allSubmitted`, then the legacy `{email, month}` shape.
 *
 * Only rows currently in SUBMITTED are touched (idempotent across
 * re-clicks; never silently moves a DRAFT/REJECTED row past the user).
 * The approver's saved signature is snapshotted onto every approved row.
 *
 * Returns { ok, approved, mode } where `approved` is the count of rows
 * that flipped SUBMITTED → APPROVED on this call.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireOTApprover()
    if (!session) {
      return NextResponse.json({ error: 'OT approver only' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))

    const approver = await prisma.user.findUnique({
      where: { email: session.email },
      select: { signaturePng: true },
    })
    const approvedAt = new Date()
    const writeData = {
      approvalStatus: 'APPROVED' as const,
      approvedByEmail: session.email,
      approvedAt,
      approverSignaturePng: approver?.signaturePng ?? null,
    }

    // Mode 1: explicit recordIds — hand-picked rows
    if (Array.isArray(body.recordIds) && body.recordIds.length > 0) {
      const ids = body.recordIds.map((x: unknown) => String(x)).filter(Boolean)
      const result = await prisma.oTRecord.updateMany({
        where: { id: { in: ids }, approvalStatus: 'SUBMITTED' },
        data: writeData,
      })
      return NextResponse.json({ ok: true, approved: result.count, mode: 'recordIds' })
    }

    const month = String(body.month || '').trim()
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
    }

    // Mode 2: month-wide approve everyone
    if (body.allSubmitted === true) {
      const result = await prisma.oTRecord.updateMany({
        where: { month, approvalStatus: 'SUBMITTED' },
        data: writeData,
      })
      return NextResponse.json({ ok: true, approved: result.count, mode: 'allSubmitted', month })
    }

    // Mode 3: legacy single-person/month
    const email = String(body.email || '').trim().toLowerCase()
    if (!email) {
      return NextResponse.json({ error: 'email is required (or pass recordIds / allSubmitted)' }, { status: 400 })
    }
    const result = await prisma.oTRecord.updateMany({
      where: { userEmail: email, month, approvalStatus: 'SUBMITTED' },
      data: writeData,
    })
    return NextResponse.json({ ok: true, approved: result.count, mode: 'email', email, month })
  } catch (e) {
    console.error('POST /api/ot/admin/approve error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
