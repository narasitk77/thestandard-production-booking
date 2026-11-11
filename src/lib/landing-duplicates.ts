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
import { pendingOriginals } from './footage-completeness'
import { listFilesRecursive, findFoldersByCode, classifyFootageTreeFolder } from './google-drive'

/**
 * "กล่อง" = โฟลเดอร์ที่ชื่อมี Production ID นี้ **ในไดรฟ์ VIDEO และไม่อยู่ใต้ _SOUND-STAGING** เท่านั้น
 *
 * findFoldersByCode ค้นชื่อทุกไดรฟ์ จึงได้โฟลเดอร์ _SOUND-STAGING ของงาน (ชื่อ "(CODE)" แบบเดียวกัน ไดรฟ์เดียวกัน)
 * กับโฟลเดอร์ drop แฝด "(1)" บน Production Team มาด้วย — WAV ที่รากของ staging ไม่มี segment 'AUDIO' จึงถูกนับเป็น
 * "ฟุตเทจกล้อง" แล้วโฟลเดอร์ drop ของงานที่วิดีโอยังไม่เคยมาถึงก็ถูกทิ้ง (รูปเดียวกับ POP-7TG-260916-01 แต่มาทาง staging)
 * กรองแบบเดียวกับ prep-folders/landing-lifecycle · ตัดสินไม่ได้ว่าอยู่ไดรฟ์ไหน = throw (ผู้เรียกแปลงเป็น unknown/undecidable)
 */
