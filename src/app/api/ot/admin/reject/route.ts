import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireOTApprover } from '@/lib/session'

/**
 * POST /api/ot/admin/reject  { recordId, note }
 *
 * Admin/manager-only. Flips a SUBMITTED row to REJECTED, attaching the
 * manager's note for the user to read. The user can edit the row and
 * resubmit via POST /api/ot/submit, which clears the note and bumps
 * the row back to SUBMITTED.
 *
 * Rejecting a non-SUBMITTED row is a no-op (returns 200 with
 * rejected: 0) — managers don't accidentally re-reject rows after the
 * user has already updated them.
 *
 * `note` is required and non-empty — silent rejects don't give the
 * user enough information to act.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireOTApprover()
    if (!session) {
      return NextResponse.json({ error: 'OT approver only' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const recordId = String(body.recordId || '').trim()
    const note = String(body.note || '').trim()

    if (!recordId) {
      return NextResponse.json({ error: 'recordId is required' }, { status: 400 })
    }
    if (!note) {
      return NextResponse.json({ error: 'note is required (เหตุผลที่ตีกลับ)' }, { status: 400 })
    }
    if (note.length > 500) {
      return NextResponse.json({ error: 'note must be 500 chars or fewer' }, { status: 400 })
    }

    const result = await prisma.oTRecord.updateMany({
      where: { id: recordId, approvalStatus: 'SUBMITTED' },
      data: {
        approvalStatus: 'REJECTED',
        rejectionNote: note,
        // Clear approval metadata in case this row was previously approved
        // and is now being re-reviewed (shouldn't happen via the UI, but
        // belt-and-suspenders for direct API callers).
        approvedAt: null,
        approvedByEmail: null,
        approverSignaturePng: null,
      },
    })

    return NextResponse.json({ ok: true, rejected: result.count })
  } catch (e) {
    console.error('POST /api/ot/admin/reject error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
