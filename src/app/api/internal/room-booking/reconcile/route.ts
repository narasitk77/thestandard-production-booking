import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { recordHeartbeat } from '@/lib/heartbeat'
import { reconcileRoomBookings } from '@/lib/room-booking-reconcile'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/internal/room-booking/reconcile[?dryRun=1][&days=45][&max=8]
 *
 * v1.204 — ตัวที่ worker เรียกทุกรอบ: ทำให้การจองห้องในระบบกลางตรงกับคิวถ่าย
 * (ปลดห้องค้าง / ปลดห้องที่ย้ายไปแล้ว / จองใบที่ยังขาด)
 *
 * ต่างจาก `/run` ตรงที่ `/run` คือสั่งเจาะจงด้วยมือ ส่วนตัวนี้คือกวาดทั้งช่วงเวลา
 * เพื่อให้ระบบดูแลตัวเองได้โดยไม่ต้องมีคนจำว่ามีอะไรค้าง
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-room-booking-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

let running = false

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const sp = new URL(request.url).searchParams
  const dryRun = sp.get('dryRun') !== '0'
  const days = parseInt(sp.get('days') || '45', 10) || 45
  const max = parseInt(sp.get('max') || '8', 10) || 8

  // กันสองรอบซ้อน — ระบบปลายทางไม่มี idempotency สองรอบพร้อมกันคือความเสี่ยงที่ไม่คุ้ม
  if (!dryRun && running) {
    return NextResponse.json({ skipped: 'รอบก่อนยังทำงานอยู่' }, { status: 409 })
  }
  if (!dryRun) running = true
  try {
    const result = await reconcileRoomBookings({ dryRun, days, max })
    if (!dryRun) {
      recordHeartbeat('room-booking-reconcile',
        `ค้าง ${result.staleStuck.length} · ปลดแล้ว ${result.staleCancelled.length} · จองใหม่ ${result.booked.length}`,
      ).catch(() => {})
    }
    return NextResponse.json(result)
  } finally {
    if (!dryRun) running = false
  }
}
