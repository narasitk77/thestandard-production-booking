import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { cleanupOTRecords, currentMonthYYYYMM, isMonthEditable } from '@/lib/ot-cleanup'

function deriveMonth(dateStr: string): string {
  return dateStr.slice(0, 7)
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Lazy cleanup
    cleanupOTRecords().catch(() => {})

    const { searchParams } = new URL(request.url)
    const month = searchParams.get('month') || currentMonthYYYYMM()
    const email = searchParams.get('email')
    const all = searchParams.get('all') === '1'

    // Non-admins can only see their own records (regardless of email param)
    const targetEmail = (session.role === 'ADMIN' && (email || all))
      ? email
      : session.email

    const records = await prisma.oTRecord.findMany({
      where: {
        month,
        ...(targetEmail ? { userEmail: targetEmail } : {}),
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    })

    return NextResponse.json({
      records,
      month,
      editable: isMonthEditable(month),
      currentMonth: currentMonthYYYYMM(),
    })
  } catch (e) {
    console.error('GET /api/ot error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const { date, type, hours, description } = body

    if (!date || !type) {
      return NextResponse.json({ error: 'Date and type are required' }, { status: 400 })
    }
    if (type !== 'HOLIDAY' && type !== 'OVERTIME') {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }

    const month = deriveMonth(date)
    if (!isMonthEditable(month)) {
      return NextResponse.json({ error: 'Cannot add records to a closed month' }, { status: 400 })
    }

    const record = await prisma.oTRecord.create({
      data: {
        userEmail: session.email,
        month,
        date: new Date(date),
        type,
        hours: type === 'OVERTIME' ? Number(hours) || 0 : 0,
        description: description?.trim() || null,
      },
    })

    return NextResponse.json({ record }, { status: 201 })
  } catch (e) {
    console.error('POST /api/ot error:', e)
    return NextResponse.json({ error: 'Failed to create' }, { status: 500 })
  }
}
