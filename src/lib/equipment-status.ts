// Single source of truth for Equipment.status (v1.62.1 fix).
//
// Before this, four call sites (loan create/return/delete, repair create/close)
// each wrote Equipment.status unconditionally, so they clobbered each other:
// a repair opened on a loaned item erased ON_LOAN; returning a loan freed an
// item still IN_REPAIR or still held by a second active loan; etc.
//
// Now every writer calls reconcileEquipmentStatus(tx, ids) instead of writing
// the field directly. The status is DERIVED from the live world with a fixed
// precedence:
//   RETIRED   — manual terminal state, never auto-changed
//   IN_REPAIR — has an open RepairTicket (REPORTED / SENT)
//   ON_LOAN   — on an ACTIVE EquipmentLoan
//   AVAILABLE — none of the above
// Because it's derived, double-loans, repair-while-on-loan, and return-while-in-
// repair all resolve correctly without per-writer special cases.
import type { Prisma, EquipmentStatus } from '@prisma/client'

type Tx = Prisma.TransactionClient

/**
 * Pure status precedence: RETIRED (manual terminal) > IN_REPAIR > ON_LOAN >
 * AVAILABLE. Extracted so it can be unit-tested without a database.
 */
export function deriveEquipmentStatus(
  current: EquipmentStatus,
  opts: { hasOpenRepair: boolean; hasActiveLoan: boolean },
): EquipmentStatus {
  if (current === 'RETIRED') return 'RETIRED'
  if (opts.hasOpenRepair) return 'IN_REPAIR'
  if (opts.hasActiveLoan) return 'ON_LOAN'
  return 'AVAILABLE'
}

/**
 * Recompute Equipment.status for each id from its open repairs + active loans.
 * No-op for ids whose current status is RETIRED (manual terminal state).
 */
export async function reconcileEquipmentStatus(tx: Tx, equipmentIds: Array<string | null | undefined>): Promise<void> {
  const ids = Array.from(new Set(equipmentIds.filter((x): x is string => !!x)))
  if (ids.length === 0) return
  const rows = await tx.equipment.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
  const live = rows.filter(eq => eq.status !== 'RETIRED') // RETIRED owned manually, leave it
  if (live.length === 0) return
  const liveIds = live.map(eq => eq.id)

  // v1.146 review fix — batched: this used to run 1-3 sequential COUNT queries
  // PER id inside the caller's transaction (a 15-20 item bulk checkout = 30-60+
  // round-trips holding the tx open). Two groupBy queries now cover every id.
  const openRepairs = await tx.repairTicket.groupBy({
    by: ['equipmentId'],
    where: { equipmentId: { in: liveIds }, status: { in: ['REPORTED', 'SENT'] } },
    _count: true,
  })
  const activeLoans = await tx.equipmentLoanItem.groupBy({
    by: ['equipmentId'],
    where: { equipmentId: { in: liveIds }, loan: { status: 'ACTIVE' } },
    _count: true,
  })
  const hasRepair = new Set(openRepairs.map(r => r.equipmentId).filter(Boolean))
  const hasLoan = new Set(activeLoans.map(l => l.equipmentId).filter(Boolean))

  // Batch the writes too — group ids by their derived status (at most 3 groups).
  const idsByNext = new Map<EquipmentStatus, string[]>()
  for (const eq of live) {
    const next = deriveEquipmentStatus(eq.status, { hasOpenRepair: hasRepair.has(eq.id), hasActiveLoan: hasLoan.has(eq.id) })
    if (next === eq.status) continue
    const group = idsByNext.get(next) ?? []
    group.push(eq.id)
    idsByNext.set(next, group)
  }
  for (const [status, group] of Array.from(idsByNext)) {
    await tx.equipment.updateMany({ where: { id: { in: group } }, data: { status } })
  }
}

/**
 * Best-effort resolve a typed loan/repair line to a real Equipment.id so the
 * status sync can engage even when the form only captured free text. Matches
 * the importer's strategy: tag first (fixedAssetTag / itemId / serialNumber),
 * then exact (case-insensitive) name. Returns null when nothing matches — the
 * item is then just a free-text snapshot (e.g. ad-hoc gear not in inventory).
 */
export async function resolveEquipmentId(tx: Tx, opts: { tag?: string | null; name?: string | null }): Promise<string | null> {
  const tag = (opts.tag || '').trim()
  const name = (opts.name || '').trim()
  if (tag) {
    const byTag = await tx.equipment.findFirst({
      where: { OR: [{ fixedAssetTag: tag }, { itemId: tag }, { serialNumber: tag }] },
      select: { id: true },
    })
    if (byTag) return byTag.id
  }
  if (name) {
    const byName = await tx.equipment.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    })
    if (byName) return byName.id
  }
  return null
}
