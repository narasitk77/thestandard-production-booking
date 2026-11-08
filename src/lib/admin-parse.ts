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

/** Thrown by decOrNull for a value that was SENT but is not a valid amount. */
export class InvalidMoneyError extends Error {
  constructor(public readonly raw: unknown) {
    super(`ยอดเงินไม่ถูกต้อง "${String(raw).slice(0, 40)}" — ต้องเป็นตัวเลข 0 ถึง 9,999,999,999.99 (ไม่ได้บันทึก)`)
    this.name = 'InvalidMoneyError'
  }
}

/**
 * Parse a money/decimal value to a string Prisma accepts for a Decimal column.
 * Strips Thai-baht commas / currency text ("3,640.00 บาท" → "3640.00"). null on empty.
 *
 * Throws InvalidMoneyError for a negative, unparseable or over-cap value. It used
 * to return null for those too — and every PATCH route does
 * `if ('amount' in b) data.amount = decOrNull(b.amount)`, so a typo like '-500'
 * WIPED the stored amount and answered 200 (maintenance 2026-11-08). Every caller
 * sits inside a try/catch that returns the error message to the user.
 */
export function decOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  // Money/qty fields only (amount/cost/price/total). Keep the minus while parsing
  // so a negative is DETECTED (not silently flipped to positive) and rejected, and
  // cap at the Decimal(12,2) ceiling so an over-long value is refused here instead
  // of as a raw 500 from Prisma.
  const cleaned = String(v).replace(/[, ]/g, '').replace(/[^\d.\-]/g, '')
  // Nothing numeric at all ('', '-', 'N/A', 'ฟรี') still means "no amount".
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || n > 9999999999.99) throw new InvalidMoneyError(v)
  return n.toString()
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
