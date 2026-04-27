'use client'

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { formatDisplayDate, buildCalendarPacket, statusColor, statusLabel, shootTypeLabel, categoryLabel } from '@/lib/utils'
import { ArrowLeft, Copy, Check, Calendar, Folder, Upload, CheckCircle2, XCircle, Loader2 } from 'lucide-react'

interface Episode {
  id: string
  episodeId: string
  sequence: number
  title: string
}

interface UploadRecord {
  id: string
  camera: string
  fileName: string
  fileSize: bigint | null
  status: string
  uploadedBy: string
  createdAt: string
  episode: { episodeId: string } | null
}

interface BookingDetail {
  id: string
  shootDate: string
  callTime: string
  estimatedWrap?: string
  status: string
  category: string
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

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [booking, setBooking] = useState<BookingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    fetch(`/api/bookings/${id}`)
      .then(r => r.json())
      .then(data => setBooking(data.booking))
      .finally(() => setLoading(false))
  }, [id])

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
      setBooking(prev => prev ? { ...prev, status: data.booking.status } : prev)
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-gray-400" />
      </div>
    )
  }

  if (!booking) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-20 text-center">
        <p className="text-brand-gray-500">Booking not found.</p>
        <Link href="/dashboard" className="btn-primary mt-4">Back to Dashboard</Link>
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

  const d = new Date(booking.shootDate)
  const driveFolder = `Production/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${booking.outlet.code}-${booking.shootDate.slice(2, 4)}${booking.shootDate.slice(5, 7)}${booking.shootDate.slice(8, 10)}-${booking.program.code}/`

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Back */}
      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-brand-gray-500 hover:text-brand-black mb-5">
        <ArrowLeft className="w-4 h-4" /> Dashboard
      </Link>

      {/* Header */}
      <div className="card p-5 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor(booking.status)}`}>
                {statusLabel(booking.status)}
              </span>
              <span className="text-xs text-brand-gray-400">{categoryLabel(booking.category)}</span>
            </div>
            <h1 className="text-xl font-bold text-brand-black mb-1">
              {booking.outlet.name} · {booking.program.name}
            </h1>
            <p className="text-sm text-brand-gray-500">
              {formatDisplayDate(booking.shootDate)} · {booking.callTime}
              {booking.estimatedWrap && ` → ${booking.estimatedWrap}`}
              {' · '}{shootTypeLabel(booking.shootType)}
              {booking.locationName && ` @ ${booking.locationName}`}
            </p>
          </div>

          {/* Status actions */}
          <div className="flex gap-2 flex-shrink-0">
            {booking.status === 'PENDING' && (
              <button
                onClick={() => handleStatusChange('CONFIRMED')}
                disabled={updating}
                className="btn-primary text-xs px-3 py-1.5"
              >
                {updating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                Confirm
              </button>
            )}
            {booking.status !== 'CANCELLED' && booking.status !== 'COMPLETED' && (
              <button
                onClick={() => handleStatusChange('CANCELLED')}
                disabled={updating}
                className="btn-secondary text-xs px-3 py-1.5 text-red-600 hover:border-red-300"
              >
                <XCircle className="w-3.5 h-3.5" /> Cancel
              </button>
            )}
            {booking.status === 'CONFIRMED' && (
              <button
                onClick={() => handleStatusChange('COMPLETED')}
                disabled={updating}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                Mark Complete
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-brand-gray-100 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-brand-gray-400">Producer</div>
            <div className="font-medium text-brand-black">{booking.producer}</div>
          </div>
          <div>
            <div className="text-brand-gray-400">Creative/Host</div>
            <div className="font-medium text-brand-black">{booking.creative.join(', ') || '—'}</div>
          </div>
          <div>
            <div className="text-brand-gray-400">Crew</div>
            <div className="font-medium text-brand-black">{booking.crewRequired.join(', ') || '—'}</div>
          </div>
          <div>
            <div className="text-brand-gray-400">Agency Ref</div>
            <div className="font-medium text-brand-black">{booking.agencyRef || '—'}</div>
          </div>
        </div>
      </div>

      {/* Episode IDs */}
      <div className="card p-5 mb-4">
        <h2 className="font-semibold text-sm text-brand-gray-700 mb-3">
          Episode IDs ({booking.episodes.length})
        </h2>
        <div className="space-y-2">
          {booking.episodes.map(ep => (
            <div key={ep.id} className="flex items-center gap-3 p-3 bg-brand-gray-50 rounded-lg">
              <span className="episode-badge">{ep.episodeId}</span>
              <span className="text-sm text-brand-gray-700 flex-1">{ep.title}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Drive path */}
      <div className="card p-4 mb-4 flex items-start gap-3">
        <Folder className="w-5 h-5 text-brand-gold mt-0.5 flex-shrink-0" />
        <div>
          <div className="text-xs text-brand-gray-500 mb-1">Drive / NAS Folder Path</div>
          <code className="text-xs text-brand-black font-mono break-all">{driveFolder}</code>
          <div className="mt-2 text-xs text-brand-gray-400">
            Subfolders: 01_Source/Cam1 · 01_Source/Cam2 · 02_Proxy · 03_Edit · 04_Export · 05_Asset · 06_Document
          </div>
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

      {/* Uploads */}
      <div className="card p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-brand-gray-500" />
            <h2 className="font-semibold text-sm text-brand-gray-700">Footage Uploads ({booking.uploads.length})</h2>
          </div>
          <Link href={`/upload?bookingId=${booking.id}`} className="btn-secondary text-xs px-3 py-1.5">
            Upload Footage
          </Link>
        </div>
        {booking.uploads.length === 0 ? (
          <p className="text-xs text-brand-gray-400 text-center py-4">No uploads yet.</p>
        ) : (
          <div className="space-y-2">
            {booking.uploads.map(up => (
              <div key={up.id} className="flex items-center gap-3 p-2.5 bg-brand-gray-50 rounded-lg text-xs">
                <span className="font-mono text-brand-gray-500">{up.camera}</span>
                <span className="text-brand-black flex-1 truncate">{up.fileName}</span>
                {up.episode && (
                  <span className="episode-badge text-xs">{up.episode.episodeId}</span>
                )}
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
        <div className="card p-4 mb-4">
          <div className="text-xs text-brand-gray-400 mb-1">Notes</div>
          <p className="text-sm text-brand-gray-700">{booking.notes}</p>
        </div>
      )}
    </div>
  )
}
