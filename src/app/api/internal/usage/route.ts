/**
 * GET /api/internal/usage?month=YYYY-MM
 *
 * v1.190 — รายงานการใช้งานแบบอ่านอย่างเดียว สำหรับตอบคำถามที่ audit ตอบไม่ได้:
 * "ฟีเจอร์นี้ไม่มีใครใช้เพราะไม่รู้ว่ามี หรือเข้าไปแล้วยอมแพ้"
 *
 * สองส่วน:
 *   pages — คนเปิดหน้าไหนบ้างในเดือนนั้น (จาก PageEvent, ดู lib/page-events.ts)
 *   ot    — funnel ของ OT ทั้งเส้น: มีร่าง → เปิดหน้า → แก้ร่าง → กดส่ง → อนุมัติ
 *
 * ทำไมต้องมี funnel: 551 ใบที่ไม่มีใครส่ง แยกไม่ออกว่าติดตรงไหนถ้าดูแค่ปลายทาง
 * แต่ละขั้นที่หายไประหว่างทางบอกคนละเรื่องและแก้คนละแบบ
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'

export const dynamic = 'force-dynamic'

async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-usage-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

function monthRange(month: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const start = new Date(`${month}-01T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return { start, end }
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(request.url)
  const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7)
  const range = monthRange(month)
  if (!range) return NextResponse.json({ error: 'month ต้องเป็น YYYY-MM' }, { status: 400 })
  const { start, end } = range

  try {
    // ── การเปิดหน้า ────────────────────────────────────────────────
    const events = await prisma.pageEvent.findMany({
      where: { at: { gte: start, lt: end } },
      select: { path: true, email: true },
    })
    const byPath = new Map<string, { visits: number; people: Set<string> }>()
    for (const e of events) {
      const row = byPath.get(e.path) || { visits: 0, people: new Set<string>() }
      row.visits++
      row.people.add(e.email)
      byPath.set(e.path, row)
    }
    const pages = Array.from(byPath.entries())
      .map(([path, v]) => ({ path, visits: v.visits, people: v.people.size }))
      .sort((a, b) => b.visits - a.visits)

    // ── funnel ของ OT ─────────────────────────────────────────────
    const ot = await prisma.oTRecord.findMany({
      where: { month },
      select: {
        userEmail: true, createdAt: true, updatedAt: true,
        submittedAt: true, approvalStatus: true, approvedAt: true,
        hours: true, bookingId: true,
      },
    })
    const otPeople = new Set(ot.map(r => r.userEmail.toLowerCase()))
    const openedOt = new Set(
      events.filter(e => e.path === '/ot').map(e => e.email.toLowerCase()),
    )
    // "แก้ร่าง" = แถวถูกเขียนทับหลังสร้าง (เผื่อ 5 วิ กัน timestamp ชนกันตอน create)
    const edited = ot.filter(r => r.updatedAt.getTime() > r.createdAt.getTime() + 5000)
    const submitted = ot.filter(r => r.submittedAt !== null)
    const approved = ot.filter(r => r.approvalStatus === 'APPROVED')
    const rejected = ot.filter(r => r.approvalStatus === 'REJECTED')

    const peopleOf = (rows: typeof ot) => new Set(rows.map(r => r.userEmail.toLowerCase())).size

    // รายคน — เพื่อไล่ตามได้จริงว่าใครติดตรงไหน
    const perPerson = Array.from(otPeople).map(email => {
      const mine = ot.filter(r => r.userEmail.toLowerCase() === email)
      return {
        email,
        drafts: mine.length,
        openedPage: openedOt.has(email),
        edited: mine.filter(r => r.updatedAt.getTime() > r.createdAt.getTime() + 5000).length,
        submitted: mine.filter(r => r.submittedAt !== null).length,
        approved: mine.filter(r => r.approvalStatus === 'APPROVED').length,
        hours: Math.round(mine.reduce((s, r) => s + (r.hours || 0), 0) * 10) / 10,
      }
    }).sort((a, b) => b.drafts - a.drafts)

    return NextResponse.json({
      month,
      pages,
      ot: {
        // แต่ละขั้นนับเป็น "จำนวนคน" เพราะคำถามคือคนติดตรงไหน ไม่ใช่ใบติดตรงไหน
        funnel: {
          hasDraft: otPeople.size,
          openedPage: Array.from(otPeople).filter(e => openedOt.has(e)).length,
          edited: peopleOf(edited),
          submitted: peopleOf(submitted),
          approved: peopleOf(approved),
        },
        records: {
          total: ot.length,
          auto: ot.filter(r => r.bookingId !== null).length,
          manual: ot.filter(r => r.bookingId === null).length,
          edited: edited.length,
          submitted: submitted.length,
          approved: approved.length,
          rejected: rejected.length,
          hoursApproved: Math.round(approved.reduce((s, r) => s + (r.hours || 0), 0) * 10) / 10,
        },
        // คนที่เปิดหน้า /ot แต่ไม่มีร่างเลย — สนใจแต่ไม่มีอะไรให้ทำ (หรือหาไม่เจอ)
        openedButNoDraft: Array.from(openedOt).filter(e => !otPeople.has(e)),
        perPerson,
      },
      note: 'pages นับจาก PageEvent ซึ่งเริ่มเก็บ v1.190 — เดือนก่อนหน้านั้นจะว่างเสมอ ไม่ใช่ว่าไม่มีคนเข้า',
    })
  } catch (e: any) {
    console.error('GET /api/internal/usage error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
