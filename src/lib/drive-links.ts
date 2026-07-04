/**
 * v1.114 — id-first Drive linkage ("ลดความซับซ้อน").
 *
 * The system used to join bookings ↔ Drive folders by NAME, so every rename,
 * sanitize ("A: B" → "A B"), or ops hand-move broke detection/merges and grew
 * another fallback layer. From now on, whenever the app CREATES or successfully
 * RESOLVES a booking folder it remembers the immutable Drive folder ID on the
 * booking row (Booking.driveFolders Json). Readers try the stored ID first
 * (verifying it's alive) and only then fall back to the legacy name walk — so
 * bookings without stored IDs behave exactly as before, and touched bookings
 * self-heal into the fast path. Renames/moves keep Drive IDs, so nothing to
 * update on regenerate/reprogram.
 *
 * Keys:
 *   box     — the per-booking VIDEO box (for AGN: the booking layer INSIDE the
 *             project box, NOT the shared project box)
 *   landing — the flat Production Team (NAS drop) folder
 *   staging — the _SOUND-STAGING folder
 *   photo   — the Photographer Shared Drive album folder
 */
import { prisma } from './db'

export type DriveLinkKey = 'box' | 'landing' | 'staging' | 'photo'

const KEYS: DriveLinkKey[] = ['box', 'landing', 'staging', 'photo']

/** A plausible Drive file id: URL-safe token, no spaces/slashes. */
function isDriveId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{10,80}$/.test(v)
}

/** Read one stored link off a booking's driveFolders json — null when absent
 *  or malformed (never throws on junk shapes). */
export function getDriveLink(driveFolders: unknown, key: DriveLinkKey): string | null {
  if (!driveFolders || typeof driveFolders !== 'object' || Array.isArray(driveFolders)) return null
  const v = (driveFolders as Record<string, unknown>)[key]
  return isDriveId(v) ? v : null
}

/** Merge a patch of links into the stored json (drops non-id values). Pure —
 *  used by rememberDriveLinks and unit-testable without a DB. */
export function mergeDriveLinks(existing: unknown, patch: Partial<Record<DriveLinkKey, string | null | undefined>>): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const k of KEYS) {
    const cur = getDriveLink(existing, k)
    if (cur) out[k] = cur
  }
  let changed = false
  for (const k of KEYS) {
    const v = patch[k]
    if (isDriveId(v) && out[k] !== v) { out[k] = v; changed = true }
  }
  return changed ? out : null
}

/**
 * Persist links for a booking (fire-safe: never throws — a linkage miss must
 * not break the operation that produced it). No-op when nothing changed.
 */
export async function rememberDriveLinks(bookingId: string, patch: Partial<Record<DriveLinkKey, string | null | undefined>>): Promise<void> {
  try {
    const row = await prisma.booking.findUnique({ where: { id: bookingId }, select: { driveFolders: true } })
    if (!row) return
    const next = mergeDriveLinks(row.driveFolders, patch)
    if (!next) return
    await prisma.booking.update({ where: { id: bookingId }, data: { driveFolders: next } })
  } catch (e: any) {
    console.warn('[drive-links] remember failed (non-fatal):', bookingId, e?.message || e)
  }
}
