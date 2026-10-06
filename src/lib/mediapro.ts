/**
 * v1.254 — การ์ด Sony ครบตาม MEDIAPRO.XML หรือยัง (กฎเดียว ใช้ทั้งด่าน "ไฟล์พร้อม" และตรวจฟุตเทจรายวัน)
 *
 * ที่มา (นัท 2 ต.ค. 2569): ระบบแจ้ง "footage พร้อม" ทั้งที่ NAS กับคอมหลุดกันกลางการก็อป — ด่านเดิมดูแค่
 * "มีไฟล์ + จำนวนไม่ขยับ 2 ชม." ซึ่งการ์ดที่ก็อปค้างครึ่งทางก็ผ่าน · ย้อนดู 20 ใบที่ถูกแจ้งใน 30 วัน: AGN-260929-01
 * (ขาด C022C001…MXF 144 GB) · AGN-260930-01 (ขาด MXF/XML · ไฟล์ 0 ไบต์ · โฟลเดอร์ "A024 (1) (1)…" จากการก็อปซ้ำ) ·
 * TSS-TSS-261001-01 (ขาด 9/20 ไฟล์) · การ์ด Sony ไม่มี MEDIAPRO เลย 4 การ์ด
 *
 * MEDIAPRO.XML = ดัชนีที่กล้องเขียนลงการ์ด: ทุกคลิปมี `<Material uri="./Clip/X.MXF" dur=…>` + `<Proxy uri="./Sub/XS03.MP4">`
 * + `<RelevantInfo uri="./Clip/XM01.XML">` / `./Thmbnl/XT01.JPG` → **ทุกไฟล์ที่ระบุต้องอยู่ในกล่อง** (กฎของนัท)
 *
 * - หาไฟล์ตาม path จาก MEDIAPRO ก่อน ไม่เจอค่อยหาชื่อเดียวกันใน EP เดียวกัน (การ์ดที่ถูกก็อปซ้ำ/ย้ายโฟลเดอร์ยังนับ) ·
 *   ชื่อที่ซ้ำได้ (C0001) ต้องอยู่ EP/กล้องเดียวกัน · ใช้ตัวที่ใหญ่สุดเมื่อมีหลายสำเนา
 * - ขนาดต่อเฟรม (size ÷ dur) ต่ำกว่าครึ่งของคลิปแบบเดียวกัน (videoType+fps ≥3 คลิป) = น่าจะก็อปไม่จบ —
 *   วัดจากของจริง 16 กล่อง: คลิปครบต่ำสุด 0.65× (ช่วงสูงกว่ามีได้ถึง 18× ในคลิปสั้น ๆ จึงดูแค่ขาต่ำ)
 * - การ์ด Sony (XDROOT/M4ROOT หรือโฟลเดอร์ Clip ที่มีไฟล์ชื่อกล้อง Sony) ที่ไม่มี MEDIAPRO.XML = ตรวจไม่ได้ ≠ ครบ
 * - กล้องที่ไม่ใช่ Sony ไม่มี MEDIAPRO → ไม่มีอะไรให้เทียบ (ด่านนี้ผ่าน · ด่านอื่นเดิมยังทำงาน)
 *   ponytail: การ์ดที่ไม่ได้ format ข้ามวันจะมีคลิปวันก่อนใน MEDIAPRO — ก็อปแค่บางคลิป = ถูกหาว่าขาด (ทางปลอดภัย:
 *   แค่ไม่แจ้งอัตโนมัติ · 📣 แจ้งมือยังใช้ได้) · ถ้าเจอบ่อยให้กรองด้วยวันที่ในชื่อคลิป
 */
import { baseName, hasUniqueClipName, isQuarantined, sonyClipPart, type FootageFileLike } from './footage-completeness'
import { listFilesRecursive, downloadDriveFile, type DriveFile } from './google-drive'

export interface MediaproMaterial {
  uri: string
  dur: number
  fps: string
  videoType: string
  /** every file the card says belongs to this clip, relative to the MEDIAPRO folder (`Clip/X.MXF`, `Sub/XS03.MP4`, …) */
  files: string[]
}

export interface MediaproCard {
  /** folder that holds MEDIAPRO.XML, from the box root */
  folderPath: string[]
  materials: MediaproMaterial[]
}

export interface MediaproCheck {
  cards: number
  listed: number
  missing: Array<{ card: string; cardPath: string[]; file: string }>
  /** v1.260 — listed, absent, and dated BEFORE the shoot: left on a card that was not formatted after an earlier shoot (not this booking's loss) */
  stale: Array<{ card: string; file: string; date: string }>
  zero: Array<{ card: string; file: string; id?: string }>
  suspect: Array<{ card: string; file: string; ratio: number; id?: string }>
  /** Sony card roots with no MEDIAPRO.XML, and folders holding Sony originals no MEDIAPRO lists — cannot be verified */
  unverifiable: string[]
  unverifiablePaths: string[][]
}

