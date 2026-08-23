/**
 * v1.187 — ส่งเมลเตือน Producer ให้กลับมาใส่เลข QU จริง (ฝั่งที่แตะ DB + เมล)
 *
 * ตรรกะจังหวะ/ข้อความอยู่ใน qu-reminder.ts (ฟังก์ชันบริสุทธิ์ + เทส) ที่นี่ทำแค่
 * อ่านของที่ค้าง → จัดกลุ่มตาม Producer → ส่ง → ประทับเวลา → บันทึกผล **ที่เกิดจริง**
 *
 * บันทึกผลจริงเป็นเรื่องคอขาดบาดตายในรีโปนี้: v1.186 เพิ่งเจอว่า audit อ้างว่า
 * operator ได้รับเมลแจ้งฟุตเทจ 85/85 ครั้งเพราะโค้ดทิ้งค่าที่ sendEmail คืนมา
 * ที่นี่จึงประทับ quRemindedAt **เฉพาะคนที่เมลส่งผ่านจริง** — คนที่ส่งไม่ผ่านจะถูก
 * หยิบมาลองใหม่รอบหน้า ไม่ใช่ถูกทำเครื่องหมายว่าเตือนแล้วทั้งที่ไม่มีใครได้อ่าน
 */
import { prisma } from './db'
import { sendEmail, isEmailConfigured } from './email'
import { logAudit } from './audit'
import { notifyDiscord } from './notify'
import {
  needsRealQuRef, groupByProducer, producerDue, buildQuReminderEmail,
  type QuPendingBooking,
} from './qu-reminder'

export interface QuReminderResult {
  pending: number            // ใบที่ยังไม่มีเลข QU จริง (ทั้งหมด)
  noProducerEmail: string[]  // ใบที่เตือนไม่ได้เพราะไม่มีอีเมล — ต้องมีคนตามเอง
  producersDue: number
  emailed: number            // จำนวน Producer ที่เมลส่งผ่านจริง
  failed: number
  skipped: boolean           // ปิดสวิตช์ / เมลไม่พร้อม
  /** dry-run เท่านั้น: ใครจะได้รับอะไรบ้าง — พรีวิวก่อนส่งจริง */
  preview?: Array<{ to: string; subject: string; bookingCodes: (string | null)[] }>
}

export function quReminderEnabled(): boolean {
  return process.env.QU_REMINDER_ENABLED?.trim() !== '0'
}

/**
 * งานที่ต้องตามเลข QU: **AGN + ADVERTORIAL** (ขอบเขตเดียวกับกฏ QU ตอนจอง v1.161)
 * ไม่รวมงานที่ยกเลิก/ถูกลบ — เลิกทำแล้วไม่ต้องตั้งเบิก
 * รวมงานที่ถ่ายจบไปแล้ว: เลขนี้ใช้ตั้งเบิก ถ่ายเสร็จแล้วก็ยังต้องได้
 */
export async function findBookingsMissingQuRef(): Promise<QuPendingBooking[]> {
  const rows = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { not: 'CANCELLED' },
      category: 'ADVERTORIAL',
      outlet: { code: 'AGN' },
    },
    select: {
      bookingCode: true, agencyRef: true, shootDate: true, status: true,
      producer: true, producerEmail: true, quRemindedAt: true, projectName: true, id: true,
    },
    orderBy: { shootDate: 'asc' },
  })
  return (rows as QuPendingBooking[]).filter((r: QuPendingBooking) => needsRealQuRef(r.agencyRef))
}

export async function runQuReminderSweep(opts: { dryRun?: boolean } = {}): Promise<QuReminderResult> {
  const empty: QuReminderResult = { pending: 0, noProducerEmail: [], producersDue: 0, emailed: 0, failed: 0, skipped: true }
  if (!quReminderEnabled()) return empty

  const rows = await findBookingsMissingQuRef()
  const noProducerEmail = rows
    .filter(r => !(r.producerEmail || '').includes('@'))
    .map(r => r.bookingCode || '(ไม่มีรหัส)')

  if (!isEmailConfigured()) {
    return { ...empty, pending: rows.length, noProducerEmail }
  }

  const now = new Date()
  const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://probook.xtec9.xyz'
  const byProducer = groupByProducer(rows)

  let producersDue = 0
  let emailed = 0
  let failed = 0
  const preview: NonNullable<QuReminderResult['preview']> = []

  // Array.from: tsconfig target ของโปรเจกต์นี้ต่ำกว่า es2015 จึงวน Map ตรง ๆ ไม่ได้
  for (const [email, list] of Array.from(byProducer.entries())) {
    if (!producerDue(list, now)) continue
    producersDue++
    const { subject, text } = buildQuReminderEmail(list, now, appUrl)
    if (opts.dryRun) {
      preview.push({ to: email, subject, bookingCodes: list.map((r: QuPendingBooking) => r.bookingCode) })
      continue
    }

    let ok = false
    let error: string | null = null
    try {
      await sendEmail({ to: [email], subject, text })
      ok = true
    } catch (e: any) {
      error = e?.message || String(e)
    }

    if (ok) {
      emailed++
      // ประทับเฉพาะตอนส่งผ่าน — ส่งไม่ผ่าน = รอบหน้าลองใหม่
      await prisma.booking.updateMany({
        where: { bookingCode: { in: list.map((r: QuPendingBooking) => r.bookingCode).filter((c): c is string => !!c) } },
        data: { quRemindedAt: now },
      })
    } else {
      failed++
    }

    logAudit({
      actorEmail: 'qu-reminder-worker',
      action: 'booking.qu_reminder_sent',
      entityType: 'Booking',
      entityId: 'bulk',
      changes: {
        producerEmail: email,
        bookingCodes: list.map((r: QuPendingBooking) => r.bookingCode),
        // ผลจริง ไม่ใช่เจตนา (บทเรียน v1.186)
        emailOk: ok,
        emailError: error,
      },
    })
  }

  if (!opts.dryRun && (emailed > 0 || failed > 0)) {
    await notifyDiscord(
      `📮 เตือนเลข QU: ส่งถึง Producer ${emailed} คน` +
      (failed ? ` · ส่งไม่ผ่าน ${failed}` : '') +
      ` · ค้างทั้งหมด ${rows.length} ใบ` +
      (noProducerEmail.length ? ` · ไม่มีอีเมล ${noProducerEmail.length} ใบ (${noProducerEmail.join(', ')})` : ''),
      'ops',
    )
  }

  return {
    pending: rows.length, noProducerEmail, producersDue, emailed, failed, skipped: false,
    ...(opts.dryRun ? { preview } : {}),
  }
}
