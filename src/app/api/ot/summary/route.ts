import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireOTApprover } from '@/lib/session'
import { currentMonthYYYYMM } from '@/lib/ot-cleanup'
import { summarizeDay, dateOffsetDays } from '@/lib/ot-calc'

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
  draftRecords: number         // user still editing — not in approval queue
  submittedRecords: number     // user signed; awaiting manager approval
  approvedRecords: number      // manager signed off
  rejectedRecords: number      // pushed back to user; awaiting their edit + resubmit
  // Legacy alias for v1.32.x clients still polling this endpoint. Counts
  // SUBMITTED + REJECTED — anything that's "in flight, not yet approved".
  // Safe to remove once all clients are on the new field names.
  pendingRecords: number
  // ids of the SUBMITTED rows counted above — /ot/admin approves exactly these
  // (what the approver saw), never "whatever is SUBMITTED at click time".
  submittedRecordIds: string[]
}

export async function GET(request: NextRequest) {
  try {
    if (!(await requireOTApprover())) {
      return NextResponse.json({ error: 'OT approver only' }, { status: 403 })
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

    // Track raw record counts per user broken down by status (independent of
    // qualifying-day logic). "totalRecords" includes both qualifying and
    // non-qualifying entries so the admin sees every record the user logged,
    // not just paid days.
    type StatusCounts = { total: number; draft: number; submitted: number; approved: number; rejected: number; submittedIds: string[] }
    const emptyCounts = (): StatusCounts => ({ total: 0, draft: 0, submitted: 0, approved: 0, rejected: 0, submittedIds: [] })
    const personRecordCounts = new Map<string, StatusCounts>()
    for (const r of records) {
      const key = r.userEmail.toLowerCase()
      if (!personRecordCounts.has(key)) personRecordCounts.set(key, emptyCounts())
      const c = personRecordCounts.get(key)!
      c.total += 1
      switch (r.approvalStatus) {
        case 'DRAFT':     c.draft += 1; break
        case 'SUBMITTED': c.submitted += 1; c.submittedIds.push(r.id); break
        case 'APPROVED':  c.approved += 1; break
        case 'REJECTED':  c.rejected += 1; break
      }
    }

    const personTotals = new Map<string, { wh: number; wd: number; amt: number }>()
    Array.from(dayMap.values()).forEach(g => {
      const summary = summarizeDay(
        g.date,
        g.recs.map(r => ({
          startTime: r.startTime || '',
          endTime: r.endTime || '',
          endOffsetDays: dateOffsetDays(g.date, r.endDate ? r.endDate.toISOString() : null),
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
      const c = personRecordCounts.get(u.email.toLowerCase()) || emptyCounts()
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
        draftRecords: c.draft,
        submittedRecords: c.submitted,
        approvedRecords: c.approved,
        rejectedRecords: c.rejected,
        pendingRecords: c.submitted + c.rejected,
        submittedRecordIds: c.submittedIds,
      }
    })

    // Include orphan records (entries whose userEmail has no User row — or whose
    // user is disabled while includeInactive is off). Qualifying days as before,
    // PLUS anyone with a SUBMITTED row: those used to be listed nowhere, so the
    // approver could never see them, and "อนุมัติทุกคน" approved them unseen
    // (maintenance 2026-11-08 — the page now approves only the ids it shows).
    const userEmails = new Set(users.map(u => u.email.toLowerCase()))
    const orphanEmails = new Set([
      ...Array.from(personTotals.keys()),
      ...Array.from(personRecordCounts.entries()).filter(([, c]) => c.submitted > 0).map(([e]) => e),
    ])
    Array.from(orphanEmails).forEach(email => {
      if (!userEmails.has(email)) {
        const t = personTotals.get(email) || { wh: 0, wd: 0, amt: 0 }
        const c = personRecordCounts.get(email) || emptyCounts()
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
          draftRecords: c.draft,
          submittedRecords: c.submitted,
          approvedRecords: c.approved,
          rejectedRecords: c.rejected,
          pendingRecords: c.submitted + c.rejected,
          submittedRecordIds: c.submittedIds,
        })
      }
    })

    return NextResponse.json({ month, summary })
  } catch (e) {
    console.error('GET /api/ot/summary error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
