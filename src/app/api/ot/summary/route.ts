import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { TEAM_PROFILES } from '@/lib/team-profiles'
import { currentMonthYYYYMM } from '@/lib/ot-cleanup'

interface PersonSummary {
  email: string
  thaiName: string
  employeeId: string
  position: string
  holidayDays: number
  otHours: number
  notes: string
}

export async function GET(request: NextRequest) {
  try {
    if (!(await requireAdmin())) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const month = searchParams.get('month') || currentMonthYYYYMM()

    const records = await prisma.oTRecord.findMany({ where: { month } })
    const users = await prisma.user.findMany()
    const userMap = new Map(users.map(u => [u.email.toLowerCase(), u]))

    // Aggregate per email
    const map = new Map<string, PersonSummary>()
    for (const profile of TEAM_PROFILES) {
      const email = profile.email.toLowerCase()
      const user = userMap.get(email)
      map.set(email, {
        email,
        thaiName: user?.thaiName || profile.thaiName,
        employeeId: user?.employeeId || profile.employeeId,
        position: user?.position || profile.position,
        holidayDays: 0,
        otHours: 0,
        notes: '',
      })
    }
    for (const r of records) {
      const email = r.userEmail.toLowerCase()
      let s = map.get(email)
      if (!s) {
        const user = userMap.get(email)
        s = {
          email,
          thaiName: user?.thaiName || email,
          employeeId: user?.employeeId || '',
          position: user?.position || '',
          holidayDays: 0, otHours: 0, notes: '',
        }
        map.set(email, s)
      }
      if (r.type === 'HOLIDAY') s.holidayDays += 1
      if (r.type === 'OVERTIME') s.otHours += r.hours
    }

    const summary = Array.from(map.values())
    summary.sort((a, b) => a.employeeId.localeCompare(b.employeeId))

    return NextResponse.json({ month, summary })
  } catch (e) {
    console.error('GET /api/ot/summary error:', e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
