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
/** v1.254 — file name (any part: .MXF · S03.MP4 · M01.XML · T01.JPG) of a clip whose name is unique in the whole box (FX6 reel+date) */
export const hasUniqueClipName = (fileName: string) => new RegExp(UNIQUE_NAME.source.slice(0, -1), 'i').test(baseName(fileName))
/** ส่วนท้ายของโครงการ์ด — ตัดออกเพื่อให้ Clip กับ Sub ของการ์ดเดียวกันอยู่กลุ่มเดียวกัน (ใช้กับชื่อที่ซ้ำได้ เช่น C0001) */
const CARD_TAIL = new Set(['XDROOT', 'M4ROOT', 'PRIVATE', 'CLIP', 'SUB'])

/**
 * v1.253.4 — ชื่อที่ Drive ใส่ตอนกด "ทำสำเนา" (`Copy of X` / `สำเนาของ X`) คือไฟล์ X · เจอจริง AGN-260909-01:
 * Sub ถูกทำสำเนาในโฟลเดอร์ SUB เลยดูเหมือนมีคลิป "Copy of A003C107_…" ที่ไม่มีต้นฉบับ (ต้นฉบับอยู่ครบ)
 */
export const baseName = (name: string) => name.replace(/^(?:Copy of |สำเนาของ )+/i, '')

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
  return pendingOriginalClips(files).map(c => c.clip).sort()
}

/** คีย์จับคู่ส่วนของคลิป: ชื่อ FX6 ไม่ซ้ำ = ชื่อทั้งกล่อง · ชื่อที่ซ้ำได้ (C0001) = กลุ่ม EP/กล้อง/การ์ด + ชื่อ */
export const clipKey = (f: FootageFileLike, clip: string) => UNIQUE_NAME.test(clip) ? clip.toUpperCase() : `${groupOf(f)}|${clip.toUpperCase()}`

/** v1.253 — เหมือน pendingOriginals แต่บอกกลุ่ม (EP/กล้อง) และคีย์ด้วย — รายงานบอกได้ว่าต้องตามการ์ดไหน */
export function pendingOriginalClips(files: FootageFileLike[]): Array<{ clip: string; group: string; key: string }> {
  const clips = new Map<string, { name: string; group: string; orig: number; sub: number; xml: number }>()
  for (const f of files) {
    let m: RegExpExecArray | null
    let kind: 'orig' | 'sub' | 'xml'
    const where = lastFolder(f)
    const name = baseName(f.name)
    if ((m = SUB.exec(name)) && where === 'SUB') kind = 'sub'
    else if ((m = XML.exec(name)) && where === 'CLIP') kind = 'xml'
    else if ((m = ORIG.exec(name)) && !SUB.test(name)) kind = 'orig'
    else continue
    const clip = m[1]
    const key = clipKey(f, clip)
    const c = clips.get(key) || { name: clip, group: groupOf(f), orig: 0, sub: 0, xml: 0 }
    c[kind]++
    clips.set(key, c)
  }
  return Array.from(clips.entries())
    .filter(([, c]) => {
      if (!c.sub && !c.xml) return false
      // ชื่อไม่ซ้ำ (FX6): มีต้นฉบับสักไฟล์ = ครบ — การ์ดที่ถูกคัดลอกซ้ำ ("Card 2" + "Card 2 (คอมดับ)") ได้ Sub/XML
      // สองชุดต่อ MXF เดียว (เจอจริงใน 260915-02) ต้องไม่ถูกนับว่าค้าง · ชื่อที่ซ้ำได้ (C0001) ใช้การนับ
      return UNIQUE_NAME.test(c.name) ? c.orig === 0 : Math.max(c.sub, c.xml) > c.orig
    })
    .map(([key, c]) => ({ clip: c.name, group: c.group, key }))
}

// ── v1.253 — ตรวจรายวัน (MEDIAPOOL-CHECK.md เป็นโค้ด) ──────────────────────────────────────────────

