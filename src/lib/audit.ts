/**
 * Audit log — best-effort, fire-and-forget writes.
 *
 * Trade-off (chosen on purpose):
 *   - Writes happen OUTSIDE the booking transaction, so an audit failure
 *     (table missing, schema drift, DB blip) never blocks a booking save.
 *   - In a worst-case crash between the booking commit and the audit write,
 *     a single audit row can be lost. The booking record remains authoritative.
 *
 * If you need stronger guarantees later (e.g. compliance), promote logAudit
 * to inside the booking transaction and accept the higher booking error rate.
 */
import { prisma } from './db'
import type { Prisma } from '@prisma/client'

type LogAuditInput = {
  actorEmail?: string | null
  action: string
  entityType: string
  entityId?: string | null
  bookingCode?: string | null
  fromStatus?: string | null
  toStatus?: string | null
  // Any JSON-serializable shape (records, arrays, primitives). We round-trip
  // through JSON before insert so the strict Prisma.InputJsonValue check is
  // satisfied without forcing every caller to cast.
  changes?: unknown
}

/**
 * Fire-and-forget. Always returns void; never throws. Errors are logged but
 * don't propagate. Callers don't need `await` unless they want to wait for
 * the write to complete (mostly useful in tests).
 */
export async function logAudit(input: LogAuditInput): Promise<void> {
  try {
    const serialized =
      input.changes === undefined || input.changes === null
        ? undefined
        : (JSON.parse(JSON.stringify(input.changes)) as Prisma.InputJsonValue)
    await prisma.auditLog.create({
      data: {
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        bookingCode: input.bookingCode ?? null,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        changes: serialized,
      },
    })
  } catch (err: any) {
    console.error(`[audit] failed to log ${input.action}:`, err?.message || err)
  }
}

/**
 * Subset of booking fields users can change via PATCH. Anything not in this
 * list won't show up in the diff (e.g. createdAt, sheetRowIndex, IDs).
 */
const EDITABLE_BOOKING_FIELDS = [
  'status',
  'notes',
  'callTime',
  'estimatedWrap',
  'shootEndDate',
  'locationName',
  'crewRequired',
  'shootType',
  'category',
  'producer',
  'creative',
  'agencyRef',
  'adminNotes',
  'assignedEmails',
  'mainVideographerEmail',
  'videographerCount',
  'producerEmail',
  'producerPhone',
  'director',
  'directorEmail',
  // v1.62.0 — Auto-Planning fields (replace the manual planning sheet)
  'equipmentNote',
  'rentalGearNote',
  'itinerary',
  'assignedEquipmentIds',
] as const

type Diff = Record<string, { from: unknown; to: unknown }>

function normalizeForDiff(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return [...v].sort()
  return v
}

function equals(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeForDiff(a)) === JSON.stringify(normalizeForDiff(b))
}

/**
 * Shallow diff between two booking snapshots over the editable-field whitelist.
 * Returns null when nothing changed.
 */
export function diffBooking(
  before: Record<string, any>,
  after: Record<string, any>,
): Diff | null {
  const diff: Diff = {}
  for (const f of EDITABLE_BOOKING_FIELDS) {
    if (!(f in after)) continue
    if (!equals(before?.[f], after?.[f])) {
      diff[f] = {
        from: normalizeForDiff(before?.[f]) ?? null,
        to: normalizeForDiff(after?.[f]) ?? null,
      }
    }
  }
  return Object.keys(diff).length === 0 ? null : diff
}
