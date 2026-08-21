/**
 * v1.184 — กระดิ่งแจ้งเตือน
 *
 *   GET  /api/notifications        → { items, unread, seenAt, scopes }
 *   POST /api/notifications        → { seenAt }  (บันทึกว่าเปิดดูแล้ว)
 *
 * ทุกคนที่ล็อกอินเรียกได้ — ขอบเขตว่าจะได้อะไรตัดสินฝั่ง server ใน
 * buildNotificationFeed() ไม่ใช่ที่ client (client แค่วาดของที่ได้มา)
 */
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { buildNotificationFeed, markNotificationsSeen } from '@/lib/notifications'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const feed = await buildNotificationFeed(session)
    return NextResponse.json(feed)
  } catch (e: any) {
    console.error('GET /api/notifications error:', e)
    // กระดิ่งพังต้องไม่ทำให้ nav พัง — client ตีความ items ว่างเป็น "ไม่มีอะไร"
    // แต่ error ต้องไม่เงียบ: ส่ง 500 + ให้ client โชว์ว่าโหลดไม่ได้
    return NextResponse.json({ error: 'Failed to load notifications' }, { status: 500 })
  }
}

export async function POST() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const seenAt = await markNotificationsSeen(session.email)
    return NextResponse.json({ seenAt })
  } catch (e: any) {
    console.error('POST /api/notifications error:', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
