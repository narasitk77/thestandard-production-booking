/**
 * POST /api/admin/backfill-coproducer-emails[?apply=1]
 *
 * v1.185 — เติม `Booking.coProducerEmail` ให้ใบเก่าจากชื่อเล่นใน `Booking.coProducer`
 *
 * WHY. คอลัมน์ `coProducerEmail` มีในสคีมามาตั้งแต่ v1.59 แต่**ไม่เคยถูกเขียนเลย**
 * (ฟอร์มคำนวณค่าไว้แล้วไม่ส่ง, create ก็ destructure ทิ้ง — แก้ที่ v1.183) ผลคือ
 * คิวรู้แค่ชื่อเล่นของ Co-Producer ตามตัวคนไม่ได้ → v1.185 ที่เพิ่ม Co-Producer เข้า
 * ลิสต์แขกปฏิทินจะไม่มีผลกับใบเก่าเลยถ้าไม่เติมอีเมลย้อนหลังให้ก่อน
 *
 * การจับคู่ตั้งใจให้แคบ: ชื่อเล่นตรงกัน (ตัดช่องว่าง ไม่สนตัวพิมพ์) **และ** คนนั้น
 * ต้องถูกแท็กเป็น producer ของ outlet เดียวกันกับ booking ใบนั้น ถ้าเจอ 0 คนหรือ
 * มากกว่า 1 คน → ข้ามและรายงาน ไม่เดา (เขียนอีเมลผิดคนลงคิวแล้ว invite ผิดคน
 * แย่กว่าปล่อยว่างไว้)
 *
 * dry-run เป็นค่าเริ่มต้น ต้องใส่ ?apply=1 ถึงจะเขียน
 *
 * หมายเหตุ: รอบแรกบนพรอด (2026-08-21) รันด้วย SQL ตรง ๆ ไป 21 แถวแล้วเพราะตอนนั้น
 * deploy ไม่ได้ — endpoint นี้จึงเจอ 0 แถวเป็นเรื่องปกติ เก็บไว้ให้รันซ้ำได้ในอนาคต
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { logAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

interface Row {
  bookingCode: string | null
  outlet: string
  coProducer: string
  matched: string | null
  reason?: 'no-match' | 'ambiguous'
  candidates?: number
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireAdmin()
    if (!session) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    const apply = new URL(request.url).searchParams.get('apply') === '1'

    const bookings = await prisma.booking.findMany({
      where: {
        deletedAt: null,
        coProducerEmail: null,
        coProducer: { not: null },
      },
      select: { id: true, bookingCode: true, coProducer: true, outlet: { select: { code: true } } },
      orderBy: { createdAt: 'desc' },
    })

    // ชื่อเล่น → อีเมล ต่อ outlet (เฉพาะคน active ที่ถูกแท็กเป็น producer ของ outlet นั้น)
    const people = await prisma.user.findMany({
      where: { active: true, nickname: { not: null }, producerOutlets: { isEmpty: false } },
      select: { email: true, nickname: true, producerOutlets: true },
    })
    const byOutletNick = new Map<string, string[]>()
    for (const p of people) {
      const nick = (p.nickname || '').trim().toLowerCase()
      if (!nick) continue
      for (const code of p.producerOutlets) {
        const key = `${code.toUpperCase()}|${nick}`
        byOutletNick.set(key, [...(byOutletNick.get(key) || []), p.email])
      }
    }

    const rows: Row[] = []
    const updates: { id: string; email: string }[] = []
    for (const b of bookings) {
      const nick = (b.coProducer || '').trim()
      if (!nick) continue
      const key = `${b.outlet.code.toUpperCase()}|${nick.toLowerCase()}`
      const hits = byOutletNick.get(key) || []
      if (hits.length === 1) {
        rows.push({ bookingCode: b.bookingCode, outlet: b.outlet.code, coProducer: nick, matched: hits[0] })
        updates.push({ id: b.id, email: hits[0] })
      } else {
        rows.push({
          bookingCode: b.bookingCode, outlet: b.outlet.code, coProducer: nick, matched: null,
          reason: hits.length === 0 ? 'no-match' : 'ambiguous', candidates: hits.length,
        })
      }
    }

    let updated = 0
    if (apply) {
      for (const u of updates) {
        await prisma.booking.update({ where: { id: u.id }, data: { coProducerEmail: u.email } })
        updated++
      }
      logAudit({
        actorEmail: session.email,
        action: 'booking.backfill_coproducer_email',
        entityType: 'Booking',
        entityId: 'bulk',
        changes: { scanned: bookings.length, updated, skipped: rows.length - updates.length },
      })
    }

    return NextResponse.json({
      ok: true,
      apply,
      scanned: bookings.length,
      wouldUpdate: updates.length,
      updated,
      skipped: rows.filter(r => !r.matched),
      rows,
    })
  } catch (e: any) {
    console.error('POST /api/admin/backfill-coproducer-emails error:', e)
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 })
  }
}
