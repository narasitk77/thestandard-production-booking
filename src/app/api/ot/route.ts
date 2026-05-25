import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, getOTApproverAccess } from '@/lib/session'
import { cleanupOTRecords, currentMonthYYYYMM, isMonthEditable } from '@/lib/ot-cleanup'
import { parseTimeToMinutes } from '@/lib/ot-calc'

function deriveMonth(dateStr: string): string {
  return dateStr.slice(0, 7)
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    cleanupOTRecords().catch(() => {})

    const { searchParams } = new URL(request.url)
    const month = searchParams.get('month') || currentMonthYYYYMM()
    const email = searchParams.get('email')
    const all = searchParams.get('all') === '1'

    // v1.33.4 — OT approvers (ADMIN || position contains "manager") can
    // query other users' records via ?email=... so the review page works
    // for managers, not just admins.
    const canSeeOthers = session.role === 'ADMIN' || (await getOTApproverAccess(session.email))
    const targetEmail = (canSeeOthers && (email || all))
      ? email
      : session.email

    const records = await prisma.oTRecord.findMany({
      where: {
        month,
        ...(targetEmail ? { userEmail: targetEmail } : {}),
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
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
    const { date, startTime, endTime, jobTask, justification } = body

    if (!date) return NextResponse.json({ error: 'Date is required' }, { status: 400 })
    if (!startTime || !endTime) {
      return NextResponse.json({ error: 'Start time and end time are required' }, { status: 400 })
    }
    const sMin = parseTimeToMinutes(startTime)
    const eMin = parseTimeToMinutes(endTime)
    if (sMin === null || eMin === null) {
      return NextResponse.json({ error: 'Invalid time format (use HH:MM)' }, { status: 400 })
    }
    if (eMin <= sMin) {
      return NextResponse.json({ error: 'End time must be after start time' }, { status: 400 })
    }
    if (!jobTask || !jobTask.trim()) {
      return NextResponse.json({ error: 'Job task description is required' }, { status: 400 })
    }
    if (!justification || !justification.trim()) {
      return NextResponse.json({ error: 'Justification is required (why OT was necessary)' }, { status: 400 })
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
        startTime,
        endTime,
        jobTask: jobTask.trim(),
        justification: justification.trim(),
        // legacy fields kept null for new records
      },
    })

    return NextResponse.json({ record }, { status: 201 })
  } catch (e) {
    console.error('POST /api/ot error:', e)
    return NextResponse.json({ error: 'Failed to create' }, { status: 500 })
  }
}