type FileLike = FootageFileLike & { size?: number | null; id?: string }

export const isMediaproFile = (name: string) => /^MEDIAPRO\.XML$/i.test(baseName(name.trim()))

const attr = (s: string, k: string) => (s.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] || ''
const rel = (uri: string) => (uri.startsWith('./') ? uri.slice(2) : null)

/** อ่านไม่ได้ = throw (ห้ามคืนรายการว่าง — การ์ดที่ "ไม่มีคลิป" จะผ่านด่านไปเงียบ ๆ) */
export function parseMediapro(xml: string): MediaproMaterial[] {
  if (!/<MediaProfile\b/.test(xml)) throw new Error('ไม่ใช่ MEDIAPRO.XML (ไม่มี <MediaProfile>)')
  const out: MediaproMaterial[] = []
  for (const m of xml.matchAll(/<Material\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Material>)/g)) {
    const own = rel(attr(m[1], 'uri'))
    if (!own) continue
    const files = [own]
    for (const p of (m[2] || '').matchAll(/<(?:Proxy|RelevantInfo|Component)\b([^>]*?)\/?>/g)) {
      const r = rel(attr(p[1], 'uri'))
      if (r && !files.includes(r)) files.push(r)
    }
    out.push({ uri: own, dur: Number(attr(m[1], 'dur')) || 0, fps: attr(m[1], 'fps'), videoType: attr(m[1], 'videoType'), files })
  }
  return out
}

const up = (s: string) => s.trim().toUpperCase()
const pathKey = (segs: string[]) => segs.map(up).join('/')
/** YYMMDD in an FX6/FX3 clip name → YYYY-MM-DD (null for C0001-style names) */
const clipDate = (name: string) => { const m = /^[A-Z]\d{3}[A-Z]\d{3}_(\d{2})(\d{2})(\d{2})/i.exec(name); return m ? `20${m[1]}-${m[2]}-${m[3]}` : null }
/** a camera whose clock was reset stamps 2021-01-01 — older than a year before the shoot is not "an earlier shoot", it is unknown */
const yearBefore = (day: string) => new Date(Date.parse(day) - 366 * 864e5).toISOString().slice(0, 10)

export interface MediaproCheckOptions {
  /**
   * v1.260 — first shoot day (YYYY-MM-DD). A listed file that is absent AND whose clip name is dated before this day
   * was left on an unformatted card by an earlier shoot (AGN-260713-02 was "missing" 416 files all dated 9 Jul,
   * all sitting in TSS-TSL-260709-03's box) → `stale`, not `missing`. Clips dated inside or after the window stay
   * `missing`. Without a date the rule is unchanged. Trade-off: a booking whose date is wrong hides a loss of
   * earlier-dated clips from the gate — they still show in the daily Doc as "ข้ามคลิปก่อนวันถ่าย".
   */
  shootFrom?: string
}

/** การ์ด Sony ในกล่อง: โฟลเดอร์ XDROOT/M4ROOT · หรือโฟลเดอร์แม่ของ Clip ที่มีต้นฉบับชื่อกล้อง Sony (การ์ดที่ถูกก็อปแบบแบน) */
export function sonyCardRoots(files: FileLike[]): string[][] {
  const roots = new Map<string, string[]>()
  for (const f of files) {
    if (isQuarantined(f)) continue
    const fp = f.folderPath || []
    const i = fp.findIndex(s => /^(XDROOT|M4ROOT)$/i.test(s.trim()))
    if (i >= 0) { roots.set(pathKey(fp.slice(0, i + 1)), fp.slice(0, i + 1)); continue }
    if (fp.length && up(fp[fp.length - 1]) === 'CLIP' && sonyClipPart(f.name)?.part === 'orig') {
      roots.set(pathKey(fp.slice(0, -1)), fp.slice(0, -1))
    }
  }
  return [...roots.values()]
}

