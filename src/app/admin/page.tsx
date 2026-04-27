'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { formatDisplayDate, statusLabel } from '@/lib/utils'

interface Episode { episodeId: string; title: string }
interface Booking {
  id: string; shootDate: string; callTime: string; status: string
  producer: string; assignedEmails: string[]
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  createdAt: string
}

const STATUS_BADGE: Record<string, string> = {
  REQUESTED: 'bg-red-100 text-red-700 border border-red-200',
  ASSIGNED:  'bg-yellow-100 text-yellow-700 border border-yellow-200',
  CONFIRMED: 'bg-green-100 text-green-700 border border-green-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border border-gray-200',
  COMPLETED: 'bg-blue-100 text-blue-700 border border-blue-200',
}

const STATUS_ORDER = ['REQUESTED', 'ASSIGNED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']

export default function AdminPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('REQUESTED')

  const fetch_ = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '50', ...(filter && { status: filter }) })
    const res = await fetch(`/api/bookings?${params}`)
    const data = await res.json()
    setBookings(data.bookings || [])
    setTotal(data.total || 0)
    setLoading(false)
  }, [filter])

  useEffect(() => { fetch_() }, [fetch_])

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-normal text-gray-800">Admin Console</h1>
          <div className="flex gap-2">
            <Link href="/admin/permissions" className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">
              Permissions
            </Link>
            <Link href="/" className="gf-submit text-sm">+ New Booking</Link>
          </div>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Review, assign crew, and approve bookings → Google Calendar
        </p>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 mb-5 border-b border-gray-200">
        {STATUS_ORDER.map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors -mb-px ${
              filter === s
                ? 'border-[#673ab7] text-[#673ab7] font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {s === 'REQUESTED' ? '[REQUESTED]' : statusLabel(s)}
          </button>
        ))}
        <button
          onClick={() => setFilter('')}
          className={`px-4 py-2 text-sm border-b-2 transition-colors -mb-px ${
            filter === ''
              ? 'border-[#673ab7] text-[#673ab7] font-medium'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          All
        </button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
      ) : bookings.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">
          No {filter || ''} bookings.
        </div>
      ) : (
        <div className="space-y-3">
          {bookings.map(b => (
            <div key={b.id} className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[b.status] || STATUS_BADGE.REQUESTED}`}>
                      {b.status === 'REQUESTED' ? '[REQUESTED]' : statusLabel(b.status)}
                    </span>
                    <span className="text-xs text-gray-400">
                      {formatDisplayDate(b.shootDate)} · {b.callTime}
                    </span>
                  </div>
                  <div className="font-medium text-gray-800">
                    {b.outlet.name} · {b.program.name}
                  </div>
                  <div className="text-sm text-gray-500 mt-0.5">
                    Producer: {b.producer}
                    {b.assignedEmails.length > 0 && (
                      <span className="ml-2 text-blue-600">
                        → {b.assignedEmails.join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {b.episodes.map(ep => (
                      <span key={ep.episodeId} className="episode-badge text-xs">{ep.episodeId}</span>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 flex-shrink-0">
                  {b.status !== 'CANCELLED' && b.status !== 'COMPLETED' && (
                    <>
                      <Link
                        href={`/admin/${b.id}`}
                        className="px-3 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors"
                      >
                        EDIT
                      </Link>
                      {(b.status === 'ASSIGNED' || b.status === 'REQUESTED') && (
                        <ApproveButton bookingId={b.id} onDone={fetch_} />
                      )}
                    </>
                  )}
                  {b.status === 'CONFIRMED' && (
                    <span className="px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded border border-green-200">
                      ✓ Approved
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ApproveButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handle = async () => {
    if (!confirm('Approve this booking? A Google Calendar event will be created.')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/${bookingId}/approve`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setDone(true)
      setTimeout(onDone, 800)
    } catch (e: any) {
      alert('Approve failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  if (done) return <span className="px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded">✓ Approved</span>
  return (
    <button onClick={handle} disabled={loading}
      className="px-3 py-1.5 text-xs bg-[#673ab7] text-white rounded hover:bg-[#512da8] transition-colors disabled:opacity-50">
      {loading ? '…' : 'APPROVE'}
    </button>
  )
}
