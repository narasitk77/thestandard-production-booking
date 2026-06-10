'use client'

import { bookingShowName } from '@/lib/display'
import { hasConsoleAccess } from '@/lib/roles'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDateRange, buildCalendarPacket, statusColor, statusLabel, shootTypeLabel, categoryLabel } from '@/lib/utils'
import { ArrowLeft, Copy, Check, Calendar, Folder, Upload, CheckCircle2, XCircle, Loader2 } from 'lucide-react'

interface Episode {
  id: string
  episodeId: string
  sequence: number
  title: string
  program?: { code?: string; name: string } | null
}

interface UploadRecord {
  id: string
  camera: string
  fileName: string
  fileSize: string | null
  status: string
  uploadedBy: string
  createdAt: string
  episode: { episodeId: string } | null
}

interface BookingDetail {
  id: string
  shootDate: string
  shootEndDate?: string | null
  callTime: string
  estimatedWrap?: string
  status: string
  category: string
  videoType?: string | null
  shootType: string
  locationName?: string
  producer: string
  creative: string[]
  crewRequired: string[]
  agencyRef?: string
  notes?: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  uploads: UploadRecord[]
  createdAt: string
}

export default function BookingDetailPage({ params }: { params: { id: string } }) {
  const { id } = params
  const [booking, setBooking] = useState<BookingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [updating, setUpdating] = useState(false)

  const [error, setError] = useState('')
  // v1.50.2 — the page is reachable by anyone on the booking (the API scopes
  // reads); status actions stay console-only, so hide them for plain users.
  const [isStaff, setIsStaff] = useState(false)

  useEffect(() => {
    fetch(`/api/bookings/${id}`)
      .then(r => r.json())
      .then(data => {
        if (!data?.booking) {
          setError(data?.error || 'Booking not found')
          return
        }
        setBooking(data.booking)
      })
      .catch(e => setError(e?.message || 'Failed to load booking'))
      .finally(() => setLoading(false))
    fetch('/api/me')
      .then(r => r.json())
      .then(d => setIsStaff(hasConsoleAccess(d?.user?.role)))
      .catch(() => {})
  }, [id])

  const backHref = isStaff ? '/dashboard' : '/my-bookings'
  const backLabel = isStaff ? 'Dashboard' : 'My Bookings'

  const handleStatusChange = async (newStatus: string) => {
    if (!booking) return
    setUpdating(true)
    try {
      const res = await fetch(`/api/bookings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const data = await res.json()
      if (!res.ok || !data?.booking) {
        setError(data?.error || 'Failed to update status')
        return
      }
      setBooking(prev => prev ? { ...prev, status: data.booking.status } : prev)
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    )
  }

  if (!booking) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-20 text-center">
        <p className="text-gray-500">{error || 'Booking not found.'}</p>
        <Link href={backHref} className="gf-link mt-4 inline-block">Back to {backLabel}</Link>
      </div>
    )
  }

  let calendarPacket = ''
  try {
    calendarPacket = buildCalendarPacket({
    outletName: booking.outlet.name,
    outletCode: booking.outlet.code,
    programName: booking.program.name,
    programCode: booking.program.code,
    shootDate: booking.shootDate,
    shootEndDate: booking.shootEndDate,
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
  } catch (e) {
    console.error('buildCalendarPacket error:', e)
    calendarPacket = '(calendar packet unavailable)'
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(calendarPacket)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const d = new Date(booking.shootDate)
  const validDate = !isNaN(d.getTime())
  const yy = validDate ? String(d.getFullYear()).slice(-2) : '--'
  const mm = validDate ? String(d.getMonth() + 1).padStart(2, '0') : '--'
  const dd = validDate ? String(d.getDate()).padStart(2, '0') : '--'
  const yyyy = validDate ? d.getFullYear() : '----'
  // Folder named after the first Episode ID (matches the real IDs, e.g. PP-26-006-T02).
  const firstEpisodeId = booking.episodes[0]?.episodeId || `${booking.outlet.code}-${booking.program.code}`
  const driveFolder = `Production/${yyyy}/${mm}/${firstEpisodeId}/`

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-3">
      <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-2">
        <ArrowLeft className="w-4 h-4" /> {backLabel}
      </Link>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* Header */}
      <div className="gf-header p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor(booking.status)}`}>
                {statusLabel(booking.status)}
              </span>
              <span className="text-xs text-gray-400">{categoryLabel(booking.category)}</span>
              {booking.videoType && (
                <span className="text-xs text-gray-400">· {booking.videoType}</span>
              )}
            </div>
            <h1 className="text-2xl font-normal text-gray-800 mb-1">
              {booking.outlet.name} · {bookingShowName(booking)}
            </h1>
            <p className="text-sm text-gray-500">
              {formatDateRange(booking.shootDate, booking.shootEndDate)} · {booking.callTime}
              {booking.estimatedWrap && ` → ${booking.estimatedWrap}`}
              {' · '}{shootTypeLabel(booking.shootType)}
              {booking.locationName && ` @ ${booking.locationName}`}
            </p>
          </div>

          {isStaff && (
            <div className="flex gap-2 flex-shrink-0">
              {booking.status !== 'CANCELLED' && booking.status !== 'COMPLETED' && (
                <button onClick={() => handleStatusChange('CANCELLED')} disabled={updating}
                  className="px-3 py-1.5 text-xs border border-gray-300 rounded text-red-600 hover:border-red-300 hover:bg-red-50 flex items-center gap-1">
                  <XCircle className="w-3.5 h-3.5" /> Cancel
                </button>
              )}
              {booking.status === 'CONFIRMED' && (
                <button onClick={() => handleStatusChange('COMPLETED')} disabled={updating}
                  className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                  Mark Complete
                </button>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div><div className="text-gray-400">Producer</div><div className="font-medium text-gray-800">{booking.producer}</div></div>
          <div><div className="text-gray-400">Creative/Host</div><div className="font-medium text-gray-800">{booking.creative.join(', ') || '—'}</div></div>
          <div><div className="text-gray-400">Crew</div><div className="font-medium text-gray-800">{booking.crewRequired.join(', ') || '—'}</div></div>
          <div><div className="text-gray-400">Agency Ref</div><div className="font-medium text-gray-800">{booking.agencyRef || '—'}</div></div>
        </div>
      </div>

      {/* Episode IDs */}
      <div className="gf-card p-5">
        <div className="text-xs text-gray-500 font-medium mb-2 uppercase tracking-wide">
          Episode IDs ({booking.episodes.length})
        </div>
        <div className="space-y-1.5">
          {booking.episodes.map(ep => (
            <div key={ep.id} className="flex items-center gap-3 py-1">
              <span className="episode-badge">{ep.episodeId}</span>
              <span className="text-sm text-gray-700 flex-1">{ep.title}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Drive path */}
      <div className="gf-card p-4 flex items-start gap-3">
        <Folder className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-gray-500 mb-1">Drive / NAS Folder Path</div>
          <code className="text-xs text-gray-800 font-mono break-all">{driveFolder}</code>
          <div className="mt-2 text-xs text-gray-400">
            Subfolders: 01_Source/Cam1 · 01_Source/Cam2 · 02_Proxy · 03_Edit · 04_Export · 05_Asset · 06_Document
          </div>
        </div>
      </div>

      {/* Calendar packet */}
      <div className="gf-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-medium text-gray-700">Calendar Packet</h2>
          </div>
          <button onClick={handleCopy}
            className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-1">
            {copied ? <><Check className="w-3.5 h-3.5 text-green-500" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
          </button>
        </div>
        <pre className="text-xs bg-gray-50 rounded-lg p-4 font-mono text-gray-700 whitespace-pre-wrap overflow-x-auto border border-gray-100">
{calendarPacket}
        </pre>
      </div>

      {/* Uploads */}
      <div className="gf-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-medium text-gray-700">Footage Uploads ({booking.uploads.length})</h2>
          </div>
          <Link href={`/upload?bookingId=${booking.id}`}
            className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">
            Upload Footage
          </Link>
        </div>
        {booking.uploads.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">No uploads yet.</p>
        ) : (
          <div className="space-y-1.5">
            {booking.uploads.map(up => (
              <div key={up.id} className="flex items-center gap-3 p-2.5 bg-gray-50 rounded text-xs">
                <span className="font-mono text-gray-500 w-12">{up.camera}</span>
                <span className="text-gray-800 flex-1 truncate">{up.fileName}</span>
                {up.episode && <span className="episode-badge">{up.episode.episodeId}</span>}
                <span className={`px-2 py-0.5 rounded-full ${up.status === 'COMPLETE' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {up.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notes */}
      {booking.notes && (
        <div className="gf-card p-4">
          <div className="text-xs text-gray-400 mb-1">Notes</div>
          <p className="text-sm text-gray-700">{booking.notes}</p>
        </div>
      )}
    </div>
  )
}
