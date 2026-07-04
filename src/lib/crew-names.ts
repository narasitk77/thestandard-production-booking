// v1.111 — resolve assigned-crew emails into SHORT display names for booking
// cards ("ทีม: ก้อง ⭐ · นัท · ทีมเสียง"). Ops feedback: the first cut showed full
// legal names ("ธภัทร ตั้งวงษ์ไชย") and raw team accounts ("Video THE STANDARD"),
// which read terribly at card size. One rule, shared by every surface:
//   team account → Thai team label · nickname → first name (Thai) → first name.
import { prisma } from './db'

export interface CrewName {
  email: string
  name: string
  isLead?: boolean
}

// Shared team mailboxes that get assigned as "the team" rather than a person.
const TEAM_LABELS: Record<string, string> = {
  'video@thestandard.co': 'ทีมวิดีโอ',
  'sound@thestandard.co': 'ทีมเสียง',
  'photo@thestandard.co': 'ทีมภาพนิ่ง',
}

// "นายรัชชานนท์ คงเนตร" → "รัชชานนท์" · "Chai Yaphat THE STANDARD" → "Chai"
export function shortPersonName(nickname?: string | null, thaiName?: string | null, name?: string | null): string {
  const nick = (nickname || '').trim()
  if (nick) return nick
  const thai = (thaiName || '').replace(/^(นาย|นางสาว|นาง|ดร\.?|ด\.ช\.|ด\.ญ\.)\s*/, '').trim()
  if (thai) return thai.split(/\s+/)[0]
  const en = (name || '').replace(/\bTHE STANDARD\b/gi, '').trim()
  if (en) return en.split(/\s+/)[0]
  return ''
}

/**
 * v1.115 — producer nickname for cards. The Booking.producer STRING is
 * inconsistent (some are nicknames, some full legal names), so prefer the real
 * user record via producerEmail (nickname → Thai first name), and only fall
 * back to cleaning the stored string. Returns a resolver: email → nickname, or
 * null when the email isn't a known user (caller falls back to the string).
 */
export async function makeProducerNickResolver(emails: Array<string | null | undefined>): Promise<(email?: string | null) => string | null> {
  const clean = Array.from(new Set(
    emails.filter((e): e is string => typeof e === 'string' && e.includes('@')).map(e => e.toLowerCase()),
  ))
  const users = clean.length
    ? await prisma.user.findMany({ where: { email: { in: clean } }, select: { email: true, nickname: true, thaiName: true, name: true } })
    : []
  const byEmail = new Map(users.map(u => [u.email.toLowerCase(), shortPersonName(u.nickname, u.thaiName, u.name)]))
  return (email?: string | null) => {
    const e = (email || '').toLowerCase()
    const v = e ? byEmail.get(e) : undefined
    return v || null
  }
}

/**
 * Batch-resolve a set of assigned emails to short display names.
 * Returns a resolver fn so callers can map per-booking.
 */
export async function makeCrewNameResolver(allEmails: string[]): Promise<(email: string) => string> {
  const emails = Array.from(new Set(
    allEmails.filter(e => typeof e === 'string' && e.includes('@')).map(e => e.toLowerCase()),
  ))
  const personEmails = emails.filter(e => !TEAM_LABELS[e])
  const users = personEmails.length
    ? await prisma.user.findMany({
        where: { email: { in: personEmails } },
        select: { email: true, nickname: true, thaiName: true, name: true },
      })
    : []
  const byEmail = new Map(users.map(u => [u.email.toLowerCase(), shortPersonName(u.nickname, u.thaiName, u.name)]))
  return (email: string) => {
    const e = (email || '').toLowerCase()
    return TEAM_LABELS[e] || byEmail.get(e) || e.split('@')[0]
  }
}

/** Resolve one booking's crew (assignedEmails + lead flag) into CrewName[]. */
export async function resolveBookingCrew(assignedEmails: string[], mainVideographerEmail?: string | null): Promise<CrewName[]> {
  const resolve = await makeCrewNameResolver(assignedEmails)
  const lead = (mainVideographerEmail || '').toLowerCase()
  return (assignedEmails || []).map(e => ({
    email: e,
    name: resolve(e),
    isLead: !!lead && e.toLowerCase() === lead,
  }))
}
