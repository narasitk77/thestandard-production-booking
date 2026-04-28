import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { TEAM_PROFILES } from '@/lib/team-profiles'
import { currentMonthYYYYMM } from '@/lib/ot-cleanup'

const THAI_MONTHS = [
  'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
]

// Match the exact CSV layout of "Copy of 🟢13. [Production] เเบบฟอร์มค่าทำงานวันหยุดและค่าทำงานล่วงเวลา - ใบปะหน้า"
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

    const records = await prisma.oTRecord.findMany({ where: { month }, orderBy: [{ userEmail: 'asc' }, { date: 'asc' }] })
    const users = await prisma.user.findMany()
    const userMap = new Map(users.map(u => [u.email.toLowerCase(), u]))

    if (detail) {
      // Detailed CSV — every record listed
      const rows: string[] = []
      rows.push(['ลำดับ','ชื่อ - นามสกุล','รหัสพนักงาน','ตำแหน่ง','วันที่','ประเภท','ชั่วโมง','รายละเอียด'].map(csvCell).join(','))
      records.forEach((r, i) => {
        const u = userMap.get(r.userEmail.toLowerCase())
        const profile = TEAM_PROFILES.find(p => p.email.toLowerCase() === r.userEmail.toLowerCase())
        const typeThai = r.type === 'HOLIDAY' ? 'เสาร์-อาทิตย์/วันหยุด' : 'ทำงานล่วงเวลา (>8 ชม.)'
        rows.push([
          i + 1,
          u?.thaiName || profile?.thaiName || r.userEmail,
          u?.employeeId || profile?.employeeId || '',
          u?.position || profile?.position || '',
          new Date(r.date).toISOString().slice(0, 10),
          typeThai,
          r.type === 'OVERTIME' ? r.hours : 1,
          r.description || '',
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

    // Cover-sheet style aggregated CSV (matches user's existing form)
    const summary = new Map<string, { holidayDays: number; otHours: number }>()
    for (const r of records) {
      const k = r.userEmail.toLowerCase()
      if (!summary.has(k)) summary.set(k, { holidayDays: 0, otHours: 0 })
      const s = summary.get(k)!
      if (r.type === 'HOLIDAY') s.holidayDays += 1
      if (r.type === 'OVERTIME') s.otHours += r.hours
    }

    const rows: string[][] = []
    rows.push(['', '', '', '', '', '', '', ''])
    rows.push(['หน่วยงาน', 'Production', '', '', 'ผู้บังคับบัญชา', 'ชลธร จารุสุวรรณวงค์', '', ''])
    rows.push(['สรุปการขออนุมัติการทำงานวันหยุด', '', '', 'เดือน', monthName, yyyy, '', ''])
    rows.push(['ลำดับ', 'ชื่อ - นามสกุล', 'รหัสพนักงาน', 'ตำแหน่ง', 'จำนวน', '', 'หมายเหตุ', ''])
    rows.push(['', '', '', '', 'เสาร์ - อาทิตย์ / วันหยุดตามประกาศบริษัท', 'ค่าทำงานล่วงเวลา (ทำงานเกิน 8 ชั่วโมง)', '', ''])

    let i = 1
    let totalHoliday = 0
    let totalOT = 0
    for (const profile of TEAM_PROFILES) {
      const email = profile.email.toLowerCase()
      const u = userMap.get(email)
      const s = summary.get(email) || { holidayDays: 0, otHours: 0 }
      // Skip people with zero this month UNLESS they're in the user table (i.e. relevant)
      if (s.holidayDays === 0 && s.otHours === 0 && !u) continue
      rows.push([
        String(i++),
        u?.thaiName || profile.thaiName,
        u?.employeeId || profile.employeeId,
        u?.position || profile.position,
        String(s.holidayDays),
        String(s.otHours),
        '',
        '',
      ])
      totalHoliday += s.holidayDays
      totalOT += s.otHours
    }
    // Also include any non-team-profile users with records
    Array.from(summary.entries()).forEach(([email, s]) => {
      if (TEAM_PROFILES.find(p => p.email.toLowerCase() === email)) return
      const u = userMap.get(email)
      rows.push([
        String(i++),
        u?.thaiName || email,
        u?.employeeId || '',
        u?.position || '',
        String(s.holidayDays),
        String(s.otHours),
        '',
        '',
      ])
      totalHoliday += s.holidayDays
      totalOT += s.otHours
    })

    rows.push(['รวมจำนวนวันทำงาน', '', '', '', String(totalHoliday), String(totalOT), '', ''])
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
