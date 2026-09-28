/**
 * v1.245 — GET /api/internal/mix-calendar/sync?dryRun=0 — ซิงก์งานมิกซ์ทั้งคิวเข้าปฏิทินมิกซ์แยก
 *
 * ใช้สามจังหวะ: (1) ตอนเปิดฟีเจอร์ครั้งแรก งานที่มีอยู่ก่อนยังไม่มี event (2) ทดสอบหลังตั้ง
 * MIX_CALENDAR_ID (3) ซ่อมหลังปฏิทินล่มแล้วงานค้าง calendarSyncError
 *
 * **ค่าเริ่มต้นคือ dry-run** — บอกแผนด้วย planMixCalendar ตัวเดียวกับของจริง ไม่มีการเรียก Google
 * (บทเรียนซ้ำ 3 ครั้ง: preview ที่เดินคนละทางกับของจริงคือ preview ที่โกหก)
 *
 * secret: x-reconcile-secret เหมือน worker อื่น (MIX_CALENDAR_SECRET ไม่มี — ไม่มีใครต้องหมุนแยก)
 */
import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { prisma } from '@/lib/db'
import { internalSecretAllowed } from '@/lib/internal-auth'
import { formatMixNumber, bangkokDateKey, addDaysKey } from '@/lib/mix-jobs'
import { planMixCalendar, mixCalendarTargetError, type MixCalendarJob } from '@/lib/mix-calendar-event'
import { bookingCalendarIds, getCalendarAuth } from '@/lib/google-calendar'
import { mixCalendarId, syncMixJobCalendar } from '@/lib/mix-calendar'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const LIMIT = 300

export async function GET(request: NextRequest) {
  // helper กลาง (timing-safe + ลอง fallback ครบทุกตัว) — ไม่เขียนเทียบ secret เองซ้ำ
  if (!internalSecretAllowed(request, 'x-reconcile-secret', ['NEXTAUTH_SECRET', 'AUTH_SECRET'])) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = new URL(request.url).searchParams.get('dryRun') !== '0'

  const calendarId = mixCalendarId()
  const target = mixCalendarTargetError(calendarId, bookingCalendarIds())
  if (target === 'off') return NextResponse.json({ ok: true, off: true, note: 'MIX_CALENDAR_ID ไม่ได้ตั้ง — ปฏิทินมิกซ์ปิดอยู่' })
  if (target) return NextResponse.json({ ok: false, error: target }, { status: 400 })

  // (1) งานที่ควรมี event ในช่วง -45..+180 วัน (2) แถวที่มี event แต่ไม่ควรมีแล้ว (ต้องลบ) (3) แถวที่ซิงก์ล้มค้าง
  // เรียงใหม่สุดก่อน: ถ้าชนเพดาน สิ่งที่หลุดคืองานเก่า ไม่ใช่งานใหม่ที่ยังไม่มี event (ผู้ตรวจเจอ + บั๊กเดิมที่ reconcile)
  const today = bangkokDateKey()
  const rows = await prisma.mixJob.findMany({
    where: {
      OR: [
        { deletedAt: null, dueDate: { gte: new Date(`${addDaysKey(today, -45)}T00:00:00Z`), lte: new Date(`${addDaysKey(today, 180)}T00:00:00Z`) } },
        { calendarEventId: { not: null }, OR: [{ deletedAt: { not: null } }, { status: 'CANCELLED' }, { dueDate: null }] },
        { deletedAt: null, calendarSyncError: { not: null } },
      ],
    },
    orderBy: { number: 'desc' },
    take: LIMIT,
  })

  const planned = rows.map(r => ({ id: r.id, code: formatMixNumber(r.number), plan: planMixCalendar(r as MixCalendarJob) }))
  const counts = { create: 0, update: 0, delete: 0, none: 0 }
  for (const p of planned) counts[p.plan]++

  // preflight แบบอ่านอย่างเดียว ทั้งสองโหมด: dry-run ที่ไม่แตะ Google จะบอก "ผ่าน" แม้สิทธิ์/credential/
  // staging guard จะทำให้รอบจริงล้มทุกแถว · และได้ชื่อปฏิทินจริงไว้ให้คนเทียบด้วยตาว่าเป็นปฏิทินมิกซ์
  let calendarSummary: string | null = null
  try {
    const cal = google.calendar({ version: 'v3', auth: getCalendarAuth() })
    calendarSummary = (await cal.calendars.get({ calendarId: calendarId! }, { timeout: 10_000 })).data.summary || null
  } catch (e: any) {
    return NextResponse.json({ ok: false, dryRun, calendarId, error: `preflight: ${String(e?.message || e).slice(0, 300)}`, counts, planned }, { status: 502 })
  }

  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun, calendarId, calendarSummary, counts, planned, truncated: rows.length === LIMIT })
  }

  const results = []
  for (const p of planned) {
    if (p.plan === 'none') continue
    const r = await syncMixJobCalendar(p.id)
    results.push({ code: p.code, plan: p.plan, ...(r.action === 'off' ? { action: 'off' } : r) })
  }
  const failed = results.filter(r => 'ok' in r && r.ok === false).length
  logAudit({
    actorEmail: 'mix-calendar-sync',
    action: 'mix.calendar_sync',
    entityType: 'MixJob',
    entityId: 'bulk',
    changes: { calendarId, counts, failed, results: results.slice(0, 50) },
  })
  return NextResponse.json({ ok: failed === 0, dryRun, calendarId, calendarSummary, counts, failed, results, truncated: rows.length === LIMIT })
}
