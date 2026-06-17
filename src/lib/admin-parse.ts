// Shared field parsers for the unified-workspace CRUD routes + import scripts.
// Small + boring on purpose — the same coercions are needed in ~12 places, so
// they live here rather than being re-typed (and re-bugged) per file.

/** Trim a string; '' / null / undefined → null. Non-strings are stringified. */
export function cleanStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const t = String(v).trim()
  return t === '' ? null : t
}

/** Parse to a Date, or null if missing/invalid. */
export function dateOrNull(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(v as string)
  return isNaN(d.getTime()) ? null : d
}

/**
 * Parse a money/decimal value to a string Prisma accepts for a Decimal column.
 * Strips Thai-baht commas / currency text ("3,640.00 บาท" → "3640.00"). null on empty.
 */
export function decOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const cleaned = String(v).replace(/[, ]/g, '').replace(/[^\d.\-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n.toString() : null
}

/** Parse to a non-negative int with a fallback. */
export function intOr(v: unknown, fallback = 0): number {
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? n : fallback
}

/** True if `v` is one of the enum's values (pass the Prisma enum object). */
export function inEnum<T extends Record<string, string>>(e: T, v: unknown): v is T[keyof T] {
  return typeof v === 'string' && Object.values(e).includes(v)
}
