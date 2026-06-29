import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { isMonthEditable } from '@/lib/ot-cleanup'
import { parseTimeToMinutes, dateOffsetDays } from '@/lib/ot-calc'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const existing = await prisma.oTRecord.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (existing.userEmail !== session.email && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!isMonthEditable(existing.month)) {
      return NextResponse.json({ error: 'Closed month — read-only' }, { status: 400 })
    }

    if (existing.bookingId) {
      return NextResponse.json({ error: 'Auto records from bookings cannot be edited — change the booking instead' }, { status: 400 })
    }

    // Approval-state gate (v1.33.0):
    //   - APPROVED: locked for the owner; admin can still edit (correction path).
    //   - SUBMITTED: owner edits silently revert the record to DRAFT so the
    //     manager isn't asked to approve content they haven't seen. Cleared
    //     submission metadata forces a re-submit + re-sign.
    //   - DRAFT/REJECTED: fully editable.
    if (existing.approvalStatus === 'APPROVED' && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'รายการนี้อนุมัติแล้ว — ไม่สามารถแก้ไขได้ (ติดต่อ admin หากต้องการแก้)' }, { status: 400 })
    }

    const body = await request.json()
    const { date, endDate, startTime, endTime, jobTask, justification } = body

    // v1.42.0 — validate against the EFFECTIVE values (new where provided, else
    // existing) so an overnight shift's duration is checked across the day
    // boundary even when only one field changes.
    const effStartTime = startTime !== undefined ? startTime : existing.startTime
    const effEndTime = endTime !== undefined ? endTime : existing.endTime
    const effDateISO = (date !== undefined ? String(date) : existing.date.toISOString()).slice(0, 10)
    const endDateProvided = endDate !== undefined
    const effEndDateISO = endDateProvided
      ? (endDate ? String(endDate).slice(0, 10) : null)
      : (existing.endDate ? existing.endDate.toISOString().slice(0, 10) : null)

    if (effStartTime && effEndTime) {
      const sMin = parseTimeToMinutes(effStartTime)
      const eMin = parseTimeToMinutes(effEndTime)
      if (sMin === null || eMin === null) {
        return NextResponse.json({ error: 'Invalid time format' }, { status: 400 })
      }
      const offsetDays = dateOffsetDays(effDateISO, effEndDateISO)
      const durationMin = offsetDays * 1440 + eMin - sMin
      if (durationMin <= 0) {
        return NextResponse.json(
          { error: 'End must be after start — set the end date to the next day if the shift runs past midnight' },
          { status: 400 },
        )
      }
      if (durationMin > 1440) {
        return NextResponse.json({ error: 'OT shift cannot exceed 24 hours — check the start/end dates' }, { status: 400 })
      }
    }

    // A date change rewrites the record's month (line below). The existing.month
    // gate only proved the CURRENT month is open — re-check the DESTINATION month
    // so a record can't be moved into a closed/exported month (POST already blocks
    // creating into a closed month; this closes the same hole on edit).
    if (date && !isMonthEditable(String(date).slice(0, 7))) {
      return NextResponse.json({ error: 'Cannot move a record into a closed month' }, { status: 400 })
    }

    const ownerEditingSubmitted =
      existing.userEmail === session.email && existing.approvalStatus === 'SUBMITTED'

    const updated = await prisma.oTRecord.update({
      where: { id: params.id },
      data: {
        ...(date && { date: new Date(date), month: date.slice(0, 7) }),
        ...(endDateProvided && { endDate: endDate ? new Date(endDate) : null }),
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        ...(jobTask !== undefined && { jobTask: jobTask?.trim() || null }),
        ...(justification !== undefined && { justification: justification?.trim() || null }),
        ...(ownerEditingSubmitted && {
          approvalStatus: 'DRAFT' as const,
          submittedAt: null,
          requesterSignaturePng: null,
        }),
      },
    })

    return NextResponse.json({ record: updated })
  } catch (e) {
    console.error('PATCH /api/ot/[id] error:', e)
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const existing = await prisma.oTRecord.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (existing.userEmail !== session.email && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (!isMonthEditable(existing.month) && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Closed month — read-only' }, { status: 400 })
    }
    if (existing.bookingId && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Auto records from bookings — sync via the booking, not manual delete' }, { status: 400 })
    }
    // Approval-state gate (v1.33.0): owner cannot delete an APPROVED record;
    // admins can (correction path). SUBMITTED/REJECTED/DRAFT are deletable
    // by the owner — the record disappears entirely so there's no half-state
    // to reconcile.
    if (existing.approvalStatus === 'APPROVED' && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'รายการนี้อนุมัติแล้ว — ไม่สามารถลบได้ (ติดต่อ admin หากต้องการลบ)' }, { status: 400 })
    }

    await prisma.oTRecord.delete({ where: { id: params.id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/ot/[id] error:', e)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
