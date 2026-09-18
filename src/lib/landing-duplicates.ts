/**
 * "โฟลเดอร์ drop นี้ยังมีไฟล์ค้าง — แล้วมันคืออะไรกันแน่" (v1.224)
 *
 * ## ปัญหาที่ตัวนี้แก้
 *
 * `video-merge` ตัดสินว่าไฟล์ "ซ้ำ" จาก **ชื่อ + ขนาด** แล้ว `continue` ทิ้งตัวใน
 * landing ไว้ (ตั้งใจ — ไม่ลบอะไรเลย) ผลคือโฟลเดอร์ไม่มีวันว่าง ตัวเก็บกวาดจึงไม่ลบ
 * (นโยบายลบเฉพาะโฟลเดอร์ว่าง) → **ค้างถาวร** และการแจ้งเตือนที่มีอยู่บอกได้แค่
 * "N โฟลเดอร์ยังมีไฟล์ = ยังไม่ได้ merge **หรือ** เป็นไฟล์ซ้ำ" ซึ่งคนอ่านแล้วทำอะไรต่อไม่ได้
 *
 * ## ทำไมต้อง md5 ไม่ใช่ชื่อ+ขนาด
 *
 * เคสจริงที่ทีมบันทึกไว้: `TSS-WYS-260824-01` ไฟล์ตรงกันทั้ง 585 ไฟล์ด้วยชื่อ+ขนาด
 * แต่ `DSC04216.ARW` **เนื้อในคนละไฟล์** — ตัวใน landing เป็น Sony RAW จริง
 * ส่วนตัวในกล่องเป็นไฟล์เสียหัว JPEG และ md5 ของ RAW นั้นไม่มีที่อื่นเลย
 * ⇒ **ชื่อ+ขนาดไม่ใช่ตัวตนของไฟล์ · อะไรที่จะลบของต้องตัดสินด้วย checksum เท่านั้น**
 *
 * ตัวนี้จึงไม่ลบอะไรเลย — หน้าที่เดียวคือ **ตอบให้ชัดว่าลบได้หรือไม่ได้**
 * แล้วส่งคำตอบนั้นไปให้คนตัดสินใจ
 */
import { listFilesRecursive, findFoldersByCode } from './google-drive'

export interface LandingDupVerdict {
  code: string
  /** ไฟล์ที่ยังอยู่ในโฟลเดอร์ drop */
  landingFiles: number
  /** ไฟล์ที่เจอ checksum เดียวกันในกล่อง = ซ้ำจริง */
  duplicated: number
  /** ไฟล์ที่ **ไม่เจอ** checksum ในกล่อง = ของจริงชุดเดียว ห้ามลบ */
  onlyHere: number
  /** ไฟล์ที่ Drive ไม่ให้ checksum มา (Google-native ฯลฯ) — ตัดสินไม่ได้ */
  noChecksum: number
  /** ไบต์รวมของไฟล์ที่ซ้ำจริง (พื้นที่ที่จะได้คืนถ้าลบ) */
  duplicatedBytes: number
  verdict:
    | 'safe-to-delete'   // ซ้ำครบทุกไฟล์ — ลบตัวใน landing ได้
    | 'not-merged'       // ยังมีของที่ไม่มีในกล่อง — ยังไม่ได้ย้าย/ย้ายไม่ครบ
    | 'undecidable'      // อ่านกล่องไม่ได้ / ไม่มี checksum ให้เทียบ
  reason: string
}

/** ข้อความสั้นสำหรับแจ้งเตือน — อ่านบนมือถือรู้เรื่อง */
export function verdictLine(v: LandingDupVerdict): string {
  const gb = (v.duplicatedBytes / 1_073_741_824).toFixed(1)
  if (v.verdict === 'safe-to-delete') {
    return `· ${v.code} — ย้ายครบแล้ว ของใน drop ซ้ำทุกไฟล์ (เทียบ md5 แล้ว ${v.duplicated} ไฟล์ · ${gb} GB) ลบได้`
  }
  if (v.verdict === 'not-merged') {
    return `· ${v.code} — ⚠️ ยังมี ${v.onlyHere} ไฟล์ที่ไม่มีในกล่อง (จาก ${v.landingFiles}) **ห้ามลบ** ${v.reason}`
  }
  return `· ${v.code} — ตัดสินไม่ได้: ${v.reason}`
}

/**
 * เทียบโฟลเดอร์ drop ของใบจองหนึ่งกับกล่องด้วย checksum
 *
 * อ่านอย่างเดียว ไม่แตะ Drive เลย · "อ่านกล่องไม่ได้" ต้องออกมาเป็น `undecidable`
 * ไม่ใช่ `safe-to-delete` — เดาผิดข้างนี้แปลว่าฟุตเทจหาย
 */
export async function verifyLandingDuplicates(
  code: string,
  landingFolderId: string,
  opts: { maxFiles?: number } = {},
): Promise<LandingDupVerdict> {
  const base: LandingDupVerdict = {
    code, landingFiles: 0, duplicated: 0, onlyHere: 0, noChecksum: 0,
    duplicatedBytes: 0, verdict: 'undecidable', reason: '',
  }
  const maxFiles = opts.maxFiles ?? 5000

  let landing
  try {
    landing = await listFilesRecursive(landingFolderId, { maxFiles })
  } catch (e: any) {
    return { ...base, reason: `อ่านโฟลเดอร์ drop ไม่ได้: ${e?.message || e}` }
  }
  base.landingFiles = landing.length
  if (landing.length === 0) return { ...base, verdict: 'safe-to-delete', reason: 'ไม่มีไฟล์เหลือแล้ว' }

  // กล่อง = โฟลเดอร์อื่นทุกอันที่ชื่อมี Production ID นี้ (ยกเว้นตัว drop เอง)
  let boxFolders
  try {
    boxFolders = (await findFoldersByCode(code)).filter(f => f.id !== landingFolderId)
  } catch (e: any) {
    return { ...base, reason: `หาโฟลเดอร์ในกล่องไม่ได้: ${e?.message || e}` }
  }
  if (boxFolders.length === 0) {
    return { ...base, verdict: 'not-merged', onlyHere: landing.length, reason: 'ยังไม่มีโฟลเดอร์ในกล่องเลย' }
  }

  const boxMd5 = new Set<string>()
  for (const f of boxFolders) {
    try {
      for (const file of await listFilesRecursive(f.id, { maxFiles })) {
        if (file.md5) boxMd5.add(file.md5)
      }
    } catch (e: any) {
      // อ่านกล่องได้ไม่ครบ = เทียบไม่ครบ = ตัดสินไม่ได้ (ห้ามบอกว่าลบได้)
      return { ...base, reason: `อ่านกล่องไม่ครบ: ${e?.message || e}` }
    }
  }

  for (const f of landing) {
    if (!f.md5) { base.noChecksum++; continue }
    if (boxMd5.has(f.md5)) { base.duplicated++; base.duplicatedBytes += f.size ?? 0 }
    else base.onlyHere++
  }

  if (base.onlyHere > 0) {
    return { ...base, verdict: 'not-merged', reason: `ซ้ำแล้ว ${base.duplicated} · ยังไม่มีในกล่อง ${base.onlyHere}` }
  }
  if (base.noChecksum > 0) {
    return { ...base, reason: `${base.noChecksum} ไฟล์ไม่มี checksum ให้เทียบ` }
  }
  return { ...base, verdict: 'safe-to-delete', reason: 'ทุกไฟล์มี checksum ตรงกันในกล่อง' }
}