async function boxFoldersByCode(code: string, excludeFolderId?: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = []
  for (const f of await findFoldersByCode(code)) {
    if (f.id === excludeFolderId) continue
    const cls = await classifyFootageTreeFolder(f.id)
    if (cls === 'unknown') throw new Error(`ตรวจไม่ได้ว่าโฟลเดอร์ "${f.name}" อยู่ในไดรฟ์ VIDEO หรือไม่`)
    if (cls === 'in-tree') out.push(f)
  }
  return out
}

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

  // กล่อง = โฟลเดอร์ในไดรฟ์ VIDEO ที่ชื่อมี Production ID นี้ (ไม่นับ staging / drop แฝด "(1)" — md5 ที่อยู่ใน
  // โฟลเดอร์ drop อีกอันไม่ได้แปลว่าไฟล์อยู่ในกล่อง: สองแฝดจะบอกว่า "ลบได้" โดยอ้างกันเอง)
  let boxFolders
  try {
    boxFolders = await boxFoldersByCode(code, landingFolderId)
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


// ── "กล่องของงานนี้มีฟุตเทจจริงหรือยัง" (v1.225) ────────────────────────────

export type BoxFootageState =
  | { state: 'has-footage'; files: number }
  /** กล่องไม่มีฟุตเทจกล้องเลย = **ยังไม่ได้ส่งงาน** ไม่ใช่ส่งเสร็จ */
  | { state: 'no-footage'; reason: string }
  /** อ่านไม่ได้ = ตัดสินไม่ได้ ห้ามตีความเป็นอย่างใดอย่างหนึ่ง */
  | { state: 'unknown'; reason: string }
  /** v1.251 — มีฟุตเทจแล้ว แต่ต้นฉบับกล้องยังมาไม่ครบ (Sub/XML มาก่อน MXF) = **ยังอัปอยู่** ห้ามทิ้งโฟลเดอร์ drop */
  | { state: 'originals-pending'; reason: string; files: number; pending: string[] }

/** ไฟล์ stub ที่ระบบสร้างเอง ไม่ใช่ฟุตเทจ */
const SHOOT_STUB = /^_SHOOT\b.*\.txt$/i

/**
 * ฟุตเทจที่ "เดินผ่านโฟลเดอร์ drop" คือฟุตเทจ **กล้อง** เท่านั้น
 *
 * เสียงมาคนละทาง (_SOUND-STAGING → โฟลเดอร์ AUDIO ในกล่อง) จึงต้องไม่นับ —
 * ไม่งั้นงานที่มีแต่ไฟล์เสียงจะดูเหมือน "ส่งงานแล้ว" ทั้งที่วิดีโอยังไม่เคยมาถึง
 * ซึ่งคือเคส POP-7TG-260916-01 เป๊ะ ๆ (กล่องมี .wav 2 ไฟล์ + _SHOOT.txt
 * ระบบจึงทิ้งโฟลเดอร์ drop ทิ้งไปทั้งที่ยังไม่มีวิดีโอสักไฟล์)
 */
function isCameraFootage(f: { name: string; folderPath?: string[] }): boolean {
  if (SHOOT_STUB.test(f.name)) return false
  return !(f.folderPath || []).some(seg => seg.trim().toUpperCase() === 'AUDIO')
}

/**
 * v1.285 — งานเสียงล้วน **ที่มีหลักฐานบวก** (`isSoundOnlyBooking` ใน mediapro.ts: กล้อง = 0 ชัดเจน · ไม่ใช่ Block Shot · ทุกบทบาทคือ Sound
 * — **ห้ามใช้ `!expectsCameraVideo`** มันตอบ false เมื่อไม่มีข้อมูล) ไม่มีฟุตเทจกล้องมาถึงกล่อง
 * ไม่ว่าวันไหน — กล่องที่ "เสร็จ" ของงานแบบนี้จึงมีแต่เสียง (ใต้ AUDIO) + stub · ถ้าอ่านว่า "ไม่มีฟุตเทจกล้อง =
 * ยังไม่ส่งงาน" โฟลเดอร์ drop ของมันจะค้างถาวร (11 พ.ย. 2569 เก็บไว้ 6 ใบ · มีเสียงในกล่องจริง 3 ใบ)
 *
 * เกณฑ์ "ส่งแล้ว" ของงานเสียงล้วนจึงเป็น **มีไฟล์เสียงจริงในกล่อง** — นามสกุลเสียง · อยู่ใต้ AUDIO · ขนาด > 0
 * (0 ไบต์ = ก็อปค้าง) · ไม่ใช่ `._*` (AppleDouble) · stub/Google Doc/ไฟล์อื่นไม่นับ · ไม่มีไฟล์เสียงสักไฟล์ = ยังไม่ส่ง
 * = เก็บ (เหมือนเหตุ POP-7TG-260916-01 แต่ฝั่งเสียง — อีก 3 ใบที่กล่องมีแต่ stub ยังถูกเก็บไว้)
 *
 * งานเสียงล้วนตัดสินจาก **เสียงอย่างเดียว** — ไฟล์อื่นข้าง ๆ (โน้ต, .DS_Store, WAV 0 ไบต์/วางนอก AUDIO) ไม่ทำให้
 * "ส่งแล้ว" และไม่บล็อกถ้าเสียงมาแล้ว (กฎกล้องนับไฟล์ใดก็ได้นอก AUDIO เป็นไฟล์กล้อง จึงใช้ตัดสินงานเสียงล้วนไม่ได้)
 */
const AUDIO_FILE = /\.(wav|bwf|mp3|m4a|aif|aiff|flac|aac)$/i
/** macOS AppleDouble sidecar (`._take01.wav`, ~4 KB) — copying from exFAT/FAT cards or uploading a folder from Finder drops one beside every file */
const APPLEDOUBLE = /^\._/
function isDeliveredAudio(f: { name: string; folderPath?: string[]; size?: number | null }): boolean {
  if (SHOOT_STUB.test(f.name) || APPLEDOUBLE.test(f.name) || !AUDIO_FILE.test(f.name)) return false
  if (!(f.folderPath || []).some(seg => seg.trim().toUpperCase() === 'AUDIO')) return false
  return (Number(f.size) || 0) > 0
}

/**
 * กล่องของ Production ID นี้มีฟุตเทจกล้องแล้วหรือยัง
 *
 * ใช้ก่อนจะ "ทิ้งโฟลเดอร์ drop ที่ว่าง" — เพราะ **ว่าง ≠ ส่งงานแล้ว**:
 * โฟลเดอร์ที่ฟุตเทจไม่เคยมาถึงก็ว่างเหมือนกันทุกประการ
 */
export async function boxFootageState(
  code: string,
  opts: {
    excludeFolderId?: string
    maxFiles?: number
    /**
     * v1.285 — the booking is POSITIVELY sound-only (`isSoundOnlyBooking`: cameraCount === 0, not Block Shot, every crew
     * role Sound): real audio in the box counts as delivered. NEVER derive this from `!expectsCameraVideo` — that is false
     * whenever data is missing (Block Shot, no crew, photographer-only) and would let one stray audio file trash a video
     * job's drop folder (POP-7TG-260916-01 again).
     */
    soundOnly?: boolean
  } = {},
): Promise<BoxFootageState> {
  // v1.251 — ต้องเห็นรายการครบถึงจะบอกได้ว่าต้นฉบับครบ (เดิมเจอไฟล์กล้องไฟล์เดียวก็พอ) · เพดานสูงขึ้น และถ้าชนเพดาน = unknown
  const maxFiles = opts.maxFiles ?? 20000
  let folders
  try {
    folders = await boxFoldersByCode(code, opts.excludeFolderId)
  } catch (e: any) {
    return { state: 'unknown', reason: `หาโฟลเดอร์ในกล่องไม่ได้: ${e?.message || e}` }
  }
  if (folders.length === 0) return { state: 'no-footage', reason: 'ไม่มีโฟลเดอร์ในกล่อง (ไดรฟ์ VIDEO) เลย' }

  let files = 0
  let audio = 0
  const camera: Array<{ name: string; folderPath?: string[] }> = []
  for (const f of folders) {
    try {
      const list = await listFilesRecursive(f.id, { maxFiles })
      if (list.length >= maxFiles) {
        // ถูกตัดท้าย (BFS — โฟลเดอร์ Clip/Sub ลึกสุดโดนตัดก่อน) = ตัดสินความครบไม่ได้ ห้ามทิ้ง
        return { state: 'unknown', reason: `กล่องใหญ่เกินเพดาน ${maxFiles} ไฟล์ — ตรวจว่าต้นฉบับครบไม่ได้` }
      }
      for (const file of list) {
        if (isCameraFootage(file)) { files++; camera.push(file) }
        else if (isDeliveredAudio(file)) audio++
      }
    } catch (e: any) {
      return { state: 'unknown', reason: `อ่านกล่องไม่ครบ: ${e?.message || e}` }
    }
  }
  if (opts.soundOnly) {
    // v1.285 — a sound-only job's delivery IS its audio, judged on audio alone: an audio-less box is "not delivered"
    // whatever else sits in it (a stray file outside AUDIO would otherwise count as camera footage below)
    if (audio === 0) return { state: 'no-footage', reason: 'งานเสียงล้วน — กล่องยังไม่มีไฟล์เสียง (ใต้ AUDIO)' }
  } else if (files === 0) {
    return { state: 'no-footage', reason: 'กล่องมีแต่ไฟล์เสียง/stub — ยังไม่มีฟุตเทจกล้อง' }
  }
  // v1.251 — "มีฟุตเทจ" ไม่พอ: ต้นฉบับ MXF อัปตามหลัง Sub/XML 1–2 วัน ทิ้งตอนนี้ = ต้นฉบับตกถังขยะ (PP-26-034)
  const pending = pendingOriginals(camera)
  if (pending.length > 0) {
    const shown = pending.slice(0, 5).join(', ') + (pending.length > 5 ? ` และอีก ${pending.length - 5}` : '')
    return { state: 'originals-pending', files, pending, reason: `ต้นฉบับยังมาไม่ครบ ${pending.length} คลิป: ${shown}` }
  }
  // for a sound-only job the evidence is the audio, not whatever strays sit beside it
  return { state: 'has-footage', files: opts.soundOnly ? audio : files }
}
