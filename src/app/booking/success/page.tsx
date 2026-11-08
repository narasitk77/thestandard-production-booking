'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle2, Copy, Check, ArrowRight, Calendar, Folder } from 'lucide-react'
import { formatDisplayDate, buildCalendarPacket, shootTypeLabel } from '@/lib/utils'
import CalendarPacketDetails from '@/app/_components/CalendarPacketDetails'

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
  vanCount?: number | null
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
  // maint 2026-11-08 (ui-15) — we only get here after POST /api/bookings said 201.
  // A failed RE-READ used to render "Booking not found." and the producer filled
  // the form again → two bookings, two Production IDs, two room holds.
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!bookingId) { setLoading(false); return }
    setLoading(true)
    setLoadError('')
    fetch(`/api/bookings/${bookingId}`)
      .then(async r => {
        const data = await r.json().catch(() => null)
        if (r.status === 404) return // genuinely not there → "Booking not found."
        if (!r.ok || !data?.booking) throw new Error(data?.error ? `${data.error} (HTTP ${r.status})` : `HTTP ${r.status}`)
        setBooking(data.booking)
      })
      .catch(e => setLoadError(e?.message || String(e)))
      .finally(() => setLoading(false))
  }, [bookingId, attempt])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-black"></div>
      </div>
    )
  }

  if (!booking) {
    if (bookingId && loadError) {
      return (
        <div className="max-w-2xl mx-auto px-4 py-20 text-center space-y-3">
          <p className="text-gray-800 font-medium">จองสำเร็จแล้ว แต่โหลดรายละเอียดไม่ได้</p>
          <p className="text-sm text-gray-500">({loadError}) — <b>อย่าส่งฟอร์มซ้ำ</b> ดูงานนี้ใน My Bookings ก่อน</p>
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => setAttempt(a => a + 1)} className="btn-primary">ลองโหลดใหม่</button>
            <Link href={`/dashboard/${bookingId}`} className="text-sm text-brand-primary hover:underline">เปิดใบจองนี้</Link>
            <Link href="/my-bookings" className="text-sm text-brand-primary hover:underline">My Bookings</Link>
          </div>
        </div>
      )
    }
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
        <CalendarPacketDetails booking={{
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
          vanCount: booking.vanCount,
          agencyRef: booking.agencyRef,
          notes: booking.notes,
          episodes: booking.episodes,
        }} />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <Link href="/new" className="btn-secondary flex-1 justify-center">
          New Booking
        </Link>
        <Link href="/my-bookings" className="btn-primary flex-1 justify-center">
          ดูงานของฉัน / My Bookings <ArrowRight className="w-4 h-4" />
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
