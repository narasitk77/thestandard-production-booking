/**
 * v1.154 — "วัด id-first ก่อน": measure how often a per-booking folder resolve
 * still falls back from the stored Drive ID (fast, rename-proof) to matching by
 * the immutable Production ID embedded in the folder name.
 *
 * A fallback is not a bug — folderNameMatchesCode matches the IMMUTABLE code, so
 * it's safe. But every fallback means Booking.driveFolders is still empty for
 * that booking+folder-type, i.e. an id-first BACKFILL candidate. Counting them
 * turns "id-first is ~90% done" into a measured number that should trend to zero
 * as backfill runs and touched bookings self-heal.
 *
 * Pure observation: noteResolve NEVER affects the resolve it measures. Counters
 * are in-memory (workers share one container) and are cleared when the daily
 * digest reads them, so the figure reads as "fallbacks since the last summary".
 */

interface Bucket {
  hit: number // resolved via the stored driveFolders id (id-first fast path)
  fallback: number // stored id absent/dead → resolved by Production-ID name match
  codes: Set<string> // booking codes that fell back (the backfill candidates)
}

const buckets = new Map<string, Bucket>()

function bucketFor(key: string): Bucket {
  let b = buckets.get(key)
  if (!b) {
    b = { hit: 0, fallback: 0, codes: new Set() }
    buckets.set(key, b)
  }
  return b
}

/**
 * Record one folder resolve.
 *   subsystem — 'video-merge' | 'sound-merge' | …
 *   kind      — 'landing' | 'box' | 'staging'
 *   usedStoredId — true when the stored driveFolders id was present AND alive
 *                  (the id-first fast path); false when we resolved via the
 *                  Production-ID name fallback instead.
 * Call ONLY when a folder was actually resolved — never for a "not found at all"
 * skip, which is neither a hit nor a fallback.
 */
export function noteResolve(subsystem: string, kind: string, code: string | null, usedStoredId: boolean): void {
  const b = bucketFor(`${subsystem}:${kind}`)
  if (usedStoredId) {
    b.hit++
  } else {
    b.fallback++
    if (code) b.codes.add(code)
  }
}

export interface IdFirstBucket { key: string; hit: number; fallback: number; codes: string[] }
export interface IdFirstSnapshot { totalHit: number; totalFallback: number; buckets: IdFirstBucket[] }

/** Read the counters, most-fallback-first. Pass reset=true to clear them. */
export function snapshotIdFirst(reset = false): IdFirstSnapshot {
  const out: IdFirstBucket[] = []
  let totalHit = 0
  let totalFallback = 0
  for (const [key, b] of Array.from(buckets.entries())) {
    totalHit += b.hit
    totalFallback += b.fallback
    out.push({ key, hit: b.hit, fallback: b.fallback, codes: Array.from(b.codes) })
  }
  out.sort((a, b) => b.fallback - a.fallback || a.key.localeCompare(b.key))
  if (reset) buckets.clear()
  return { totalHit, totalFallback, buckets: out }
}

/**
 * v1.158 — the PUBLIC view of a gauge snapshot (live or one persisted in the
 * audit log): aggregates only, booking codes reduced to a count. Served by the
 * unauthenticated /api/internal/id-first-stats endpoint so an external monitor
 * can watch the fallback trend without a shared secret — so it must never leak
 * codes or names. Tolerates junk shapes (returns zeros) because audit rows are
 * read back as untyped JSON.
 */
export interface PublicGaugeView { totalHit: number; totalFallback: number; buckets: Array<{ key: string; hit: number; fallback: number; codeCount: number }> }
export function publicGaugeView(snap: unknown): PublicGaugeView {
  const s = (snap && typeof snap === 'object' ? snap : {}) as Record<string, any>
  const rawBuckets = Array.isArray(s.buckets) ? s.buckets : []
  const buckets = rawBuckets
    .filter((b: any) => b && typeof b === 'object' && typeof b.key === 'string')
    .map((b: any) => ({
      key: b.key,
      hit: Number(b.hit) || 0,
      fallback: Number(b.fallback) || 0,
      codeCount: Array.isArray(b.codes) ? b.codes.length : Number(b.codeCount) || 0,
    }))
  return {
    totalHit: Number(s.totalHit) || 0,
    totalFallback: Number(s.totalFallback) || 0,
    buckets,
  }
}

/**
 * Format the snapshot as a Discord digest section, or null when nothing was
 * measured (no merges ran this period → don't post an empty line).
 */
export function formatIdFirstDigest(s: IdFirstSnapshot): string | null {
  const total = s.totalHit + s.totalFallback
  if (total === 0) return null
  const pct = Math.round((s.totalHit / total) * 100)
  const lines: string[] = []
  lines.push(`🔗 **id-first (เส้นทางหา folder)** — ${pct}% ใช้ stored ID`)
  if (s.totalFallback === 0) {
    lines.push('ทุก resolve ใช้ stored ID แล้ว ไม่มีการหาโฟลเดอร์ด้วยชื่อเลย 🎉')
    return lines.join('\n')
  }
  for (const b of s.buckets) {
    if (b.fallback === 0) continue
    const sample = b.codes.slice(0, 6).join(', ')
    const more = b.codes.length > 6 ? ` +${b.codes.length - 6}` : ''
    const who = sample ? ` (ยังไม่มี link: ${sample}${more})` : ''
    lines.push(`• ${b.key}: stored ${b.hit} / fallback **${b.fallback}**${who}`)
  }
  lines.push(`รวม fallback ${s.totalFallback} ครั้ง — backfill โฟลเดอร์พวกนี้แล้วจะเหลือ 0`)
  return lines.join('\n')
}
