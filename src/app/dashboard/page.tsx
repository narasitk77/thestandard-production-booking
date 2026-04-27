'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { formatDisplayDate, statusColor, statusLabel, shootTypeLabel } from '@/lib/utils'
import { OUTLETS } from '@/lib/data'
import { Search, Filter, ArrowRight, Calendar, RefreshCw } from 'lucide-react'

interface Episode {
  episodeId: string
  title: string
  sequence: number
}

interface Booking {
  id: string
  shootDate: string
  callTime: string
  status: string
  shootType: string
  category: string
  producer: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  createdAt: string
}

export default function DashboardPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [outletFilter, setOutletFilter] = useState('')

  const fetchBookings = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
        ...(statusFilter && { status: statusFilter }),
        ...(outletFilter && { outlet: outletFilter }),
      })
      const res = await fetch(`/api/bookings?${params}`)
      const data = await res.json()
      setBookings(data.bookings || [])
      setTotal(data.total || 0)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, outletFilter])

  useEffect(() => {
    fetchBookings()
  }, [fetchBookings])

  const filtered = search
    ? bookings.filter(b =>
        b.outlet.name.toLowerCase().includes(search.toLowerCase()) ||
        b.program.name.toLowerCase().includes(search.toLowerCase()) ||
        b.producer.toLowerCase().includes(search.toLowerCase()) ||
        b.episodes.some(e =>
          e.episodeId.toLowerCase().includes(search.toLowerCase()) ||
          e.title.toLowerCase().includes(search.toLowerCase())
        )
      )
    : bookings

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-black">Dashboard</h1>
          <p className="text-sm text-brand-gray-500">{total} bookings total</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchBookings} className="btn-secondary p-2">
            <RefreshCw className="w-4 h-4" />
          </button>
          <Link href="/" className="btn-primary">
            + New Booking
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-brand-gray-400" />
          <input
            type="text"
            className="input pl-9"
            placeholder="Search Episode ID, program, producer..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className="input w-auto"
          value={outletFilter}
          onChange={e => { setOutletFilter(e.target.value); setPage(1) }}
        >
          <option value="">All Outlets</option>
          {OUTLETS.map(o => (
            <option key={o.code} value={o.code}>{o.code} — {o.name}</option>
          ))}
        </select>
        <select
          className="input w-auto"
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
        >
          <option value="">All Status</option>
          <option value="PENDING">Pending</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-black"></div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <Calendar className="w-10 h-10 text-brand-gray-300 mx-auto mb-3" />
          <p className="text-brand-gray-500 text-sm">No bookings found.</p>
          <Link href="/" className="btn-primary mt-4 inline-flex">Create First Booking</Link>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-brand-gray-50 border-b border-brand-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-brand-gray-500 uppercase tracking-wide">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-brand-gray-500 uppercase tracking-wide">Outlet / Program</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-brand-gray-500 uppercase tracking-wide">Episode IDs</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-brand-gray-500 uppercase tracking-wide">Producer</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-brand-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-gray-100">
                {filtered.map(booking => (
                  <tr key={booking.id} className="hover:bg-brand-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-brand-black">{formatDisplayDate(booking.shootDate)}</div>
                      <div className="text-xs text-brand-gray-400">{booking.callTime}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-brand-black">{booking.outlet.name}</div>
                      <div className="text-xs text-brand-gray-500">{booking.program.name}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {booking.episodes.slice(0, 2).map(ep => (
                          <span key={ep.episodeId} className="episode-badge text-xs">
                            {ep.episodeId}
                          </span>
                        ))}
                        {booking.episodes.length > 2 && (
                          <span className="text-xs text-brand-gray-400 self-center">
                            +{booking.episodes.length - 2} more
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-brand-gray-700">{booking.producer}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor(booking.status)}`}>
                        {statusLabel(booking.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/${booking.id}`}
                        className="text-brand-gray-400 hover:text-brand-black transition-colors"
                      >
                        <ArrowRight className="w-4 h-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      {total > 20 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-brand-gray-500">
            Showing {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} of {total}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * 20 >= total}
              className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
