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
/** ชื่อแบบ FX6 XDROOT มี reel + วันที่ + รหัสกล้องในตัว = ไม่ซ้ำข้ามโฟลเดอร์ → จับคู่ด้วยชื่ออย่างเดียว */
const UNIQUE_NAME = /^[A-Z]\d{3}[A-Z]\d{3}_[0-9A-Z]{6,}$/i
/** ส่วนท้ายของโครงการ์ด — ตัดออกเพื่อให้ Clip กับ Sub ของการ์ดเดียวกันอยู่กลุ่มเดียวกัน (ใช้กับชื่อที่ซ้ำได้ เช่น C0001) */
const CARD_TAIL = new Set(['XDROOT', 'M4ROOT', 'PRIVATE', 'CLIP', 'SUB'])

const lastFolder = (f: FootageFileLike) => (f.folderPath || []).slice(-1)[0]?.trim().toUpperCase() || ''

function groupOf(f: FootageFileLike): string {
  const segs: string[] = []
  for (const s of f.folderPath || []) {
    const u = s.trim().toUpperCase()
    if (CARD_TAIL.has(u)) break
    segs.push(u)
  }
  return segs.join('/')
}

/**
 * ชื่อคลิปที่มี Sub/XML แต่ต้นฉบับยังมาไม่ครบ (เรียงตามชื่อ) · ว่าง = ครบ หรือไม่มีคลิปโครง Sony เลย
 *
 * ผู้ตรวจ v1.251 เจอ 4 ข้อ ก่อน deploy:
 *  - นับเป็น Sub/XML เฉพาะที่อยู่ในโครง Sony จริง (…S03.MP4 ในโฟลเดอร์ Sub · …M01.XML ในโฟลเดอร์ Clip) —
 *    ไฟล์ export ชื่อลงท้าย S03 (Teaser_EPS03.mp4) ไม่ใช่ proxy · ต้นฉบับชื่อไหนก็ได้ (CAMA0001, Clip0001)
 *    เพราะมีผลก็ต่อเมื่อจับคู่กับ Sub/XML เท่านั้น
 *  - ชื่อ FX6 ไม่ซ้ำ → จับคู่ด้วยชื่ออย่างเดียว (ต้นฉบับที่กู้ไปวางคนละ path ยังนับว่าครบ)
 *  - ชื่อที่ซ้ำได้ (M4ROOT C0001 หลายวัน/หลายการ์ด) นับ **จำนวน**: ค้าง = Sub หรือ XML มากกว่าต้นฉบับ
 *    (ชื่อ FX6 ใช้แค่ "มีต้นฉบับไหม" — การ์ดที่ถูกคัดลอกซ้ำทำให้ Sub/XML มีสองชุดได้)
 */
export function pendingOriginals(files: FootageFileLike[]): string[] {
  const clips = new Map<string, { name: string; orig: number; sub: number; xml: number }>()
  for (const f of files) {
    let m: RegExpExecArray | null
    let kind: 'orig' | 'sub' | 'xml'
    const where = lastFolder(f)
    if ((m = SUB.exec(f.name)) && where === 'SUB') kind = 'sub'
    else if ((m = XML.exec(f.name)) && where === 'CLIP') kind = 'xml'
    else if ((m = ORIG.exec(f.name)) && !SUB.test(f.name)) kind = 'orig'
    else continue
    const clip = m[1]
    const key = UNIQUE_NAME.test(clip) ? clip.toUpperCase() : `${groupOf(f)}|${clip.toUpperCase()}`
    const c = clips.get(key) || { name: clip, orig: 0, sub: 0, xml: 0 }
    c[kind]++
    clips.set(key, c)
  }
  return Array.from(clips.values())
    .filter(c => {
      if (!c.sub && !c.xml) return false
      // ชื่อไม่ซ้ำ (FX6): มีต้นฉบับสักไฟล์ = ครบ — การ์ดที่ถูกคัดลอกซ้ำ ("Card 2" + "Card 2 (คอมดับ)") ได้ Sub/XML
      // สองชุดต่อ MXF เดียว (เจอจริงใน 260915-02) ต้องไม่ถูกนับว่าค้าง · ชื่อที่ซ้ำได้ (C0001) ใช้การนับ
      return UNIQUE_NAME.test(c.name) ? c.orig === 0 : Math.max(c.sub, c.xml) > c.orig
    })
    .map(c => c.name)
    .sort()
}
