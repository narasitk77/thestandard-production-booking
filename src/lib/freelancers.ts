// v1.41.0 — structured freelance crew.
//
// Before v1.41 the admin detail page appended a "Freelancers:" text block into
// `adminNotes` on every Assign save. The form's freelancer list was never
// cleared and the old block was never stripped, so each re-save appended the
// block again — names piled up in adminNotes and therefore on the Google
// Calendar event description (ops feedback, June 2026).
//
// Fix: freelancers now live in a dedicated `Booking.freelancers` Json column as
// structured rows. The calendar description is REBUILT from that list (never
// appended), so re-saving is idempotent. This module is the single source of
// truth for the shape + (de)serialization, shared by the client form and the
// server-side calendar description builder.

export interface Freelancer {
  name: string
  contract?: string
  email?: string
}

// Coerce an unknown value (e.g. Prisma Json, request body) into a clean
// Freelancer[]. Drops rows without a name; trims everything.
export function normalizeFreelancers(value: unknown): Freelancer[] {
  if (!Array.isArray(value)) return []
  const out: Freelancer[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    if (!name) continue
    out.push({
      name,
      contract: typeof r.contract === 'string' ? r.contract.trim() : '',
      email: typeof r.email === 'string' ? r.email.trim() : '',
    })
  }
  return out
}

// The emails that should be added as calendar guests / email recipients.
export function freelancerEmails(list: Freelancer[]): string[] {
  return list.map(f => (f.email || '').trim()).filter(Boolean)
}

// One human-readable line per freelancer — used in the calendar description
// and emails. e.g. "• Ken (Contract: 1500) <ken@x.com>"
export function formatFreelancerLines(list: Freelancer[]): string {
  return list
    .map(f =>
      `• ${f.name}${f.contract ? ` (Contract: ${f.contract})` : ''}${f.email ? ` <${f.email}>` : ''}`,
    )
    .join('\n')
}

// ── Legacy migration ────────────────────────────────────────────────────────
// Bookings created before v1.41 carry freelancers as a text block inside
// adminNotes. On the first edit under the new UI we parse that block out so it
// can be stored structurally and removed from the free-text notes — preventing
// the old text block and the new structured list from BOTH rendering.
const LEGACY_BLOCK = /\n*Freelancers:\n([\s\S]*)$/

// Returns the free-text notes with any trailing legacy "Freelancers:" block
// removed, plus the freelancers parsed out of that block (empty if none).
export function splitLegacyFreelancers(adminNotes: string | null | undefined): {
  notes: string
  freelancers: Freelancer[]
} {
  const text = adminNotes || ''
  const match = text.match(LEGACY_BLOCK)
  if (!match) return { notes: text, freelancers: [] }
  const notes = text.slice(0, match.index).trimEnd()
  const freelancers: Freelancer[] = []
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('•')) continue
    const body = trimmed.replace(/^•\s*/, '')
    const emailMatch = body.match(/<([^>]+)>\s*$/)
    const email = emailMatch ? emailMatch[1].trim() : ''
    let rest = emailMatch ? body.slice(0, emailMatch.index).trim() : body
    const contractMatch = rest.match(/\(Contract:\s*([^)]*)\)\s*$/)
    const contract = contractMatch ? contractMatch[1].trim() : ''
    if (contractMatch) rest = rest.slice(0, contractMatch.index).trim()
    const name = rest.trim()
    if (name) freelancers.push({ name, contract, email })
  }
  return { notes, freelancers }
}
