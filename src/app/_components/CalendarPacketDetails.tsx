import { format, parseISO } from 'date-fns'
import { MapPin, Clock, Users, User, Tag, StickyNote } from 'lucide-react'
import { shootTypeLabel } from '@/lib/utils'

export interface CalendarPacketBooking {
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
  vanCount?: number | null
  agencyRef?: string | null
  notes?: string | null
  episodes: Array<{ episodeId: string; title: string }>
}

function Field({ icon, label, value, mono }: { icon?: React.ReactNode; label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      {icon && <span className="text-gray-400 mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">
        <div className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</div>
        <div className={`text-sm text-gray-800 break-words ${mono ? 'font-mono' : ''}`}>{value}</div>
      </div>
    </div>
  )
}

// v1.131 — replaces the plain-text `<pre>{buildCalendarPacket(...)}</pre>` block
// ("Calendar Packet") with a structured, color-highlighted detail view. Notes
// gets its own red-accented callout since it's the field ops most often miss
// buried in a wall of monospace text. `buildCalendarPacket()` itself is kept
// (unchanged) as the plain-text string the page's "Copy" button still copies —
// this component is purely the on-screen replacement for the `<pre>`.
export default function CalendarPacketDetails({ booking }: { booking: CalendarPacketBooking }) {
  const parseDate = (d: Date | string) => (typeof d === 'string' ? parseISO(d) : d)
  const start = parseDate(booking.shootDate)
  const validStart = start instanceof Date && !isNaN(start.getTime())
  const end = booking.shootEndDate ? parseDate(booking.shootEndDate) : null
  const validEnd = end instanceof Date && !isNaN(end.getTime())
  const isMultiDay = validStart && validEnd && format(end!, 'yyyy-MM-dd') !== format(start, 'yyyy-MM-dd')
  const dateStr = validStart
    ? (isMultiDay ? `${format(start, 'EEE dd MMM yyyy')} → ${format(end!, 'EEE dd MMM yyyy')}` : format(start, 'EEE dd MMM yyyy'))
    : '—'

  const episodes = booking.episodes || []
  const epCount = episodes.length
  const firstEpTitle = episodes[0]?.title || '(no episode)'
  const title = epCount === 1
    ? `[${booking.outletCode}] ${booking.programName} — ${firstEpTitle}`
    : `[${booking.outletCode}] ${booking.programName} — ${epCount} EPs`

  const nasPath = `/Production/${validStart ? format(start, 'yyyy/MM') : '----/--'}/${episodes[0]?.episodeId || `${booking.outletCode}-${booking.programCode}`}/`
  const vanCount = booking.vanCount || 0

  return (
    <div className="space-y-4">
      {/* Event title */}
      <div>
        <div className="text-[10px] text-gray-400 uppercase tracking-wide">Event Title</div>
        <div className="text-base font-semibold text-gray-900">{title}</div>
      </div>

      {/* Time / date / location / shoot type */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-gray-100">
        <Field icon={<Clock className="w-3.5 h-3.5" />} label="Time"
          value={`${booking.callTime}${booking.estimatedWrap ? ` → ${booking.estimatedWrap}` : ''}`} />
        <Field icon={<Clock className="w-3.5 h-3.5" />} label="Date" value={dateStr} />
        <Field icon={<MapPin className="w-3.5 h-3.5" />} label="Location / Room" value={booking.locationName || '—'} />
        <Field icon={<Tag className="w-3.5 h-3.5" />} label="Shoot Type"
          value={`${shootTypeLabel(booking.shootType)}${vanCount > 0 ? ` · 🚐${vanCount > 1 ? ` ×${vanCount}` : ''}` : ''}`} />
      </div>

      {/* Production project */}
      <div className="pt-3 border-t border-gray-100">
        <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Production Project</div>
        {episodes.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {episodes.map(ep => (
              <span key={ep.episodeId} className="episode-badge text-[11px]" title={ep.title}>{ep.episodeId}</span>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Outlet" value={`${booking.outletName} (${booking.outletCode})`} />
          <Field label="Program" value={`${booking.programName} (${booking.programCode})`} />
          <Field icon={<User className="w-3.5 h-3.5" />} label="Producer" value={booking.producer} />
          <Field icon={<Users className="w-3.5 h-3.5" />} label="Crew" value={booking.crewRequired?.join(', ') || '—'} />
          {booking.creative && booking.creative.length > 0 && (
            <Field label="Creative/Host" value={booking.creative.join(', ')} />
          )}
          {booking.agencyRef && <Field label="Agency Ref" value={booking.agencyRef} mono />}
        </div>
      </div>

      {/* NAS path */}
      <Field icon={<span className="text-xs">📁</span>} label="NAS" value={nasPath} mono />

      {/* Notes — highlighted, colored, real line breaks preserved */}
      {booking.notes && (
        <div className="rounded-lg border-l-4 border-red-400 bg-red-50 p-3">
          <div className="flex items-center gap-1.5 text-[10px] text-red-600 uppercase tracking-wide font-semibold mb-1">
            <StickyNote className="w-3.5 h-3.5" /> Notes
          </div>
          <div className="text-sm text-red-900 whitespace-pre-line break-words">{booking.notes}</div>
        </div>
      )}
    </div>
  )
}