/** ชื่อคลิปกล้อง Sony ที่รู้จัก: FX6 XDROOT (A009R001_2609151T) · M4ROOT (C0001) — ตรงกับ CAMERA ใน mediapool_check.py */
const CAMERA = /^([A-Z]\d{3}[A-Z]\d{3}_[0-9A-Z]{6,}|C\d{4})$/i
const WAV = /\.WAV$/i

/** ไฟล์ในโฟลเดอร์ `_แยกไว้ · …` ที่ root ของกล่อง = คนตั้งใจแยกออก (เช่นตัวอัปไม่จบของ A004R001) — ไม่นับทุกด่าน */
export function isQuarantined(f: FootageFileLike): boolean {
  return /^_แยกไว้/.test(f.folderPath?.[0]?.trim() || '')
}

export type ClipPart = 'orig' | 'sub' | 'xml'

/** ไฟล์นี้เป็นส่วนไหนของคลิปกล้อง Sony (ต้นฉบับ / Sub / M01.XML) · null = ไม่ใช่คลิปกล้อง (เพลง กราฟิก export) */
export function sonyClipPart(fileName: string): { clip: string; part: ClipPart } | null {
  const name = baseName(fileName)
  let m: RegExpExecArray | null
  if ((m = SUB.exec(name)) && CAMERA.test(m[1])) return { clip: m[1], part: 'sub' }
  if ((m = XML.exec(name)) && CAMERA.test(m[1])) return { clip: m[1], part: 'xml' }
  if ((m = ORIG.exec(name)) && !SUB.test(name) && CAMERA.test(m[1])) return { clip: m[1], part: 'orig' }
  return null
}

export interface MissingSidecar { clip: string; group: string; key: string; missing: Array<'M01.XML'> }

/**
 * ต้นฉบับมาแล้ว แต่ M01.XML ของคลิปนั้นยังไม่มา (เคสจริง 260924-01: M01.XML 8 ไฟล์ค้างในถังขยะ)
 *
 * กล้อง Sony เขียน M01.XML ทุกคลิปเสมอ (XDROOT และ M4ROOT) → ต้นฉบับชื่อกล้อง Sony ในโฟลเดอร์ Clip ต้องมี
 * **Sub ไม่บังคับ**: Sony ไม่อัด proxy ให้คลิป 100/120p และ S&Q แม้เปิด proxy ไว้ (FX3/FX30/FX6) — Sub ที่ขาด
 * รายงานผ่านการเทียบ Media Pool เท่านั้น (ตอนที่คนตัดใช้ Sub ตัวนั้นจริง)
 * ชื่อ FX6 ไม่ซ้ำ → หา XML ทั้งกล่อง (การ์ดคัดลอกซ้ำ / ไฟล์ที่กู้ไปวางคนละที่ ยังนับ) · C0001 หาในการ์ดเดียวกัน
 */
export function missingSidecars(files: FootageFileLike[]): MissingSidecar[] {
  const xml = new Set<string>()
  const origs = new Map<string, { clip: string; group: string }>()
  for (const f of files) {
    if (isQuarantined(f)) continue
    const p = sonyClipPart(f.name)
    const where = lastFolder(f)
    if (!p) continue
    if (p.part === 'xml' && where === 'CLIP') xml.add(clipKey(f, p.clip))
    else if (p.part === 'orig' && where === 'CLIP') origs.set(clipKey(f, p.clip), { clip: p.clip, group: groupOf(f) })
  }
  const out: MissingSidecar[] = []
  for (const [key, o] of origs) if (!xml.has(key)) out.push({ ...o, key, missing: ['M01.XML'] })
  return out.sort((a, b) => a.clip.localeCompare(b.clip))
}

export interface MediaPoolItem { name: string; kind: 'video' | 'audio'; bookingCode: string | null }

