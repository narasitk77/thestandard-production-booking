/**
 * v1.162 — POST /api/admin/delivery-tick
 * รัน backfill/sweep ติ๊ก "ส่งงานแล้ว" ลงชีท footage log ของทีม content
 * body: { apply?: boolean } — default dry-run (รายงานแถวที่จะติ๊ก ไม่เขียน)
 * ยิงซ้ำได้ปลอดภัย: แถวที่มีติ๊กอยู่แล้ว (คนติ๊กมือ/รอบก่อน) จะไม่ถูกทับ
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { runDeliveryTick } from '@/lib/delivery-tick'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session || session.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let apply = false
  try { apply = !!(await request.json())?.apply } catch { /* body ว่าง = dry-run */ }
  try {
    const result = await runDeliveryTick({ apply })
    return NextResponse.json({ apply, ...result })
  } catch (e: any) {
    // 403 จาก Sheets = ชีทยังไม่แชร์ให้ SA — บอกให้ชัดว่าต้องแชร์ให้ใคร
    const msg = e?.message || String(e)
    const hint = /403|permission/i.test(msg)
      ? `ชีทยังไม่ได้แชร์ Editor ให้ ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || 'service account'}`
      : undefined
    return NextResponse.json({ error: msg, hint }, { status: 500 })
  }
}
