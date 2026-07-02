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
function shortPersonName(nickname?: string | null, thaiName?: string | null, name?: string | null): string {
  const nick = (nickname || '').trim()
  if (nick) return nick
  const thai = (thaiName || '').replace(/^(นาย|นางสาว|นาง|ดร\.?|ด\.ช\.|ด\.ญ\.)\s*/, '').trim()
  if (thai) return thai.split(/\s+/)[0]
  const en = (name || '').replace(/\bTHE STANDARD\b/gi, '').trim()
  if (en) return en.split(/\s+/)[0]
  return ''
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
