/**
 * Episode sequence allocator — atomic per (outletCode, shootDate, programCode).
 *
 * Defense-in-depth against race conditions when many bookings hit the same
 * outlet+date+program slot at once:
 *
 *   Layer 1  PostgreSQL advisory lock per slot key, held for the transaction
 *            (auto-released on COMMIT/ROLLBACK). Other requests for the same
 *            slot wait their turn — no concurrent reads of `max(sequence)`.
 *
 *   Layer 2  If a P2002 (@unique violation) still slips through (e.g. lock
 *            briefly unavailable due to connection churn), the caller retries
 *            the whole flow with a fresh `allocate*` read up to 3 times.
 *
 *   Layer 3  Console-warn whenever a retry actually fires, so any regression
 *            in Layer 1 is visible in logs instead of silently degrading.
 *
 * The advisory lock key is derived deterministically from the slot tuple so
 * different slots never contend with each other.
 */
import type { Prisma, PrismaClient } from '@prisma/client'

type Tx = Prisma.TransactionClient | PrismaClient

function slotKey(outletCode: string, shootDate: Date, programCode: string): string {
  const y = shootDate.getFullYear()
  const m = String(shootDate.getMonth() + 1).padStart(2, '0')
  const d = String(shootDate.getDate()).padStart(2, '0')
  return `ep|${outletCode}|${y}${m}${d}|${programCode}`
}

function yymmdd(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

/**
 * Acquire an advisory lock on the slot and return the next free sequence
 * number. Lock is released automatically when the surrounding transaction
 * ends. MUST be called inside a `prisma.$transaction` for the lock to behave
 * as a "xact" lock; otherwise it leaks at the session level.
 */
export async function allocateEpisodeSequence(
  tx: Tx,
  outletCode: string,
  shootDate: Date,
  programCode: string,
): Promise<number> {
  const key = slotKey(outletCode, shootDate, programCode)

  // pg_advisory_xact_lock(bigint) — same key always hashes to same bigint via
  // hashtextextended; different keys are vanishingly unlikely to collide.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`

  const prefix = `${outletCode}-${yymmdd(shootDate)}-${programCode}-`
  const last = await tx.episode.findFirst({
    where: { episodeId: { startsWith: prefix } },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  })
  return (last?.sequence ?? 0) + 1
}

/**
 * Run `fn` under retry-on-unique-violation. Up to `maxAttempts` tries; logs a
 * warning whenever a retry fires so we can detect lock breakdown in prod.
 */
export async function withSequenceRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (e: any) {
      lastErr = e
      const isUniqueViolation =
        e?.code === 'P2002' ||
        (typeof e?.message === 'string' && e.message.includes('Unique constraint'))
      if (!isUniqueViolation || attempt >= maxAttempts) throw e
      console.warn(
        `[episode-sequence] @unique collision on attempt ${attempt} — retrying. ` +
          `Advisory lock may be ineffective. err=${e?.message}`,
      )
    }
  }
  throw lastErr
}
