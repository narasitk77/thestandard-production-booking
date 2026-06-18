/**
 * v1.36.0 — render a human-readable `booking-info.txt` that sits next to
 * the footage in Drive. The audience is whoever opens the booking folder
 * later (editor, archivist, a producer double-checking) — they should be
 * able to understand the shoot's context without going back to the app.
 *
 * Pure formatter: no I/O. `src/app/api/upload/init/route.ts` builds the
 * input from the booking row and `src/lib/google-drive.ts#upsertTextFile`
 * writes the result.
 */

export interface BookingInfoEpisode {
  episodeId: string
  title: string | null
  sequence: number
}

export interface BookingInfoInput {
  bookingCode: string
  projectName?: string | null
  projectId?: string | null
  outletName: string
  outletCode: string
  category?: string | null
  videoType?: string | null
  shootType?: string | null
  shootDate: Date
  shootEndDate?: Date | null
  callTime?: string | null
  estimatedWrap?: string | null
  locationName?: string | null
  producer?: string | null
  producerEmail?: string | null
  director?: string | null
  directorEmail?: string | null
  mainVideographerEmail?: string | null
  assignedEmails?: string[]
  crewRequired?: string[]
  agencyRef?: string | null
  notes?: string | null
  episodes: BookingInfoEpisode[]
  /** ISO-ish timestamp the file was generated; pass new Date() from caller. */
  generatedAt: Date
}

/**
 * Map a booking row (the upload-init select OR the approve include — both carry
 * these fields) into a BookingInfoInput. One mapper so the two _SHOOT.txt write
 * sites can't drift. Caller guarantees bookingCode is set before writing.
 */
export function bookingInfoInput(b: {
  bookingCode: string | null
  projectName?: string | null
  projectId?: string | null
  outlet: { name: string; code: string }
  category?: string | null
  videoType?: string | null
  shootType?: string | null
  shootDate: Date
  shootEndDate?: Date | null
  callTime?: string | null
  estimatedWrap?: string | null
  locationName?: string | null
  producer?: string | null
  producerEmail?: string | null
  director?: string | null
  directorEmail?: string | null
  mainVideographerEmail?: string | null
  assignedEmails?: string[]
  crewRequired?: string[]
  agencyRef?: string | null
  notes?: string | null
  episodes: BookingInfoEpisode[]
}): BookingInfoInput {
  return {
    bookingCode: b.bookingCode || '',
    projectName: b.projectName, projectId: b.projectId,
    outletName: b.outlet.name, outletCode: b.outlet.code,
    category: b.category, videoType: b.videoType, shootType: b.shootType,
    shootDate: b.shootDate, shootEndDate: b.shootEndDate,
    callTime: b.callTime, estimatedWrap: b.estimatedWrap, locationName: b.locationName,
    producer: b.producer, producerEmail: b.producerEmail,
    director: b.director, directorEmail: b.directorEmail,
    mainVideographerEmail: b.mainVideographerEmail,
    assignedEmails: b.assignedEmails, crewRequired: b.crewRequired,
    agencyRef: b.agencyRef, notes: b.notes, episodes: b.episodes,
    generatedAt: new Date(),
  }
}

const TZ = 'Asia/Bangkok'

function fmtDate(d: Date): string {
  // e.g. "29 พ.ค. 2026"
  return d.toLocaleDateString('th-TH', {
    timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString('th-TH', {
    timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function line(label: string, value: string | null | undefined): string | null {
  const v = (value ?? '').toString().trim()
  if (!v) return null
  return `${label.padEnd(18)}: ${v}`
}

/**
 * Build the full text body. Sections are omitted gracefully when their
 * data is absent (non-Content-Agency bookings have no projectId/director,
 * etc.) so the file stays clean rather than littered with empty fields.
 */
export function renderBookingInfo(b: BookingInfoInput): string {
  const sep = '═'.repeat(52)
  const sub = (t: string) => `── ${t} ${'─'.repeat(Math.max(0, 46 - t.length))}`

  const out: string[] = []
  out.push(sep)
  out.push('  _SHOOT.txt — ข้อมูลงานถ่ายทำ / Shoot info')
  out.push(sep)
  out.push('')

  // Identity
  ;[
    line('Production ID', b.bookingCode),
    line('งาน / Project', b.projectName),
    line('Project ID', b.projectId),
    line('Outlet', `${b.outletName} (${b.outletCode})`),
    line('ประเภท / Category', b.category),
    line('Video Type', b.videoType),
  ].forEach(l => l && out.push(l))

  // Schedule
  out.push('')
  out.push(sub('วันถ่ายทำ / Schedule'))
  const dateStr = b.shootEndDate && b.shootEndDate.getTime() !== b.shootDate.getTime()
    ? `${fmtDate(b.shootDate)} → ${fmtDate(b.shootEndDate)}`
    : fmtDate(b.shootDate)
  ;[
    line('วันที่ / Date', dateStr),
    line('เวลา / Time', [b.callTime, b.estimatedWrap].filter(Boolean).join(' → ') || null),
    line('รูปแบบ / Type', b.shootType),
    line('สถานที่ / Location', b.locationName),
  ].forEach(l => l && out.push(l))

  // Team
  out.push('')
  out.push(sub('ทีมงาน / Crew'))
  ;[
    line('Producer', [b.producer, b.producerEmail].filter(Boolean).join(' · ') || null),
    line('Director', [b.director, b.directorEmail].filter(Boolean).join(' · ') || null),
    line('Main Videographer', b.mainVideographerEmail),
    line('Crew ที่ต้องใช้', (b.crewRequired && b.crewRequired.length) ? b.crewRequired.join(', ') : null),
    line('ทีมที่ assign', (b.assignedEmails && b.assignedEmails.length) ? b.assignedEmails.join(', ') : null),
    line('Agency Ref', b.agencyRef),
  ].forEach(l => l && out.push(l))

  // Episodes
  out.push('')
  out.push(sub(`Episodes (${b.episodes.length})`))
  if (b.episodes.length === 0) {
    out.push('(ไม่มีรายการ episode)')
  } else {
    const sorted = [...b.episodes].sort((a, e) => a.sequence - e.sequence)
    for (const ep of sorted) {
      const title = (ep.title ?? '').trim()
      out.push(`  ${String(ep.sequence).padStart(2, ' ')}. ${ep.episodeId}${title ? ` — ${title}` : ''}`)
    }
  }

  // Notes
  const notes = (b.notes ?? '').trim()
  if (notes) {
    out.push('')
    out.push(sub('หมายเหตุ / Notes'))
    out.push(notes)
  }

  out.push('')
  out.push(sep)
  out.push('สร้างอัตโนมัติโดยระบบ Production Booking')
  out.push(`อัปเดตล่าสุด: ${fmtDateTime(b.generatedAt)}`)
  out.push(sep)
  out.push('')

  return out.join('\n')
}
