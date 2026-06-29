// Pure helpers for the monthly-purchasing workflow. Kept free of Prisma/Drive so
// the money math and the state rules are unit-testable on their own.

export type PurchaseApprovalStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'

export const MONTH_RE = /^\d{4}-\d{2}$/

/** A buyer may add/edit/delete items only while the month is DRAFT or REJECTED. */
export function isBatchEditable(status: PurchaseApprovalStatus): boolean {
  return status === 'DRAFT' || status === 'REJECTED'
}

/** A line's amount: explicit total wins, else quantity × unitPrice, else 0. */
export function lineTotal(item: { quantity?: number | null; unitPrice?: number | null; total?: number | null }): number {
  if (item.total != null) return Number(item.total)
  if (item.unitPrice != null) return Number(item.unitPrice) * (item.quantity ?? 1)
  return 0
}

/** Month grand total = sum of line amounts. */
export function batchTotal(items: Array<{ quantity?: number | null; unitPrice?: number | null; total?: number | null }>): number {
  return items.reduce((sum, it) => sum + lineTotal(it), 0)
}

// Drive folder names can't contain "/". Keep readable, never empty.
export function safeFolderSegment(label: string, fallback: string): string {
  const s = label.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim()
  return s.slice(0, 120) || fallback
}
