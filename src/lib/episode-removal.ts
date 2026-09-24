/**
 * v1.236 — ลดจำนวนตอนในใบจอง: ตัดสินว่าตอนไหนลบได้ ตอนไหนห้าม
 *
 * WHY THIS FILE EXISTS. การลบตอนไม่ใช่แค่ลบแถว — ตอนหนึ่งตอนถูกอ้างถึงหลายที่
 * และแต่ละที่พังคนละแบบ จึงต้องมีที่เดียวที่รู้กฎทั้งหมด และเทสได้โดยไม่ต้องต่อ DB
 *
 * สิ่งที่ผูกกับตอน (ตรวจกับพรอด 2026-09-24):
 *   · `uploads.episodeId` — FK เป็น **ON DELETE SET NULL** ไม่ใช่ cascade
 *     ลบตอน = ไฟล์ไม่หาย แต่ขาดการผูกกับตอนถาวรและไม่มีทางรู้ว่าเคยเป็นของตอนไหน
 *     ของจริงตอนนี้: 7 ตอนมีไฟล์ผูกอยู่ รวม 1,861 ไฟล์ ⇒ **ห้ามลบ**
 *   · `Episode.equipmentNote` / `rentalGearNote` — ตัวจริงของอุปกรณ์ราย
 *     Production ID ส่วนช่องบนใบจองเป็นสรุปที่คำนวณมา (gear-notes.ts)
 *     ⇒ ลบแล้วต้องคำนวณสรุปใหม่ ไม่งั้นสรุปค้างอุปกรณ์ของตอนที่ไม่มีแล้ว
 *   · ชื่อโฟลเดอร์ Drive ของใบ ประกอบจาก `bookingShowName()` ซึ่งดูรายการของ
 *     "ตอน" ⇒ ลบตอนที่เป็นรายการเดียวในกลุ่มออก = ชื่อโฟลเดอร์เปลี่ยน แล้ว
 *     folder-integrity จะ **เปลี่ยนชื่อโฟลเดอร์ให้เอง**ในรอบถัดไป · ไม่ใช่เรื่องร้าย
 *     (ระบบเป็น id-first ตั้งแต่ v1.114 ลิงก์ไม่พัง) แต่ต้องเตือนคนกดก่อน
 *   · โฟลเดอร์ Drive ของตอนนั้น **ไม่ถูกลบ** — folder-integrity สร้าง/เปลี่ยนชื่อ
 *     อย่างเดียว ไม่เคยลบ จงใจปล่อยค้างไว้ดีกว่าลบของที่อาจมีคนใส่ไฟล์ไว้
 *
 * `sequence` ที่หายไปจะเป็นรู (1,2,4) — **ห้ามเลื่อนให้ชิด** เพราะ
 * add-episodes มินต์ตัวถัดไปจาก max(sequence)+1 ถ้าเลื่อนชิดจะเกิด ID ซ้ำ
 */

export interface RemovableEpisode {
  id: string
  episodeId: string
  title: string
  sequence: number
  /** จำนวนไฟล์ที่ผูกกับตอนนี้ — >0 คือห้ามลบ */
  uploadCount: number
  /** ชื่อรายการของตอน ใช้ดูว่าลบแล้วชื่อโฟลเดอร์จะเปลี่ยนไหม */
  programName?: string | null
}

export interface RemovalPlan {
  remove: RemovableEpisode[]
  blocked: Array<{ episodeId: string; reason: string }>
  remaining: RemovableEpisode[]
  /** ลบแล้วชุดชื่อรายการเปลี่ยน ⇒ folder-integrity จะเปลี่ยนชื่อโฟลเดอร์ให้ */
  folderNameWillChange: boolean
}

function showNameKey(eps: RemovableEpisode[], bookingProgramName: string): string {
  const names: string[] = []
  for (const e of eps) {
    const n = (e.programName || '').trim()
    if (n && n !== bookingProgramName && !names.includes(n)) names.push(n)
  }
  return names.join('|')
}

export function planEpisodeRemoval(
  all: RemovableEpisode[],
  idsToRemove: readonly string[],
  bookingProgramName: string,
): RemovalPlan {
  const wanted = new Set(idsToRemove.map(s => String(s || '').trim()).filter(Boolean))
  const byId = new Map(all.map(e => [e.id, e]))

  const remove: RemovableEpisode[] = []
  const blocked: RemovalPlan['blocked'] = []

  for (const raw of wanted) {
    const ep = byId.get(raw)
    if (!ep) {
      blocked.push({ episodeId: raw, reason: 'ไม่ใช่ตอนของใบจองนี้' })
      continue
    }
    if (ep.uploadCount > 0) {
      blocked.push({
        episodeId: ep.episodeId,
        reason: `มีไฟล์อัปโหลดผูกอยู่ ${ep.uploadCount} ไฟล์ — ลบตอนแล้วไฟล์จะยังอยู่แต่ไม่รู้ว่าเป็นของตอนไหนอีกเลย`,
      })
      continue
    }
    remove.push(ep)
  }

  const removeIds = new Set(remove.map(e => e.id))
  const remaining = all.filter(e => !removeIds.has(e.id))

  // ใบจองที่ไม่เหลือตอนเลยคือใบที่ไม่มี Production ID ให้ใครอ้างถึง — ทุกอย่าง
  // ตั้งแต่ชื่อโฟลเดอร์ ชีท ไปจนถึงการเบิกอุปกรณ์ผูกกับตอน จึงต้องเหลืออย่างน้อยหนึ่ง
  if (all.length > 0 && remaining.length === 0) {
    return {
      remove: [],
      blocked: [
        ...blocked,
        ...remove.map(e => ({ episodeId: e.episodeId, reason: 'ต้องเหลืออย่างน้อย 1 ตอน — ถ้าจะยกเลิกทั้งใบ ให้ยกเลิกใบจองแทน' })),
      ],
      remaining: all,
      folderNameWillChange: false,
    }
  }

  return {
    remove,
    blocked,
    remaining,
    folderNameWillChange:
      remove.length > 0 &&
      showNameKey(remaining, bookingProgramName) !== showNameKey(all, bookingProgramName),
  }
}
