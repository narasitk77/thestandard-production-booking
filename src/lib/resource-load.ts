/**
 * v1.177 — "กล้องเต็ม / คนเต็ม" advisory load check.
 *
 * v1.61 already summed cameraCount across time-overlapping bookings against a
 * fixed pool of 9. This generalises that to the three pools the team actually
 * runs out of — cameras, ช่างวิดีโอ, สวิตเชอร์ — and adds the rule the old math
 * missed: gear coming back from an off-site shoot is NOT available the moment
 * that shoot wraps.
 *
 * Everything here is ADVISORY. Nothing blocks a booking: the producer is told
 * "this slot is over capacity, expect a rental / a freelancer", and admin does
 * the actual sourcing. That framing is deliberate — the producers do not own
 * the inventory and cannot resolve a shortage themselves, so a hard block would
 * only teach them to book around the warning.
 *
 * Pure module (no DB, no env reads): the DB layer feeds it rows and pool sizes,
 * which keeps the arithmetic testable and lets the client re-render the same
 * text the server computed.
 */
import { addMinutesClamped, effectiveWrap, timeWindowsOverlap } from '@/lib/shoot-window'

/**
 * How long gear and crew are still unavailable after an off-site wrap: teardown,
 * load-out, traffic, unload. The user's rule, in his words: a shoot that ends
 * off-site at 12:00 does NOT free its cameras for a 12:00 start — "นับเป็นไม่ทัน".
 *
 * 60 minutes is the starting figure; it is a single constant precisely so it can
 * be retuned once from real complaints rather than guessed per call site.
 */
export const TRAVEL_BUFFER_MIN = 60

/** Cameras the team owns. Pool sizes are passed in, this is only the fallback. */
export const CAMERA_POOL = 9

export type ShootTypeLike = string | null | undefined

/** A booking's occupancy of a time window, as far as shared resources care. */
export interface LoadSlot {
  callTime: string
  estimatedWrap?: string | null
  /** Prisma ShootType: STUDIO | ON_LOCATION | REMOTE_ONLINE | EVENT */
  shootType?: ShootTypeLike
  /**
   * Does this booking run across more than one day (shootEndDate > shootDate)?
   *
   * A multi-day job does not hand its cameras back each evening — they stay with
   * that crew until the job ends, as the team put it: "ถ้ามีงานไปหลายวัน 2 กล้อง
   * กล้องก็จะไม่ว่าง 2 ตัวจนกว่าจะจบงาน". So on every day it touches it occupies
   * the WHOLE day, not just call→wrap.
   */
  multiDay?: boolean
}

export interface LoadDemand extends LoadSlot {
  cameraCount?: number | null
  videographerCount?: number | null
  switcherCount?: number | null
  /**
   * The roles this booking actually asked for (Booking.crewRequired).
   *
   * REQUIRED for stored rows, because the headcounts alone lie: both
   * videographerCount and switcherCount default to 1 in the schema AND the
   * wizard posts 1 even when the role was never ticked. Summing them raw made
   * every booking in the system look like it wanted a videographer — the first
   * prod call read 9 ช่างวิดีโอ booked on a morning that had nowhere near that.
   *
   * Leave undefined only when the caller has already zeroed the counts itself
   * (the live wizard does exactly that as the producer ticks the boxes).
   */
  crewRequired?: string[] | null
}

export interface Pools {
  cameras: number
  videographers: number
  switchers: number
}

/**
 * Off-site = the gear physically leaves the building, so it owes travel time on
 * the way back. EVENT is included: an external event venue is a load-out too.
 * REMOTE_ONLINE is not — nothing travels.
 */
export function isOffSite(shootType: ShootTypeLike): boolean {
  const t = (shootType || '').trim().toUpperCase()
  return t === 'ON_LOCATION' || t === 'EVENT'
}

export interface Occupancy {
  start: string
  /** Wrap as entered, or call + 8h when nobody entered one. */
  wrap: string
  /** wrap + travel buffer for off-site shoots — when the gear is really back. */
  end: string
  /** True when the wrap time was estimated rather than entered. */
  estimated: boolean
  /** True when `end` was pushed out past `wrap` by the travel buffer. */
  travelPadded: boolean
}

/** When a slot really ties up cameras and crew, travel included. */
export function occupancyOf(slot: LoadSlot): Occupancy {
  const { end: wrap, estimated } = effectiveWrap(slot.callTime, slot.estimatedWrap)
  // A multi-day job keeps the kit overnight — it is out for the whole of every
  // day it touches, so no other shoot on those days can count on it.
  if (slot.multiDay) {
    return { start: '00:00', wrap: '23:59', end: '23:59', estimated, travelPadded: false }
  }
  const offSite = isOffSite(slot.shootType)
  return {
    start: slot.callTime,
    wrap,
    end: offSite ? addMinutesClamped(wrap, TRAVEL_BUFFER_MIN) : wrap,
    estimated,
    travelPadded: offSite,
  }
}

/** Do two slots compete for the same gear, travel time included? */
export function slotsCompete(a: LoadSlot, b: LoadSlot): boolean {
  const oa = occupancyOf(a)
  const ob = occupancyOf(b)
  return timeWindowsOverlap(oa.start, oa.end, ob.start, ob.end)
}

export type ResourceKey = 'cameras' | 'videographers' | 'switchers'

