import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { currentMonthYYYYMM } from '@/lib/ot-cleanup'

interface PersonSummary {
  userId: string | null
  email: string
  thaiName: string
  employeeId: string
  position: string
  role: string
  active: boolean
  holidayDays: number
  otHours: number
}

export async function GET(request: NextRequest) {
  try {
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const month = searchParams.get('month') || currentMonthYYYYMM()
    const includeInactive = searchParams.get('includeInactive') === '1'

    const records = await prisma.oTRecord.findMany({ where: { month } })
    const users = await prisma.user.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ employeeId: 'asc' }, { createdAt: 'asc' }],
    })

    // Build aggregations from records
    const totals = new Map<string, { holidayDays: number; otHours: number }>()
    for (const r of records) {
      const k = r.userEmail.toLowerCase()
      if (!totals.has(k)) totals.set(k, { holidayDays: 0, otHours: 0 })
      const t = totals.get(k)!
      if (r.type === 'HOLIDAY') t.holidayDays += 1
      if (r.type === 'OVERTIME') t.otHours += r.hours
    }

    // One row per user
    const summary: PersonSummary[] = users.map(u => {
      const t = totals.get(u.email.toLowerCase()) || { holidayDays: 0, otHours: 0 }
      return {
        userId: u.id,
        email: u.email,
        thaiName: u.thaiName || '',
        employeeId: u.employeeId || '',
        position: u.position || '',
        role: u.role,
        active: u.active,
        holidayDays: t.holidayDays,
        otHours: Math.round(t.otHours * 100) / 100,
      }
    })

    // Include any orphan emails (records but no User row)
    const userEmails = new Set(users.map(u => u.email.toLowerCase()))
    Array.from(totals.entries()).forEach(([email, t]) => {
      if (!userEmails.has(email)) {
        summary.push({
          userId: null,
          email,
          thaiName: '(unknown)',
          employeeId: '',
          position: '',
          role: 'USER',
          active: true,
          holidayDays: t.holidayDays,
          otHours: Math.round(t.otHours * 100) / 100,
        })
      }
    })

    return NextResponse.json({ month, summary })
  } catch (e) {
    console.error('GET /api/ot/summary error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
