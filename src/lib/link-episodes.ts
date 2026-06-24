/**
 * Pure helper for "link existing project episodes onto a booking" (v1.95.0).
 *
 * Decides which requested episodeIds become new Episode rows: skips ones already
 * on the booking and ones not present in the project (source of truth = the
 * Producer Dashboard Sheet). Never mints IDs — that stays in the Dashboard UI
 * (see dashboard-episodes.ts). Kept pure so the rules are unit-testable without
 * Prisma or the Sheets API.
 */

export type ProjectEp = { episodeId: string; ep: string; projectName: string }
export type NewEpisodeRow = { episodeId: string; sequence: number; title: string }

export type PlanResult = {
  toAdd: NewEpisodeRow[]
  skipped: { already: string[]; notInProject: string[] }
}

/**
 * @param requested      episodeIds the admin picked
 * @param projectEpsById project episodes keyed by episodeId (from the Sheet)
 * @param existingIds     episodeIds already on the booking
 * @param maxSequence     current highest sequence on the booking (new rows append after it)
 */
export function planEpisodesToLink(
  requested: string[],
  projectEpsById: Map<string, ProjectEp>,
  existingIds: Set<string>,
  maxSequence: number
): PlanResult {
  const skipped = { already: [] as string[], notInProject: [] as string[] }
  const toAdd: NewEpisodeRow[] = []
  const seen = new Set<string>()
  let seq = maxSequence

  for (const raw of requested) {
    const id = String(raw ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (existingIds.has(id)) { skipped.already.push(id); continue }
    const ep = projectEpsById.get(id)
    if (!ep) { skipped.notInProject.push(id); continue }
    // Mirror create-booking's AGN title rule: prefer the EP label, fall back to project name.
    const title = ep.ep && ep.ep !== '-' ? ep.ep : ep.projectName
    toAdd.push({ episodeId: ep.episodeId, sequence: ++seq, title })
  }

  return { toAdd, skipped }
}
