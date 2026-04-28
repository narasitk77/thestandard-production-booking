import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { isMonthEditable } from '@/lib/ot-cleanup'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const existing = await prisma.oTRecord.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Only owner or admin can edit
    if (existing.userEmail !== session.email && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!isMonthEditable(existing.month)) {
      return NextResponse.json({ error: 'Closed month — read-only' }, { status: 400 })
    }

    const body = await request.json()
    const { date, type, hours, description } = body

    const updated = await prisma.oTRecord.update({
      where: { id: params.id },
      data: {
        ...(date && { date: new Date(date), month: date.slice(0, 7) }),
        ...(type && { type }),
        ...(hours !== undefined && { hours: Number(hours) || 0 }),
        ...(description !== undefined && { description: description?.trim() || null }),
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

    await prisma.oTRecord.delete({ where: { id: params.id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/ot/[id] error:', e)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
