/**
 * v1.288 — การ์ด Sony ที่เข้า NAS ไม่ครบ: รู้ตั้งแต่ก็อปเสร็จ ไม่ต้องรออัปขึ้น Drive (นัท 12 พ.ย. 2569 "ให้ตัวสแกน NAS ตรวจ MEDIAPRO
 * ได้ตั้งแต่ไฟล์เข้า NAS — โอเค")
 *
 * ตัวสแกนบน NAS (scripts/nas_manifest_agent.py) อ่าน MEDIAPRO.XML ของการ์ดที่เพิ่งลง NAS แล้วส่งรายชื่อต้นฉบับมากับ manifest
 * ทุกนาที · NAS เป็น "คิวส่ง" (Cloud Sync อัปแล้วลบ) จึงต้องจำว่าต้นฉบับไหน "เคยเข้า NAS" ข้าม manifest
 * การ์ดที่ไม่มีไฟล์เข้า/โต/เขียน (รวมไฟล์ซ่อนของ rsync) มา CARD_QUIET_MS = ก็อปจบแล้ว → ต้นฉบับที่ MEDIAPRO ระบุแต่ไม่เคยเข้า NAS
 * และไม่อยู่ในโฟลเดอร์ Drive ของใบนี้ = ก็อปจากการ์ดไม่ครบ → บอกทีมทันที ตอนการ์ดยังอยู่ในมือ (AGN-260929-01: MXF 144 GB หาย
 * รู้ตอนอัปเสร็จแล้ว)
 *
 * ด่าน "ไฟล์พร้อม" บน Drive (mediapro.ts) ยังเป็นตัวตัดสินเหมือนเดิม — ตัวนี้แค่เตือนเร็ว ไม่ได้อนุญาตหรือกันการแจ้งอะไร
 * กฎชื่อเหมือนด่านนั้น: ชื่อ FX6 (reel+วันที่) ไม่ซ้ำ → จับคู่ที่ไหนก็ได้ · C0001 ซ้ำทุกการ์ด → ต้องอยู่ path เดียวกันของการ์ด
 */
import { baseName, hasUniqueClipName } from './footage-completeness'
import { clipDate, yearBefore } from './mediapro'

export interface NasCardReport { dir: string; origs?: string[]; error?: string }

export interface CardState {
  folder: string
  dir: string
  code: string | null
  origs: string[]
  /** originals (path under the card dir) seen on the NAS at least once — FX6 names anywhere on the NAS count (review v1.288) */
  seen: string[]
  firstAt: string
  /** last time a file under the card dir appeared, grew or was written (removals by the upload are not arrivals) */
  arrivedAt: string
  /** newest file write the agent reported for the card's NAS folder (epoch s, hidden temp files included) */
  lastWrite?: number
  /** the card's folder is in the current manifest — a folder left out (unreadable) or gone is never judged on old data */
  present?: boolean
  /** the folder's listing hit the agent's cap — what is "not seen" may just be unlisted: never judged */
  truncated?: boolean
  error?: string
  /** the missing set already announced (sorted, joined) — a new gap is news, the same one is not */
  alerted?: string
  /** an unreadable MEDIAPRO already told to ops */
  alertedUnreadable?: boolean
  /** could not be judged or told (Drive listing failed / too large, chat down): not before this — no Drive re-listing every minute */
  retryAfter?: string
}

/** back-off for a card that could not be judged or announced this time */
export const CARD_RETRY_MS = 15 * 60_000

/** copy finished = no new / grown / written file under the card for this long */
export const CARD_QUIET_MS = 10 * 60_000
/** forget a card this long after it first appeared */
export const CARD_KEEP_MS = 7 * 24 * 3_600_000

type Folder = { name: string; files: Array<{ p: string; size: number }>; cards?: NasCardReport[]; truncated?: boolean; lastWrite?: number }

const under = (dir: string, p: string) => (dir ? p.startsWith(`${dir}/`) : true)
const rel = (dir: string, p: string) => (dir ? p.slice(dir.length + 1) : p)
const nameOf = (p: string) => baseName(p.split('/').pop() || '').toUpperCase()
/** FX6 reel+date names are unique in the whole box; hasUniqueClipName wants the bare file name, not the card path */
const uniqueName = (p: string) => hasUniqueClipName(p.split('/').pop() || '')

