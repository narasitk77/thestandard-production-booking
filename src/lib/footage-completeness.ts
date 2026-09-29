/**
 * v1.251 — ต้นฉบับกล้องมาครบหรือยัง (กฎล้วน ไม่มี Drive — เทสได้)
 *
 * ที่มา (PP-26-034 · 30 ก.ย. 2569): prune เที่ยงทิ้งโฟลเดอร์ drop ของ 260911-02 / 260915-02 / 260924-01 ตอน
 * "ว่าง + กล่องมีฟุตเทจแล้ว" — แต่ **ฟุตเทจที่มาก่อนคือ Sub/XML ตัวเล็ก** ต้นฉบับ MXF (หลายร้อย GB) อัปจาก NAS
 * ตามมาทีหลัง 1–2 วัน แล้ว **ไปตกในโฟลเดอร์ที่อยู่ในถังขยะ** — ด่านตรวจกับตัวย้ายเข้ากล่องมองไม่เห็น 27 ไฟล์ 723 GB
 * และถังขยะ shared drive ลบถาวรใน ~30 วัน
 *
 * กฎ = ข้อ 1 ของด่านตรวจฟุตเทจ: คลิปกล้องที่มี Sub (…S03.MP4) หรือ …M01.XML แล้ว ต้องมีต้นฉบับ (.MXF/.MP4/.MOV)
 * ในกลุ่ม EP/กล้องเดียวกัน · ยังไม่มี = **ต้นฉบับยังมาไม่ครบ** → ห้ามทิ้งโฟลเดอร์ drop
 */

export interface FootageFileLike {
  name: string
  folderPath?: string[]
}

const SUB = /^(.+?)S03\.MP4$/i
const XML = /^(.+?)M01\.XML$/i
const ORIG = /^(.+)\.(MXF|MP4|MOV)$/i
/** ชื่อคลิปกล้องที่รู้จัก: FX6 XDROOT (A009R001_2609151T) · M4ROOT (C0001) — MP4 อื่นไม่ใช่ต้นฉบับกล้อง */
const CAMERA = /^([A-Z]\d{3}[A-Z]\d{3}_[0-9A-Z]{6,}|C\d{4})$/i
/** ส่วนท้ายของโครงการ์ด — ตัดออกเพื่อให้ Clip กับ Sub ของการ์ดเดียวกันอยู่กลุ่มเดียวกัน */
const CARD_TAIL = new Set(['XDROOT', 'M4ROOT', 'PRIVATE', 'CLIP', 'SUB'])

function groupOf(f: FootageFileLike): string {
  const segs: string[] = []
  for (const s of f.folderPath || []) {
    const u = s.trim().toUpperCase()
    if (CARD_TAIL.has(u)) break
    segs.push(u)
  }
  return segs.join('/')
}

/** ชื่อคลิปที่มี Sub/XML แต่ยังไม่มีต้นฉบับ (เรียงตามชื่อ) · ว่าง = ครบ หรือไม่มีคลิปกล้องแบบที่รู้จักเลย */
export function pendingOriginals(files: FootageFileLike[]): string[] {
  const clips = new Map<string, { name: string; orig: boolean; proxy: boolean }>()
  for (const f of files) {
    let m: RegExpExecArray | null
    let clip: string
    let orig = false
    if ((m = SUB.exec(f.name)) || (m = XML.exec(f.name))) clip = m[1]
    else if ((m = ORIG.exec(f.name)) && CAMERA.test(m[1])) { clip = m[1]; orig = true }
    else continue
    const key = `${groupOf(f)}|${clip.toUpperCase()}`
    const c = clips.get(key) || { name: clip, orig: false, proxy: false }
    if (orig) c.orig = true
    else c.proxy = true
    clips.set(key, c)
  }
  return Array.from(clips.values()).filter(c => c.proxy && !c.orig).map(c => c.name).sort()
}
