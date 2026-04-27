'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { formatDisplayDate, statusColor, statusLabel, shootTypeLabel } from '@/lib/utils'
import { OUTLETS } from '@/lib/data'

interface Episode { episodeId: string; title: string }
interface Booking {
  id: string; shootDate: string; callTime: string; status: string
  shootType: string; producer: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
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
    const params = new URLSearchParams({ page: String(page), limit: '20', ...(statusFilter && { status: statusFilter }), ...(outletFilter && { outlet: outletFilter }) })
    const res = await fetch(`/api/bookings?${params}`)
    const data = await res.json()
    setBookings(data.bookings || [])
    setTotal(data.total || 0)
    setLoading(false)
  }, [page, statusFilter, outletFilter])

  useEffect(() => { fetchBookings() }, [fetchBookings])

  const filtered = search
    ? bookings.filter(b =>
        [b.outlet.name, b.program.name, b.producer, ...b.episodes.map(e => e.episodeId + ' ' + e.title)]
          .join(' ').toLowerCase().includes(search.toLowerCase()))
    : bookings

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-normal text-gray-800">Dashboard</h1>
          <p className="text-sm text-gray-500">{total} bookings</p>
        </div>
        <Link href="/" className="gf-submit">+ New Booking</Link>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <input
          className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-48 focus:outline-none focus:border-[#673ab7]"
          placeholder="Search by Episode ID, program, producer…"
          value={search} onChange={e => setSearch(e.target.value)}
        />
        <select className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#673ab7]"
          value={outletFilter} onChange={e => { setOutletFilter(e.target.value); setPage(1) }}>
          <option value="">All Outlets</option>
          {OUTLETS.map(o => <option key={o.code} value={o.code}>{o.name}</option>)}
        </select>
        <select className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#673ab7]"
          value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
          <option value="">All Status</option>
          {['REQUESTED','ASSIGNED','CONFIRMED','COMPLETED','CANCELLED'].map(s =>
            <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No bookings found. <Link href="/" className="gf-link">Create one</Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Date', 'Outlet / Program', 'Episode IDs', 'Producer', 'Status', ''].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(b => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{formatDisplayDate(b.shootDate)}</div>
                    <div className="text-xs text-gray-400">{b.callTime}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-gray-800">{b.outlet.name}</div>
                    <div className="text-xs text-gray-500">{b.program.name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {b.episodes.slice(0, 2).map(ep => (
                        <span key={ep.episodeId} className="episode-badge">{ep.episodeId}</span>
                      ))}
                      {b.episodes.length > 2 && <span className="text-xs text-gray-400 self-center">+{b.episodes.length - 2}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{b.producer}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor(b.status)}`}>{statusLabel(b.status)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/${b.id}`} className="gf-link text-xs">View →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {total > 20 && (
        <div className="flex justify-between items-center mt-4 text-sm text-gray-500">
          <span>Showing {(page-1)*20+1}–{Math.min(page*20,total)} of {total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1,p-1))} disabled={page===1}
              className="px-3 py-1 border border-gray-300 rounded text-sm disabled:opacity-40 hover:bg-gray-50">← Prev</button>
            <button onClick={() => setPage(p => p+1)} disabled={page*20>=total}
              className="px-3 py-1 border border-gray-300 rounded text-sm disabled:opacity-40 hover:bg-gray-50">Next →</button>
          </div>
        </div>
      )}
    </div>
  )
}