export function mediaproCheck(files: FileLike[], cards: MediaproCard[], opts: MediaproCheckOptions = {}): MediaproCheck {
  const live = files.filter(f => !isQuarantined(f))
  const byPath = new Map<string, FileLike[]>()
  const byName = new Map<string, FileLike[]>()
  const push = (m: Map<string, FileLike[]>, k: string, f: FileLike) => m.set(k, [...(m.get(k) || []), f])
  for (const f of live) {
    const name = up(baseName(f.name))
    push(byPath, pathKey([...(f.folderPath || []), name]), f)
    push(byName, name, f)
  }
  // FX6/FX3 names carry reel+date → unique in the whole box (a card split across EPs, copied twice,
  // a clip moved to "Clip (1)" — AGN-260911-01 put one card's clips in EP.2 and EP.3); C0001 restarts on
  // every card → only inside that card folder; anything else → the same EP.
  const scopeOf = (card: string[], name: string) => (hasUniqueClipName(name) ? [] : /^C\d{4}/i.test(name) ? card : card.slice(0, 1))
  const inScope = (f: FileLike, scope: string[]) => pathKey((f.folderPath || []).slice(0, scope.length)) === pathKey(scope)
  const biggest = (fs: FileLike[]) => fs.reduce<FileLike | null>((a, f) => (!a || (f.size || 0) > (a.size || 0) ? f : a), null)

  const res: MediaproCheck = { cards: cards.length, listed: 0, missing: [], stale: [], zero: [], suspect: [], unverifiable: [], unverifiablePaths: [] }
  const seen = new Set<string>()
  const listedIn = new Map<string, string[][]>()
  const ratios: Array<{ key: string; card: string; file: string; ratio: number; id?: string }> = []
  for (const card of cards) {
    const where = card.folderPath.join('/')
    for (const mat of card.materials) {
      const entries = mat.files.map(r => {
        const segs = r.split('/')
        const name = up(baseName(segs[segs.length - 1]))
        const scope = scopeOf(card.folderPath, name)
        const hits = byPath.get(pathKey([...card.folderPath, ...segs.slice(0, -1), name]))
          || (byName.get(name) || []).filter(f => inScope(f, scope))
        return { r, name, scope, best: biggest(hits) }
      })
      // stale = none of the clip's MEDIA (original / Sub) is here. A Sub present with the original absent is a
      // half-copied clip of THIS box, whatever the date says. Thumbnail/XML alone do not count: THMBNL is copied
      // as a whole folder and carries the earlier shoot's JPGs along (TSS-ODK-260828-01 kept 46 thumbnails of 26 Aug).
      const wholeClipAbsent = !entries.some(e => e.best && ['orig', 'sub'].includes(sonyClipPart(e.name)?.part || ''))
      for (const { r, name, scope, best } of entries) {
        const dedupe = `${pathKey(scope)}|${name}`
        listedIn.set(name, [...(listedIn.get(name) || []), scope])
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        res.listed++
        if (!best) {
          const date = opts.shootFrom && wholeClipAbsent ? clipDate(name) : null
          if (date && date < opts.shootFrom! && date >= yearBefore(opts.shootFrom!)) res.stale.push({ card: where, file: r, date })
          else res.missing.push({ card: where, cardPath: card.folderPath, file: r })
          continue
        }
        if (!best.size) { res.zero.push({ card: where, file: r, id: best.id }); continue }
        if (r === mat.uri && mat.dur > 0) ratios.push({ key: `${mat.videoType}|${mat.fps}`, card: where, file: r, ratio: best.size / mat.dur, id: best.id })
      }
    }
  }
  const groups = new Map<string, number[]>()
  for (const x of ratios) groups.set(x.key, [...(groups.get(x.key) || []), x.ratio])
  for (const x of ratios) {
    const g = (groups.get(x.key) || []).slice().sort((a, b) => a - b)
    if (g.length < 3) continue
    const median = g[Math.floor(g.length / 2)]
    if (x.ratio < 0.5 * median) res.suspect.push({ card: x.card, file: x.file, id: x.id, ratio: Math.round((x.ratio / median) * 100) / 100 })
  }
  const covered = new Set(cards.map(c => pathKey(c.folderPath)))
  const roots = sonyCardRoots(live).filter(r => !covered.has(pathKey(r)))
  // The reverse direction: a Sony original that no card lists cannot be verified either — a renamed
  // "Clip (1) (1)", an MXF loose in CAM-B, a merged card whose MEDIAPRO was replaced or saved as
  // "MEDIAPRO (1).XML". Reported per folder, once (not again under a root already reported).
  const unlisted = new Map<string, string[]>()
  for (const f of live) {
    if (sonyClipPart(f.name)?.part !== 'orig') continue
    if ((listedIn.get(up(baseName(f.name))) || []).some(s => inScope(f, s))) continue
    const fp = f.folderPath || []
    if (roots.some(r => pathKey(fp.slice(0, r.length)) === pathKey(r))) continue
    unlisted.set(pathKey(fp), fp)
  }
  res.unverifiablePaths = [...roots, ...unlisted.values()]
  res.unverifiable = res.unverifiablePaths.map(r => r.join('/'))
  return res
}