/**
 * Fold one manifest into the remembered card states. Pure.
 * `prev` = the previous manifest's folders (to tell a NEW/grown file from one still sitting there).
 */
export function updateCardStates(
  states: Record<string, CardState>,
  folders: Folder[],
  prev: Folder[] | null | undefined,
  codeOf: (folderName: string) => string | null,
  now: Date,
): Record<string, CardState> {
  const at = now.toISOString()
  const out: Record<string, CardState> = {}
  for (const [k, s] of Object.entries(states || {})) {
    if (now.getTime() - Date.parse(s.firstAt) < CARD_KEEP_MS) out[k] = { ...s }
  }
  const before = new Map<string, Map<string, number>>()
  for (const f of prev || []) before.set(f.name, new Map(f.files.map(x => [x.p, x.size])))
  // FX6 names are unique: one sitting in ANY folder of this manifest reached the NAS (a split card, a re-dump into
  // another folder, a "(1)" sync twin, a renamed folder) — the Drive gate matches them anywhere too
  const everywhere = new Set(folders.flatMap(f => f.files.map(x => nameOf(x.p))))
  for (const s of Object.values(out)) s.present = false
  for (const f of folders) {
    for (const c of f.cards || []) {
      const key = `${f.name}|${c.dir}`
      let cur: CardState | undefined = out[key]
      // a DIFFERENT card copied into the same folder (no original in common): a new card, not the old one's history
      if (cur && c.origs?.length && cur.origs.length && !c.origs.some(o => cur!.origs.includes(o))) cur = undefined
      out[key] = {
        ...(cur || {}),
        folder: f.name, dir: c.dir, code: codeOf(f.name),
        origs: c.origs && c.origs.length ? c.origs : cur?.origs || [],
        seen: cur?.seen || [],
        firstAt: cur?.firstAt || at,
        arrivedAt: cur?.arrivedAt || at,
      }
      if (c.error) out[key].error = c.error
      else delete out[key].error
    }
    const was = before.get(f.name)
    for (const s of Object.values(out)) {
      if (s.folder !== f.name) continue
      s.present = true
      s.truncated = !!f.truncated
      // any write in the folder — hidden temp files too — means a copy may still be running (delay only, never an alert)
      if (typeof f.lastWrite === 'number') {
        if (s.lastWrite != null && f.lastWrite > s.lastWrite) s.arrivedAt = at
        s.lastWrite = Math.max(f.lastWrite, s.lastWrite || 0)
      }
      const here = f.files.filter(x => under(s.dir, x.p))
      if (here.some(x => !was || !was.has(x.p) || (was.get(x.p) || 0) < x.size)) s.arrivedAt = at
      const seen = new Set(s.seen)
      for (const x of here) if (s.origs.includes(rel(s.dir, x.p))) seen.add(rel(s.dir, x.p))
      s.seen = [...seen].sort()
    }
  }
  for (const s of Object.values(out)) {
    const seen = new Set(s.seen)
    for (const o of s.origs) if (uniqueName(o) && everywhere.has(nameOf(o))) seen.add(o)
    s.seen = [...seen].sort()
  }
  return out
}

/** an absent clip dated before the shoot (but within a year — older = a reset camera clock, unknown) = an earlier job's leftover */
const earlierShoot = (orig: string, from: string | null) => {
  const d = clipDate(baseName(orig.split('/').pop() || ''))
  return !!(from && d && d < from && d >= yearBefore(from))
}

/**
 * Cards whose copy finished with originals that never reached the NAS — before the Drive check.
 * `shootFrom(code)` = the booking's first shoot day (the v1.260 rule, same bounds as the Drive gate).
 */
