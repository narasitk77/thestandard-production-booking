import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { isMonthEditable } from '@/lib/ot-cleanup'
import { parseTimeToMinutes } from '@/lib/ot-calc'

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

    const body = await request.json()
    const { date, startTime, endTime, jobTask, justification } = body

    if (startTime !== undefined && endTime !== undefined) {
      const sMin = parseTimeToMinutes(startTime)
      const eMin = parseTimeToMinutes(endTime)
      if (sMin === null || eMin === null) {
        return NextResponse.json({ error: 'Invalid time format' }, { status: 400 })
      }
      if (eMin <= sMin) {
        return NextResponse.json({ error: 'End time must be after start time' }, { status: 400 })
      }
    }

    const updated = await prisma.oTRecord.update({
      where: { id: params.id },
      data: {
        ...(date && { date: new Date(date), month: date.slice(0, 7) }),
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        ...(jobTask !== undefined && { jobTask: jobTask?.trim() || null }),
        ...(justification !== undefined && { justification: justification?.trim() || null }),
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

    await prisma.oTRecord.delete({ where: { id: params.id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/ot/[id] error:', e)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