export const mediaproComplete = (c: MediaproCheck) =>
  !c.missing.length && !c.zero.length && !c.suspect.length && !c.unverifiable.length

/** One Thai line: why it is not complete (empty when complete). */
export function mediaproGapText(c: MediaproCheck): string {
  const tail = (xs: Array<{ file: string }>) => xs.slice(0, 3).map(x => x.file.split('/').pop()).join(', ') + (xs.length > 3 ? ` …+${xs.length - 3}` : '')
  return [
    c.missing.length ? `ขาด ${c.missing.length} ไฟล์ตาม MEDIAPRO (${tail(c.missing)})` : '',
    c.zero.length ? `0 ไบต์ ${c.zero.length} (${tail(c.zero)})` : '',
    c.suspect.length ? `น่าจะก็อปไม่จบ ${c.suspect.length} (${tail(c.suspect)})` : '',
    c.unverifiable.length ? `การ์ด Sony ไม่มี MEDIAPRO.XML ${c.unverifiable.length} การ์ด (${c.unverifiable.slice(0, 2).map(p => p.split('/').slice(-2).join('/')).join(', ')})` : '',
    mediaproStaleText(c),
  ].filter(Boolean).join(' · ')
}

/** v1.260 — informational, never blocks: clips an unformatted card still listed from an earlier shoot. */
export const mediaproStaleText = (c: MediaproCheck) =>
  c.stale.length ? `ข้ามคลิปก่อนวันถ่าย ${c.stale.length} ไฟล์ (${[...new Set(c.stale.map(s => s.date))].sort().join(', ')} — น่าจะการ์ดไม่ได้ format · ถ้าวันถ่ายในใบผิด ไฟล์พวกนี้คือของที่ขาด)` : ''

// ── Drive ────────────────────────────────────────────────────────────────────

/** Download + parse every MEDIAPRO.XML (identical copies — same md5 — once). Any failure THROWS. */
export async function loadMediaproCards(files: DriveFile[]): Promise<MediaproCard[]> {
  const parsed = new Map<string, Promise<MediaproMaterial[]>>()
  const cards: MediaproCard[] = []
  for (const f of files) {
    if (isQuarantined(f) || !isMediaproFile(f.name)) continue
    const key = f.md5 || f.id
    if (!parsed.has(key)) parsed.set(key, downloadDriveFile(f.id).then(b => parseMediapro(b.toString('utf8'))))
    cards.push({ folderPath: f.folderPath, materials: await parsed.get(key)! })
  }
  return cards
}

/**
 * The "footage ready" gate: walk the folders, read every MEDIAPRO, and say ok only
 * when every file the cards list is in place. Any error = not ok, with the reason —
 * a check that could not run must never read as "complete".
 */
export async function mediaproGate(folderIds: string[], opts: MediaproCheckOptions = {}): Promise<{ ok: boolean; text: string; check: MediaproCheck | null }> {
  try {
    if (!folderIds.length) return { ok: false, text: 'ไม่มีโฟลเดอร์ให้ตรวจ MEDIAPRO', check: null }
    const files: DriveFile[] = []
    for (const id of folderIds) {
      const list = await listFilesRecursive(id, { maxFiles: 20000 })
      if (list.length >= 20000) return { ok: false, text: 'ไฟล์เกิน 20000 — ตรวจ MEDIAPRO ไม่ครบ', check: null }
      files.push(...list)
    }
    // A dead/empty folder walks to [] — that is "could not check", never "no Sony card, fine".
    if (!files.some(f => !/^_SHOOT\b.*\.txt$/i.test(f.name))) return { ok: false, text: 'โฟลเดอร์ที่ตรวจไม่มีไฟล์ (ว่างหรืออยู่ในถังขยะ) — ตรวจ MEDIAPRO ไม่ได้', check: null }
    const check = mediaproCheck(files, await loadMediaproCards(files), opts)
    const ok = mediaproComplete(check)
    return {
      ok, check,
      text: ok
        ? [check.cards ? `ครบตาม MEDIAPRO ${check.cards} การ์ด · ${check.listed - check.stale.length} ไฟล์` : 'ไม่มีการ์ด Sony (ไม่มี MEDIAPRO ให้เทียบ)', mediaproStaleText(check)].filter(Boolean).join(' · ')
        : mediaproGapText(check),
    }
  } catch (e: any) {
    return { ok: false, text: `ตรวจ MEDIAPRO ไม่ได้: ${e?.message || e}`, check: null }
  }
}
