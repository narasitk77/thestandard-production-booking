'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle2, Copy, Check, ArrowRight, Calendar, Folder } from 'lucide-react'
import { formatDisplayDate, buildCalendarPacket, shootTypeLabel } from '@/lib/utils'

interface Episode {
  id: string
  episodeId: string
  sequence: number
  title: string
}

interface Booking {
  id: string
  shootDate: string
  callTime: string
  estimatedWrap?: string
  shootType: string
  locationName?: string
  producer: string
  creative: string[]
  crewRequired: string[]
  agencyRef?: string
  projectId?: string
  projectName?: string
  notes?: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}

function SuccessContent() {
  const searchParams = useSearchParams()
  const bookingId = searchParams.get('id')

  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!bookingId) return
    fetch(`/api/bookings/${bookingId}`)
      .then(r => r.json())
      .then(data => setBooking(data.booking))
      .finally(() => setLoading(false))
  }, [bookingId])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-black"></div>
      </div>
    )
  }

  if (!booking) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-20 text-center">
        <p className="text-brand-gray-500">Booking not found.</p>
        <Link href="/" className="btn-primary mt-4">Back to Home</Link>
      </div>
    )
  }

  const calendarPacket = buildCalendarPacket({
    outletName: booking.outlet.name,
    outletCode: booking.outlet.code,
    programName: booking.program.name,
    programCode: booking.program.code,
    shootDate: booking.shootDate,
    callTime: booking.callTime,
    estimatedWrap: booking.estimatedWrap,
    shootType: booking.shootType,
    locationName: booking.locationName,
    producer: booking.producer,
    creative: booking.creative,
    crewRequired: booking.crewRequired,
    agencyRef: booking.agencyRef,
    notes: booking.notes,
    episodes: booking.episodes,
  })

  const handleCopy = () => {
    navigator.clipboard.writeText(calendarPacket)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Folder is named after the booking's first Episode ID (= bookingCode), so it
  // matches the actual IDs (PP-26-006-T02) rather than a separate outlet-date code.
  const sd = new Date(booking.shootDate)
  const firstEpisodeId = booking.episodes[0]?.episodeId || `${booking.outlet.code}-${booking.program.code}`
  const driveFolder = `Production/${sd.getFullYear()}/${String(sd.getMonth() + 1).padStart(2, '0')}/${firstEpisodeId}/`

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
      {/* Success banner */}
      <div className="flex items-center gap-3 mb-8">
        <CheckCircle2 className="w-10 h-10 text-green-500 flex-shrink-0" />
        <div>
          <h1 className="text-2xl font-bold text-brand-black">Booking Created!</h1>
          <p className="text-sm text-brand-gray-500">
            {formatDisplayDate(booking.shootDate)} · {booking.outlet.name} · {booking.program.name}
          </p>
        </div>
      </div>

      {/* Project ID — Producer Dashboard linkage */}
      {booking.projectId && (
        <div className="card p-4 mb-4">
          <div className="text-xs text-brand-gray-500 mb-1">Project ID</div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-base text-brand-black">{booking.projectId}</span>
            {booking.projectName && (
              <span className="text-sm text-brand-gray-600">{booking.projectName}</span>
            )}
          </div>
        </div>
      )}

      {/* Episode IDs */}
      <div className="card p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 rounded-full bg-brand-gold"></div>
          <h2 className="font-semibold text-sm text-brand-gray-700">Episode IDs Generated</h2>
        </div>
        <div className="space-y-2">
          {booking.episodes.map(ep => (
            <div key={ep.id} className="flex items-center justify-between gap-3 p-3 bg-brand-gray-50 rounded-lg">
              <span className="episode-badge text-sm">{ep.episodeId}</span>
              <span className="text-sm text-brand-gray-600 flex-1 text-right truncate">{ep.title}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Drive path */}
      <div className="card p-4 mb-4 flex items-center gap-3">
        <Folder className="w-5 h-5 text-brand-gold flex-shrink-0" />
        <div>
          <div className="text-xs text-brand-gray-500 mb-0.5">Drive / NAS Folder Path</div>
          <code className="text-xs text-brand-black font-mono">{driveFolder}</code>
        </div>
      </div>

      {/* Calendar packet */}
      <div className="card p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-brand-gray-500" />
            <h2 className="font-semibold text-sm text-brand-gray-700">Calendar Packet for พี่ตุ้ย</h2>
          </div>
          <button onClick={handleCopy} className="btn-secondary text-xs px-3 py-1.5">
            {copied ? <><Check className="w-3.5 h-3.5 text-green-500" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
          </button>
        </div>
        <pre className="text-xs bg-brand-gray-50 rounded-lg p-4 font-mono text-brand-gray-700 whitespace-pre-wrap overflow-x-auto border border-brand-gray-100">
          {calendarPacket}
        </pre>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <Link href="/new" className="btn-secondary flex-1 justify-center">
          New Booking
        </Link>
        <Link href="/dashboard" className="btn-primary flex-1 justify-center">
          View Dashboard <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  )
}

export default function SuccessPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-black"></div>
      </div>
    }>
      <SuccessContent />
    </Suspense>
  )
}