export interface MediaPoolCompare {
  /** คลิปกล้อง + WAV ใน bin ของคิวนี้ */
  inPool: number
  /** อยู่ใน Media Pool (bin ของคิวนี้) แต่ในกล่องไม่ครบ — คนตัดใช้อยู่ แต่ Drive ไม่มี */
  missing: Array<{ name: string; lacks: string[] }>
  /** อยู่ในกล่องแต่ยังไม่อยู่ใน Media Pool (ข้อมูล ไม่ใช่ข้อผิด — คนตัดอาจยังไม่ได้ดึงเข้า) */
  notInPool: string[]
}

/**
 * เทียบ Media Pool ↔ กล่องของคิวหนึ่ง (พอร์ตจาก mediapool_check.py · ทดสอบกับ PP-26-034 แล้ว 310/310)
 *
 * Media Pool → Drive: คลิปกล้องต้องมีต้นฉบับ + M01.XML บน Drive และถ้าตัวที่คนตัดใช้คือ Sub ก็ต้องมี Sub ·
 * WAV ต้องมีชื่อเดียวกัน · อย่างอื่น (เพลง กราฟิก) ไม่ตรวจ
 * Drive → Media Pool: ชื่อ FX6 ไม่ซ้ำ จึงเทียบกับทั้ง Media Pool (คนตัดวางผิด bin ก็ยังนับ) · C0001 กับ WAV (REC-001)
 * ซ้ำข้ามวันได้ จึงเทียบเฉพาะ bin ของคิวนี้ และ bin ที่ไม่ได้ตั้งชื่อตามคิว
 */
export function compareMediaPool(pool: MediaPoolItem[], bookingCode: string, boxFiles: FootageFileLike[]): MediaPoolCompare {
  const code = bookingCode.toUpperCase()
  const drive = new Map<string, Set<ClipPart>>()
  const driveWavs = new Map<string, string>()
  for (const f of boxFiles) {
    if (isQuarantined(f)) continue
    const p = sonyClipPart(f.name)
    if (p) {
      const k = p.clip.toUpperCase()
      if (!drive.has(k)) drive.set(k, new Set())
      drive.get(k)!.add(p.part)
    } else if (WAV.test(f.name)) driveWavs.set(baseName(f.name).toUpperCase(), baseName(f.name))
  }

  const isMine = (i: MediaPoolItem) => i.bookingCode?.toUpperCase() === code
  const isNearby = (i: MediaPoolItem) => !i.bookingCode || isMine(i)
  const mine = pool.filter(isMine)
  const missing: MediaPoolCompare['missing'] = []
  const seen = new Set<string>()
  let inPool = 0
  for (const it of mine) {
    const p = sonyClipPart(it.name)
    if (p) {
      const k = p.clip.toUpperCase()
      if (seen.has(k)) continue
      seen.add(k)
      inPool++
      const on = drive.get(k) || new Set<ClipPart>()
      const lacks = [
        ...(on.has('orig') ? [] : ['ต้นฉบับ']),
        ...(p.part === 'sub' && !on.has('sub') ? ['Sub'] : []),
        ...(on.has('xml') ? [] : ['M01.XML']),
      ]
      if (lacks.length) missing.push({ name: p.clip, lacks })
    } else if (WAV.test(it.name)) {
      const k = `WAV|${it.name.toUpperCase()}`
      if (seen.has(k)) continue
      seen.add(k)
      inPool++
      if (!driveWavs.has(it.name.toUpperCase())) missing.push({ name: it.name, lacks: ['WAV'] })
    }
  }

  const poolClips = new Set<string>()
  for (const it of pool) {
    const p = sonyClipPart(it.name)
    if (p && (UNIQUE_NAME.test(p.clip) || isNearby(it))) poolClips.add(p.clip.toUpperCase())
  }
  const poolWavs = new Set(pool.filter(i => isNearby(i) && WAV.test(i.name)).map(i => i.name.toUpperCase()))
  const notInPool = [
    ...[...drive.keys()].filter(k => !poolClips.has(k)),
    ...[...driveWavs.entries()].filter(([k]) => !poolWavs.has(k)).map(([, n]) => n),
  ].sort()
  return { inPool, missing: missing.sort((a, b) => a.name.localeCompare(b.name)), notInPool }
}
