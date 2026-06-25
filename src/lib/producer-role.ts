/**
 * Single source of truth for the Producer vs Co-Producer split used by the
 * booking form dropdown (GET /api/producers) and guarded by the seed invariant
 * test (outlet-producers.test.ts).
 *
 * A person is a Co-Producer when their `position` reads like one:
 *   - "Co-Producer" / "Coproducer"           → /co.?produc/
 *   - "Project Coordinator" (PM) and other   → /coordinator/
 *     coordinator roles assist the lead, so they belong in the Co-Producer column.
 * Everything else (Producer, Event Producer, Project Manager, Content Creator, …)
 * is a Producer.
 */
export function isCoProducer(position: string | null | undefined): boolean {
  return /co.?produc|coordinator/i.test(position || '')
}