export function quietShortCards(
  states: Record<string, CardState>,
  now: Date,
  shootFrom: (code: string | null) => string | null,
): Array<{ key: string; state: CardState; missing: string[] }> {
  const out: Array<{ key: string; state: CardState; missing: string[] }> = []
  for (const [key, s] of Object.entries(states)) {
    if (!s.origs.length || s.truncated || !s.present || now.getTime() - Date.parse(s.arrivedAt) < CARD_QUIET_MS) continue
    if (s.retryAfter && Date.parse(s.retryAfter) > now.getTime()) continue
    const from = shootFrom(s.code)
    const missing = s.origs.filter(o => !s.seen.includes(o) && !earlierShoot(o, from))
    if (missing.length && missing.slice().sort().join('|') !== s.alerted) out.push({ key, state: s, missing })
  }
  return out
}

/** Quiet cards whose MEDIAPRO never parsed and that ops was not told about yet. */
export function quietUnreadableCards(states: Record<string, CardState>, now: Date): Array<{ key: string; state: CardState }> {
  return Object.entries(states)
    .filter(([, s]) => s.error && !s.origs.length && s.present && !s.alertedUnreadable && now.getTime() - Date.parse(s.arrivedAt) >= CARD_QUIET_MS)
    .map(([key, state]) => ({ key, state }))
}

// Folder names drift between the NAS/landing and the box (review v1.288): an EP retitled after the landing was made
// ("EP01 · old" vs "EP01 · new"), folder-integrity's "Cam A" → "CAM-A", a sync-storm "M4ROOT (1)". Paths are compared
// segment by segment after: " (n)" stripped · camera folders canonical (card suffix kept: "CAM A-2" ≠ "CAM-A-1") ·
// EP folders by their lead ("EP01").
const CAM_SEG = /^CAM(?:ERA)?[\s._-]*([A-Z]|\d{1,2})(?:[\s._-]*(\d{1,2}))?$/
export function normSeg(seg: string): string {
  const s = seg.trim().replace(/(?:\s*\(\d+\))+$/, '').trim().toUpperCase()
  const cam = CAM_SEG.exec(s)
  if (cam) return `CAM-${cam[1]}${cam[2] ? `-${cam[2]}` : ''}`
  return s.includes(' · ') ? s.split(' · ')[0].trim() : s
}
const normPath = (segs: string[]) => segs.filter(Boolean).map(normSeg).join('/')

/**
 * Which `missing` originals are NOT in this booking's own Drive folders (landing / box / staging), given their listing.
 * FX6 names: anywhere in those folders. C0001-style names restart on every card: only at the card's own path — and
 * only once that path is PROVEN on Drive by this card's own MEDIAPRO.XML (copied first, moved with the card): if it is
 * not found there, the mapping cannot be trusted → null = cannot judge (never "missing").
 */
export function notOnDrive(missing: string[], dir: string, drive: Array<{ name: string; folderPath?: string[] }>): string[] | null {
  const names = new Set(drive.map(f => baseName(f.name).toUpperCase()))
  const paths = new Set(drive.map(f => normPath([...(f.folderPath || []), baseName(f.name)])))
  const cardSegs = dir ? dir.split('/') : []
  if (missing.some(o => !uniqueName(o)) && !paths.has(normPath([...cardSegs, 'MEDIAPRO.XML']))) return null
  return missing.filter(o => {
    if (uniqueName(o)) return !names.has(nameOf(o))
    return !paths.has(normPath([...cardSegs, ...o.split('/').slice(0, -1), baseName(o.split('/').pop() || '')]))
  })
}

export function shortCardText(s: CardState, missing: string[]): string {
  const names = missing.slice(0, 4).map(m => m.split('/').pop()).join(', ') + (missing.length > 4 ? ` …+${missing.length - 4}` : '')
  return `⚠️ การ์ดเข้า NAS ไม่ครบ — ${s.folder}\n` +
    `${s.dir || '(ราก)'}: MEDIAPRO ระบุต้นฉบับ ${s.origs.length} คลิป · ไม่เคยเข้า NAS และไม่อยู่ในโฟลเดอร์ Drive ของงานนี้ ${missing.length} คลิป (${names})\n` +
    'ก็อปการ์ดนี้ลง NAS ใหม่อีกรอบ · อย่าเพิ่ง format การ์ด'
}
