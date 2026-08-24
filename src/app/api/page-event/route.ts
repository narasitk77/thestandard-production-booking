/**
 * POST /api/page-event  { path }
 *
 * v1.190 — บันทึกการเปิดหน้า (เฉพาะหน้าที่อยู่ใน allowlist) เพื่อตอบคำถามว่า
 * ฟีเจอร์ที่ไม่มีใครใช้นั้น "ไม่รู้ว่ามี" หรือ "เข้าไปแล้วยอมแพ้"
 *
 * ตัวตนมาจาก session เท่านั้น — **ไม่เชื่อ email ที่ client ส่งมา** (client ส่งได้แค่ path)
 * และ path ถูก normalize + ตรวจ allowlist ซ้ำฝั่ง server เสมอ ต่อให้ client เพี้ยน
 * หรือมีคนยิงเองก็เขียนได้แค่ค่าที่เราอนุญาต
 *
 * ล้มเงียบโดยเจตนา: การเก็บสถิติต้องไม่ทำให้หน้าเว็บพัง — คืน 200 เสมอเมื่อมี session
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { normalizeTrackedPath, shouldRecordVisit, pageEventsEnabled } from '@/lib/page-events'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    if (!pageEventsEnabled()) return NextResponse.json({ ok: true, skipped: 'disabled' })
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const path = normalizeTrackedPath(body?.path)
    if (!path) return NextResponse.json({ ok: true, skipped: 'not-tracked' })

    const email = session.email.toLowerCase()
    // กันแถวเฟ้อจากการ refresh/re-render — นับเป็นการเข้าครั้งเดียวภายใน 30 นาที
    const last = await prisma.pageEvent.findFirst({
      where: { email, path },
      orderBy: { at: 'desc' },
      select: { at: true },
    })
    if (!shouldRecordVisit(last?.at, new Date())) {
      return NextResponse.json({ ok: true, skipped: 'same-visit' })
    }

    await prisma.pageEvent.create({ data: { email, path } })
    return NextResponse.json({ ok: true, recorded: true })
  } catch (e: any) {
    // สถิติพังต้องไม่ทำให้ผู้ใช้เห็น error — log ไว้แล้วปล่อยผ่าน
    console.error('POST /api/page-event error:', e?.message || e)
    return NextResponse.json({ ok: false }, { status: 200 })
  }
}
