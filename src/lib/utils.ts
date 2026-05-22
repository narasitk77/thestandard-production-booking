import { clsx, type ClassValue } from 'clsx'
import { format, parseISO } from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

function safeDate(date: Date | string): Date | null {
  if (!date) return null
  const d = typeof date === 'string' ? parseISO(date) : date
  return d instanceof Date && !isNaN(d.getTime()) ? d : null
}

export function formatThaiDate(date: Date | string): string {
  const d = safeDate(date)
  return d ? format(d, 'd MMM yyyy') : '—'
}

export function formatDate(date: Date | string): string {
  const d = safeDate(date)
  return d ? format(d, 'yyyy-MM-dd') : ''
}

export function formatDisplayDate(date: Date | string): string {
  const d = safeDate(date)
  return d ? format(d, 'EEE dd MMM yyyy') : '—'
}

/** Shows "Mon 05 May 2026" for single-day, "Mon 05 → Wed 07 May 2026" for multi-day */
export function formatDateRange(
  shootDate: Date | string,
  shootEndDate?: Date | string | null
): string {
  const start = safeDate(shootDate)
  if (!start) return '—'
  const end = shootEndDate ? safeDate(shootEndDate) : null
  if (!end || format(end, 'yyyy-MM-dd') === format(start, 'yyyy-MM-dd')) {
    return format(start, 'EEE dd MMM yyyy')
  }
  // Same month
  if (format(start, 'MMM yyyy') === format(end, 'MMM yyyy')) {
    return `${format(start, 'EEE dd')} → ${format(end, 'EEE dd MMM yyyy')}`
  }
  return `${format(start, 'EEE dd MMM yyyy')} → ${format(end, 'EEE dd MMM yyyy')}`
}

export function shootTypeLabel(type: string): string {
  const map: Record<string, string> = {
    STUDIO: 'Studio',
    ON_LOCATION: 'On Location',
    REMOTE_ONLINE: 'Remote / Online',
    EVENT: 'Event',
  }
  return map[type] ?? type
}

export function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    ORIGINAL_CONTENT: 'Original Content',
    ADVERTORIAL: 'Advertorial',
    EVENT: 'Event',
    INTERNAL: 'Internal',
  }
  return map[cat] ?? cat
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    REQUESTED: '[Requested]',
    ASSIGNED: 'Assigned',
    CONFIRMED: 'Confirmed',
    CANCELLED: 'Cancelled',
    COMPLETED: 'Completed',
  }
  return map[status] ?? status
}

export function statusColor(status: string): string {
  const map: Record<string, string> = {
    REQUESTED: 'bg-red-100 text-red-700',
    ASSIGNED: 'bg-yellow-100 text-yellow-700',
    CONFIRMED: 'bg-green-100 text-green-700',
    CANCELLED: 'bg-gray-100 text-gray-500',
    COMPLETED: 'bg-blue-100 text-blue-700',
  }
  return map[status] ?? 'bg-gray-100 text-gray-800'
}

export function buildCalendarPacket(booking: {
  outletName: string
  outletCode: string
  programName: string
  programCode: string
  shootDate: Date | string
  shootEndDate?: Date | string | null
  callTime: string
  estimatedWrap?: string | null
  shootType: string
  locationName?: string | null
  producer: string
  creative?: string[]
  crewRequired?: string[]
  agencyRef?: string | null
  notes?: string | null
  episodes: Array<{ episodeId: string; title: string }>
}): string {
  const d = typeof booking.shootDate === 'string' ? parseISO(booking.shootDate) : booking.shootDate
  const validDate = d instanceof Date && !isNaN(d.getTime())
  const endD = booking.shootEndDate
    ? (typeof booking.shootEndDate === 'string' ? parseISO(booking.shootEndDate) : booking.shootEndDate)
    : null
  const isMultiDay = endD && validDate && format(endD, 'yyyy-MM-dd') !== format(d, 'yyyy-MM-dd')
  const dateStr = validDate
    ? (isMultiDay ? `${format(d, 'yyyy-MM-dd')} → ${format(endD!, 'yyyy-MM-dd')}` : format(d, 'yyyy-MM-dd'))
    : '—'
  const wrapStr = booking.estimatedWrap ? `→ ${booking.estimatedWrap}` : ''
  const episodes = booking.episodes || []
  const epCount = episodes.length
  // Location = actual room (independent of Shoot Type)
  const location = booking.locationName || '—'

  const epList = episodes
    .map(e => `  • ${e.episodeId} — ${e.title}`)
    .join('\n')

  const crew = booking.crewRequired?.join(', ') || '—'
  const creative = booking.creative?.join(', ') || '—'

  const firstEpTitle = episodes[0]?.title || '(no episode)'
  const title =
    epCount === 1
      ? `[${booking.outletCode}] ${booking.programName} — ${firstEpTitle}`
      : `[${booking.outletCode}] ${booking.programName} — ${epCount} EPs (${booking.callTime}${wrapStr})`

  return `EVENT TITLE:
${title}

TIME: ${booking.callTime} ${wrapStr}
DATE: ${dateStr}
LOCATION / ROOM: ${location}
SHOOT TYPE: ${shootTypeLabel(booking.shootType)}

──────────────────────────────
Production Project
Episode IDs:
${epList}

Outlet: ${booking.outletName} (${booking.outletCode})
Program: ${booking.programName} (${booking.programCode})
Producer: ${booking.producer}
Creative/Host: ${creative}
Crew: ${crew}

NAS: /Production/${validDate ? format(d, 'yyyy/MM') : '----/--'}/${episodes[0]?.episodeId || `${booking.outletCode}-${booking.programCode}`}/
Agency Ref: ${booking.agencyRef || '—'}
Notes: ${booking.notes || '—'}
──────────────────────────────
Auto-generated by THE STANDARD Production Booking
${format(new Date(), 'yyyy-MM-dd HH:mm')} BKK`
}
