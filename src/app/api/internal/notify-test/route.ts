import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { notifyChatDetailed } from '@/lib/notify'

export const dynamic = 'force-dynamic'

/**
 * GET /api/internal/notify-test[?text=...&category=footage|ops]
 *
 * v1.209 — ยิงข้อความจริงออกทุกช่องแชท แล้วบอกว่าช่องไหน "ถึง" ช่องไหน "ไม่ถึง"
 *
 * ทำไมต้องมี: การตั้งค่า webhook ต้องเป็นจริง **สามชั้น** พร้อมกัน — ค่าอยู่ใน
 * stack env, ถูกประกาศใน service `environment:` ของ compose, และโผล่ใน
 * `Config.Env` ของคอนเทนเนอร์จริง (บทเรียน v1.202.2). อ่านไฟล์ compose อย่างเดียว
 * ไม่พิสูจน์อะไรเลย และ Lark ยัง**ตอบ 200 ทั้งที่ปฏิเสธข้อความ** ด้วย
 * ทางเดียวที่รู้แน่คือให้ตัวแอปเองส่งจริงแล้วดูว่าคนในห้องเห็นไหม
 *
 * `configured` บอกว่าแอปเห็นตัวแปรหรือเปล่า (ไม่เปิดเผยค่า — URL คือความลับ)
 */
async function isAllowed(request: NextRequest): Promise<boolean> {
  if (internalSecretAllowed(request, 'x-notify-test-secret',
    ['REMINDERS_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'])) return true
  const session = await getSession()
  return session?.role === 'ADMIN'
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category') === 'ops' ? 'ops' as const : 'footage' as const
  const text = (searchParams.get('text') || '').trim()
    || `🔔 ทดสอบการแจ้งเตือนจาก Production Booking (${category}) — ถ้าเห็นข้อความนี้แปลว่าช่องทางนี้ใช้ได้`

  const result = await notifyChatDetailed(text, category)
  return NextResponse.json({
    ok: result.any,
    sent: { discord: result.discord, lark: result.lark },
    configured: {
      discord: Boolean(process.env.DISCORD_WEBHOOK_URL?.trim()),
      lark: Boolean(process.env.LARK_WEBHOOK_URL?.trim()),
      larkSigned: Boolean(process.env.LARK_WEBHOOK_SECRET?.trim()),
    },
    scope: {
      discord: (process.env.DISCORD_NOTIFY_SCOPE || 'footage').trim().toLowerCase(),
      lark: (process.env.LARK_NOTIFY_SCOPE || 'all').trim().toLowerCase(),
    },
    category,
    // A false here with configured=true means the webhook was REJECTED, not
    // missing — check the container logs for "[notify] lark rejected (code N)".
    hint: result.any ? null : 'ไม่มีช่องไหนส่งได้ — ดู log ของ container',
  })
}