export interface ResourceLine {
  key: ResourceKey
  /** "กล้อง" / "ช่างวิดีโอ" / "สวิตเชอร์" */
  labelTh: string
  /** "ตัว" / "คน" */
  unitTh: string
  own: number
  others: number
  total: number
  pool: number
  over: boolean
  /** How many short — the extras that must be rented or freelanced. */
  shortBy: number
}

const RESOURCES: { key: ResourceKey; labelTh: string; unitTh: string; of: (d: LoadDemand) => number }[] = [
  { key: 'cameras', labelTh: 'กล้อง', unitTh: 'ตัว', of: d => num(d.cameraCount) },
  { key: 'videographers', labelTh: 'ช่างวิดีโอ', unitTh: 'คน', of: d => wants(d, 'Videographer') ? num(d.videographerCount) : 0 },
  { key: 'switchers', labelTh: 'สวิตเชอร์', unitTh: 'คน', of: d => wants(d, 'Switcher') ? num(d.switcherCount) : 0 },
]

/**
 * Did this booking ask for the role at all? An absent crewRequired means the
 * caller already resolved it (see LoadDemand.crewRequired); a present list is
 * authoritative, so a default-1 headcount on a booking that never wanted a
 * videographer contributes nothing.
 */
function wants(d: LoadDemand, role: string): boolean {
  if (d.crewRequired == null) return true
  return d.crewRequired.some(r => (r || '').trim().toLowerCase() === role.toLowerCase())
}

function num(v: number | null | undefined): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export interface LoadSummary {
  lines: ResourceLine[]
  /** Bookings whose window competes with the candidate's. */
  competing: number
  /**
   * An off-site shoot that only competes BECAUSE of the travel buffer — it wraps
   * at or before this shoot's call time, so on paper the slot looks free. Worth
   * naming separately: "ไม่ทัน" reads as a mistake unless you explain it.
   */
  travelTight: { wrap: string; call: string } | null
}

/**
 * Sum each pool across the candidate plus every competing booking.
 * `others` must already exclude the candidate itself (and cancelled/completed
 * work) — this function trusts the caller's row set and only does the math.
 */
export function summariseLoad(candidate: LoadDemand, others: LoadDemand[], pools: Pools): LoadSummary {
  const competing = others.filter(o => slotsCompete(candidate, o))

  let travelTight: LoadSummary['travelTight'] = null
  for (const o of competing) {
    const oc = occupancyOf(o)
    // Competes only thanks to the buffer: its real wrap is already past.
    if (oc.travelPadded && oc.wrap <= candidate.callTime) {
      travelTight = { wrap: oc.wrap, call: candidate.callTime }
      break
    }
  }

  const lines = RESOURCES.map(r => {
    const own = r.of(candidate)
    const otherSum = competing.reduce((sum, o) => sum + r.of(o), 0)
    const total = own + otherSum
    const pool = Math.max(0, Math.floor(pools[r.key] ?? 0))
    // Two guards, both learned from the first live run:
    //  - pool 0 means "we don't know the roster", not "we own nothing" — warning
    //    on that would spam every booking with a false shortage.
    //  - own 0 means this booking doesn't want that resource at all. Other jobs
    //    running the switchers dry is admin's problem, not something to put in
    //    front of a producer who never asked for a switcher.
    const over = pool > 0 && own > 0 && total > pool
    return {
      key: r.key, labelTh: r.labelTh, unitTh: r.unitTh,
      own, others: otherSum, total, pool, over,
      shortBy: over ? total - pool : 0,
    }
  })

  return { lines, competing: competing.length, travelTight }
}

/**
 * Who actually resolves a shortage. Shown to producers so a warning never reads
 * as a rejection; the admin views drop it, since admin IS the one sourcing.
 */
export const LOAD_ADVISORY_NOTE_TH =
  'หมายเหตุ: แจ้งให้ทราบเท่านั้น จองได้ตามปกติ — admin จะจัดหาอุปกรณ์และทีมงานให้'

/**
 * The shortage lines only, in the wording the team asked for. Returns [] when
 * everything fits — an empty array is the caller's cue to render nothing.
 *
 * Cameras (rent) are split from people (freelance) because the remedy differs.
 */
export function loadShortageLinesTh(summary: LoadSummary): string[] {
  const out: string[] = []
  for (const l of summary.lines) {
    if (!l.over) continue
    const detail = `ช่วงเวลานี้รวม ${l.total}/${l.pool} ${l.unitTh} (ของคุณ ${l.own} + งานอื่น ${l.others})`
    if (l.key === 'cameras') {
      out.push(`⚠️ กล้องเต็ม อาจมีการเช่าอุปกรณ์ — ${detail} ขาด ${l.shortBy} ${l.unitTh}`)
    } else {
      out.push(`⚠️ คนเต็มต้องจ้างฟรีแลนซ์ — ${l.labelTh} ${detail} ขาด ${l.shortBy} ${l.unitTh}`)
    }
  }
  if (out.length > 0 && summary.travelTight) {
    out.push(
      `⏱️ มีงานออกกองเลิก ${summary.travelTight.wrap} ต่อกับงานนี้ที่เริ่ม ${summary.travelTight.call} — ` +
      `กล้องกับทีมงานเดินทางกลับไม่ทัน ระบบจึงนับว่ายังไม่ว่าง`,
    )
  }
  return out
}

/** The producer-facing block: every shortage line, closed by who fixes it. */
export function loadWarningsTh(summary: LoadSummary): string[] {
  const lines = loadShortageLinesTh(summary)
  return lines.length > 0 ? [...lines, LOAD_ADVISORY_NOTE_TH] : []
}
