/**
 * อุปกรณ์ / ของเช่า ราย **Production ID**
 *
 * v1.197 — operator 2026-08-25: *"อยากเพิ่มฟีเจอร์ ให้แยกตามเลข Production ID
 * ดูงาน แล้วใส่อุปกรณ์ตามไอดี เพราะมันจะแยกตามคนอีกที แล้วพวกช่างภาพจะตอบผ่าน
 * บอท Norbert ของปุ๊ก"*
 *
 * เดิมอุปกรณ์เก็บที่ **ใบจอง** (`Booking.equipmentNote` / `rentalGearNote`) ซึ่ง
 * ใบหนึ่งมีได้หลาย Production ID (ของจริง: 420 ใบมี ID เดียว · **65 ใบมีหลาย ID**)
 * จึงระบุไม่ได้ว่าอุปกรณ์ชิ้นไหนของ ID ไหน
 *
 * **ตัวจริงคือ `Episode.equipmentNote` / `Episode.rentalGearNote`** ส่วนช่องที่
 * ใบจองเป็น "สรุปที่คำนวณมา" เก็บไว้เพื่อให้ 7 จุดที่อ่านของเดิมทำงานต่อได้โดย
 * ไม่ต้องแก้ (คำอธิบายอีเวนต์ปฏิทิน, calendar-reconcile, หน้า booking,
 * BookingDrawer, workspace export, planning export, หน้าเช่า) — เขียนใหม่ทุกครั้ง
 * ที่บันทึกราย ID ในทรานแซกชันเดียวกัน ไม่มีใครเขียนมันตรง ๆ
 */

export interface EpisodeGear {
  episodeId: string
  equipmentNote?: string | null
  rentalGearNote?: string | null
}

export type GearField = 'equipmentNote' | 'rentalGearNote'

function clean(v: string | null | undefined): string {
  return (v || '').trim()
}

/**
 * รวมโน้ตราย ID → ข้อความสรุประดับใบจอง
 *
 *  - ไม่มีใครกรอก → null (เหมือนเดิมทุกประการ)
 *  - **ทุก ID ข้อความเหมือนกัน → คืนข้อความเดียว ไม่ต้องมีคำนำหน้า** — ครอบคลุมทั้ง
 *    ใบที่มี ID เดียว (84% ของงาน หน้าตาไม่เปลี่ยนเลย) และใบที่ใช้อุปกรณ์ชุดเดียว
 *    ทั้งกอง ซึ่งการเขียนซ้ำทุก ID มีแต่ทำให้ปฏิทินรก
 *  - ต่างกัน → `EP-ID: ข้อความ` บรรทัดละ ID (เฉพาะ ID ที่กรอก)
 */
export function summarizeGearNotes(eps: EpisodeGear[], field: GearField): string | null {
  const filled = eps
    .map(e => ({ id: clean(e.episodeId), text: clean(e[field]) }))
    .filter(e => e.text !== '')
  if (filled.length === 0) return null

  const distinct = Array.from(new Set(filled.map(e => e.text)))
  if (distinct.length === 1 && filled.length === eps.length) return distinct[0]
  if (filled.length === 1) return filled[0].text

  return filled.map(e => `${e.id}: ${e.text}`).join('\n')
}

/**
 * แถวหนึ่งของข้อความที่ส่งให้บอท Norbert — **หนึ่งแถว = หนึ่งกอง (หนึ่งอีเวนต์ปฏิทิน)**
 *
 * v1.198 — operator 2026-08-25: *"ถ้ามี 2 ไอดีในงานเดียว ให้รวมกัน · 1 calendar
 * 2 id เขาจะเบิกชุดเดียวกัน แต่ใช้ต่อเนื่อง อาจจะโชว์ ID คู่กันไปเลย"* —
 * การเบิกอุปกรณ์เกิดต่อกอง ไม่ใช่ต่อ Production ID จึงรวมเป็นบล็อกเดียวแล้วลิสต์
 * ID ทุกตัวที่ชุดอุปกรณ์นั้นครอบคลุม (ลิสต์เต็มเสมอ ไม่ย่อ — บอทต้องจับคู่ ID ได้)
 */
export interface GearExportRow {
  productionIds: string[]
  /** ชื่อรายการ/ตอน เพื่อให้คนอ่านรู้ว่าใบไหน */
  title?: string | null
  /** "08:00 → 18:00" */
  time?: string | null
  crew?: string[]
  equipment?: string | null
  rental?: string | null
}

const DASH = '—'

/**
 * ลิสต์ Production ID ของกองเดียวกัน — เต็มทุกตัว คั่นด้วย " + "
 * ไม่ย่อ prefix ร่วม เพราะปลายทางเป็นบอทที่ต้องจับคู่เลข ID ตรง ๆ
 */
export function formatProductionIds(ids: string[]): string {
  const seen = ids.map(s => (s || '').trim()).filter(Boolean)
  return Array.from(new Set(seen)).join(' + ')
}

/**
 * ข้อความสำหรับวางในบอท — **หนึ่งกองต่อหนึ่งบล็อก**
 *
 * Norbert เป็นคนแยกต่อเป็นรายคนเอง (operator ยืนยัน 2026-08-25) ฝั่งเราจึงส่ง
 * ID + อุปกรณ์ + รายชื่อครูไปให้ครบ แล้วไม่ต้องเดาว่าใครถืออะไร
 *
 * **ไม่ส่งช่อง "เช่า" ไปด้วย** (operator 2026-08-25: "ตอนส่งให้ช่างภาพเอาอันนี้ออก")
 * — ของเช่าเป็นเรื่องจัดซื้อ/ประสานงาน ไม่ใช่สิ่งที่ช่างภาพต้องยืนยัน ช่องนี้ยัง
 * กรอกและดูได้ตามปกติในหน้า Week Plan และยังขึ้นในปฏิทิน/หน้า Booking เหมือนเดิม
 *
 * อุปกรณ์ขึ้นเสมอแม้ว่าง — "—" อ่านว่า "ยังไม่มีใครกรอก" ซึ่งเป็นสิ่งที่ operator ตามอยู่
 */
export function buildGearExportText(input: {
  heading: string
  rows: GearExportRow[]
  filledOnly?: boolean
}): string {
  // filledOnly อิง "อุปกรณ์" อย่างเดียว เพราะเช่าไม่ได้ถูกส่งไป — ถ้าเอาเช่ามานับด้วย
  // กองที่กรอกแต่เช่าจะโผล่ในข้อความโดยมี "อุปกรณ์: —" ซึ่งอ่านแล้วงง
  const rows = input.filledOnly
    ? input.rows.filter(r => clean(r.equipment))
    : input.rows
  const out: string[] = [input.heading, '']
  if (rows.length === 0) {
    out.push(input.filledOnly ? '(ยังไม่มีกองที่กรอกอุปกรณ์)' : '(ไม่มีงานในช่วงนี้)')
    return out.join('\n').trimEnd() + '\n'
  }
  for (const r of rows) {
    const head = [formatProductionIds(r.productionIds), r.time ? `🕐 ${r.time}` : '', clean(r.title)]
      .filter(Boolean).join('  ')
    out.push(`━━ ${head}`)
    out.push(`อุปกรณ์: ${clean(r.equipment) ? clean(r.equipment).replace(/\s*\n\s*/g, ' / ') : DASH}`)
    if (r.crew && r.crew.length > 0) out.push(`ทีม: ${r.crew.join(', ')}`)
    out.push('')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
