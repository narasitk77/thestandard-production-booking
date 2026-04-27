'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDisplayDate, statusLabel } from '@/lib/utils'

interface Episode { episodeId: string; title: string }
interface Booking {
  id: string; shootDate: string; callTime: string; status: string
  shootType: string; producer: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}

const STATUS_BADGE: Record<string, string> = {
  REQUESTED: 'bg-red-100 text-red-700 border border-red-200',
  ASSIGNED:  'bg-yellow-100 text-yellow-700 border border-yellow-200',
  CONFIRMED: 'bg-green-100 text-green-700 border border-green-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border border-gray-200',
  COMPLETED: 'bg-blue-100 text-blue-700 border border-blue-200',
}

export default function MyBookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'mine' | 'confirmed'>('mine')

  useEffect(() => {
    setLoading(true)
    const scope = tab === 'mine' ? 'mine' : ''
    const status = tab === 'confirmed' ? 'CONFIRMED' : ''
    const params = new URLSearchParams({ limit: '50', ...(scope && { scope }), ...(status && { status }) })
    fetch(`/api/bookings?${params}`)
      .then(r => r.json())
      .then(d => setBookings(d.bookings || []))
      .finally(() => setLoading(false))
  }, [tab])

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-normal text-gray-800">My Bookings</h1>
          <p className="text-sm text-gray-500">Bookings you requested or are assigned to</p>
        </div>
        <Link href="/" className="gf-submit">+ New Booking</Link>
      </div>

      <div className="flex gap-2 mb-4 border-b border-gray-200">
        {[
          { key: 'mine', label: 'Mine (Requested + Assigned)' },
          { key: 'confirmed', label: 'All Confirmed' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as any)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${
              tab === t.key
                ? 'border-[#673ab7] text-[#673ab7] font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-20 text-center text-gray-400 text-sm">Loading…</div>
      ) : bookings.length === 0 ? (
        <div className="py-20 text-center text-gray-400 text-sm">
          No bookings here. <Link href="/" className="gf-link">Create one</Link>
        </div>
      ) : (
        <div className="space-y-2">
          {bookings.map(b => (
            <Link key={b.id} href={`/dashboard/${b.id}`}
              className="gf-card p-4 flex items-center gap-4 hover:border-[#673ab7] transition-colors">
              <div className="flex-shrink-0 text-center w-20">
                <div className="text-xs text-gray-400">{formatDisplayDate(b.shootDate).split(' ')[0]}</div>
                <div className="text-lg font-medium text-gray-800">{b.shootDate.slice(8, 10)}</div>
                <div className="text-xs text-gray-400">{b.callTime}</div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-800 font-medium truncate">{b.outlet.name} · {b.program.name}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {b.episodes.slice(0, 2).map(e => e.episodeId).join(' · ')}
                  {b.episodes.length > 2 && ` +${b.episodes.length - 2}`}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">Producer: {b.producer}</div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[b.status] || ''}`}>
                {statusLabel(b.status).replace(/[\[\]]/g, '')}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
