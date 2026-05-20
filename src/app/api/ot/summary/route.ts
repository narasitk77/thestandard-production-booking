import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { currentMonthYYYYMM } from '@/lib/ot-cleanup'
import { summarizeDay } from '@/lib/ot-calc'

interface PersonSummary {
  userId: string | null
  email: string
  thaiName: string
  employeeId: string
  position: string
  role: string
  active: boolean
  weekendHolidayDays: number  // count of qualifying weekend/holiday days
  weekdayOTDays: number        // count of qualifying weekday OT days
  totalDays: number
  totalAmount: number          // THB
  totalRecords: number         // raw OT entries logged this month (any status)
  pendingRecords: number       // entries awaiting manager approval
  approvedRecords: number      // entries already signed off
}

export async function GET(request: NextRequest) {
  try {
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const month = searchParams.get('month') || currentMonthYYYYMM()
    const includeInactive = searchParams.get('includeInactive') === '1'

    const records = await prisma.oTRecord.findMany({ where: { month }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] })
    const users = await prisma.user.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ employeeId: 'asc' }, { createdAt: 'asc' }],
    })

    // Group records by (email, date) and run summarizeDay per group
    const dayMap = new Map<string, { email: string; date: string; recs: typeof records }>()
    for (const r of records) {
      const dateStr = r.date.toISOString().slice(0, 10)
      const key = `${r.userEmail.toLowerCase()}::${dateStr}`
      if (!dayMap.has(key)) dayMap.set(key, { email: r.userEmail.toLowerCase(), date: dateStr, recs: [] })
      dayMap.get(key)!.recs.push(r)
    }

    // Track raw record counts per user (independent of qualifying-day logic).
    // "totalRecords" includes both qualifying and non-qualifying entries so
    // the admin sees every record the user logged, not just paid days.
    const personRecordCounts = new Map<string, { total: number; pending: number; approved: number }>()
    for (const r of records) {
      const key = r.userEmail.toLowerCase()
      if (!personRecordCounts.has(key)) personRecordCounts.set(key, { total: 0, pending: 0, approved: 0 })
      const c = personRecordCounts.get(key)!
      c.total += 1
      if (r.approvalStatus === 'APPROVED') c.approved += 1
      else c.pending += 1
    }

    const personTotals = new Map<string, { wh: number; wd: number; amt: number }>()
    Array.from(dayMap.values()).forEach(g => {
      const summary = summarizeDay(
        g.date,
        g.recs.map(r => ({
          startTime: r.startTime || '',
          endTime: r.endTime || '',
          jobTask: r.jobTask,
          justification: r.justification,
        }))
      )
      if (!summary.qualifies) return
      const key = g.email
      if (!personTotals.has(key)) personTotals.set(key, { wh: 0, wd: 0, amt: 0 })
      const t = personTotals.get(key)!
      if (summary.dayType === 'WEEKDAY') t.wd += 1
      else t.wh += 1
      t.amt += summary.otAmountTHB
    })

    const summary: PersonSummary[] = users.map(u => {
      const t = personTotals.get(u.email.toLowerCase()) || { wh: 0, wd: 0, amt: 0 }
      const c = personRecordCounts.get(u.email.toLowerCase()) || { total: 0, pending: 0, approved: 0 }
      return {
        userId: u.id,
        email: u.email,
        thaiName: u.thaiName || '',
        employeeId: u.employeeId || '',
        position: u.position || '',
        role: u.role,
        active: u.active,
        weekendHolidayDays: t.wh,
        weekdayOTDays: t.wd,
        totalDays: t.wh + t.wd,
        totalAmount: t.amt,
        totalRecords: c.total,
        pendingRecords: c.pending,
        approvedRecords: c.approved,
      }
    })

    // Include orphan records (entries whose userEmail has no User row)
    const userEmails = new Set(users.map(u => u.email.toLowerCase()))
    Array.from(personTotals.entries()).forEach(([email, t]) => {
      if (!userEmails.has(email)) {
        const c = personRecordCounts.get(email) || { total: 0, pending: 0, approved: 0 }
        summary.push({
          userId: null,
          email,
          thaiName: '(unknown)',
          employeeId: '',
          position: '',
          role: 'USER',
          active: true,
          weekendHolidayDays: t.wh,
          weekdayOTDays: t.wd,
          totalDays: t.wh + t.wd,
          totalAmount: t.amt,
          totalRecords: c.total,
          pendingRecords: c.pending,
          approvedRecords: c.approved,
        })
      }
    })

    return NextResponse.json({ month, summary })
  } catch (e) {
    console.error('GET /api/ot/summary error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
