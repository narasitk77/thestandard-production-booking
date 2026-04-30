import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { currentMonthYYYYMM } from '@/lib/ot-cleanup'
import { summarizeDay, formatTHB, RATE_WEEKDAY_OT_THB, RATE_WEEKEND_OR_HOLIDAY_THB, WEEKDAY_THRESHOLD_HOURS } from '@/lib/ot-calc'

const THAI_MONTHS = [
  'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
]

function csvCell(v: string | number) {
  return `"${String(v).replace(/"/g, '""')}"`
}

export async function GET(request: NextRequest) {
  try {
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const month = searchParams.get('month') || currentMonthYYYYMM()
    const detail = searchParams.get('detail') === '1'

    const [yyyy, mm] = month.split('-')
    const monthName = THAI_MONTHS[parseInt(mm) - 1] || mm

    const records = await prisma.oTRecord.findMany({
      where: { month },
      orderBy: [{ userEmail: 'asc' }, { date: 'asc' }, { startTime: 'asc' }],
    })
    const users = await prisma.user.findMany({
      where: { active: true },
      orderBy: [{ employeeId: 'asc' }, { createdAt: 'asc' }],
    })
    const userMap = new Map(users.map(u => [u.email.toLowerCase(), u]))

    if (detail) {
      const rows: string[] = []
      rows.push(['ลำดับ','ชื่อ-นามสกุล','รหัส','ตำแหน่ง','วันที่','เริ่ม','สิ้นสุด','งาน','เหตุผล','ประเภทวัน','ที่มา']
        .map(csvCell).join(','))
      records.forEach((r, i) => {
        const u = userMap.get(r.userEmail.toLowerCase())
        const dateStr = r.date.toISOString().slice(0, 10)
        const summary = summarizeDay(dateStr, [{
          startTime: r.startTime || '',
          endTime: r.endTime || '',
          jobTask: r.jobTask,
          justification: r.justification,
        }])
        rows.push([
          i + 1,
          u?.thaiName || r.userEmail,
          u?.employeeId || '',
          u?.position || '',
          dateStr,
          r.startTime || (r.type === 'HOLIDAY' ? '00:00' : ''),
          r.endTime || '',
          r.jobTask || r.description || '',
          r.justification || '',
          summary.dayLabel,
          r.bookingId ? 'Auto (Booking)' : 'Manual',
        ].map(csvCell).join(','))
      })
      const csv = '﻿' + rows.join('\n')
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="OT_detail_${month}.csv"`,
        },
      })
    }

    // ── Cover sheet (matches the Production OT form structure)
    // Aggregate by (email, date)
    const byPersonDay = new Map<string, Map<string, typeof records>>()
    for (const r of records) {
      const email = r.userEmail.toLowerCase()
      const dateStr = r.date.toISOString().slice(0, 10)
      if (!byPersonDay.has(email)) byPersonDay.set(email, new Map())
      const days = byPersonDay.get(email)!
      if (!days.has(dateStr)) days.set(dateStr, [])
      days.get(dateStr)!.push(r)
    }

    const personSummary = new Map<string, { wh: number; wd: number; amt: number }>()
    Array.from(byPersonDay.entries()).forEach(([email, days]) => {
      let wh = 0, wd = 0, amt = 0
      Array.from(days.entries()).forEach(([dateStr, recs]) => {
        const sum = summarizeDay(dateStr, recs.map(r => ({
          startTime: r.startTime || '',
          endTime: r.endTime || '',
          jobTask: r.jobTask,
          justification: r.justification,
        })))
        if (!sum.qualifies) return
        if (sum.dayType === 'WEEKDAY') wd += 1
        else wh += 1
        amt += sum.otAmountTHB
      })
      personSummary.set(email, { wh, wd, amt })
    })

    const rows: string[][] = []
    rows.push(['', '', '', '', '', '', '', ''])
    rows.push(['หน่วยงาน', 'Production', '', '', 'ผู้บังคับบัญชา', 'ชลธร จารุสุวรรณวงค์', '', ''])
    rows.push(['สรุปการขออนุมัติการทำงานวันหยุด', '', '', 'เดือน', monthName, yyyy, '', ''])
    rows.push([
      'ลำดับ', 'ชื่อ - นามสกุล', 'รหัสพนักงาน', 'ตำแหน่ง',
      `เสาร์-อาทิตย์/วันหยุด (วัน, ${RATE_WEEKEND_OR_HOLIDAY_THB} THB)`,
      `ทำงานเกิน ${WEEKDAY_THRESHOLD_HOURS} ชม. (วัน, ${RATE_WEEKDAY_OT_THB} THB)`,
      'รวม (THB)', 'หมายเหตุ',
    ])

    let i = 1
    let totalWH = 0, totalWD = 0, totalAmt = 0
    for (const u of users) {
      const email = u.email.toLowerCase()
      const s = personSummary.get(email) || { wh: 0, wd: 0, amt: 0 }
      rows.push([
        String(i++),
        u.thaiName || email,
        u.employeeId || '',
        u.position || '',
        String(s.wh),
        String(s.wd),
        String(s.amt),
        '',
      ])
      totalWH += s.wh; totalWD += s.wd; totalAmt += s.amt
    }

    // Orphan emails
    const userEmails = new Set(users.map(u => u.email.toLowerCase()))
    Array.from(personSummary.entries()).forEach(([email, s]) => {
      if (userEmails.has(email)) return
      rows.push([String(i++), email, '', '', String(s.wh), String(s.wd), String(s.amt), '(unknown user)'])
      totalWH += s.wh; totalWD += s.wd; totalAmt += s.amt
    })

    rows.push(['รวมจำนวนวัน', '', '', '', String(totalWH), String(totalWD), '', ''])
    rows.push(['รวมจำนวนเงิน (THB)', '', '', '', '', '', String(totalAmt), 'ห้ามแก้ตัวเลขเอง'])
    rows.push(['', '', '', '', '', '', '', ''])
    rows.push(['', 'ลายเซ็นผู้บังคับบัญชา', '', '', 'ลายเซ็นผู้มีอำนาจอนุมัติ', '', '', ''])

    const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\n')
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="OT_cover_${month}.csv"`,
      },
    })
  } catch (e) {
    console.error('GET /api/ot/export error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
