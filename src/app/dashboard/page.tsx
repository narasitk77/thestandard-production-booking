'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { formatDisplayDate, statusColor, statusLabel } from '@/lib/utils'
import { OUTLETS } from '@/lib/data'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'

interface Episode { episodeId: string; title: string }
interface Booking {
  id: string; shootDate: string; callTime: string; status: string
  shootType: string; producer: string; category: string
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}

const STATUS_PIE: { name: string; key: string; color: string }[] = [
  { name: '[REQUESTED]', key: 'REQUESTED', color: '#ef4444' },
  { name: 'Confirmed',   key: 'CONFIRMED', color: '#22c55e' },
  { name: 'Completed',   key: 'COMPLETED', color: '#3b82f6' },
  { name: 'Cancelled',   key: 'CANCELLED', color: '#9ca3af' },
]

export default function DashboardPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [outletFilter, setOutletFilter] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    fetch('/api/bookings?limit=500')
      .then(r => r.json())
      .then(d => setBookings(d.bookings || []))
      .finally(() => setLoading(false))
  }, [])

  const statusData = useMemo(() => {
    const counts: Record<string, number> = {}
    bookings.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1 })
    return STATUS_PIE.map(s => ({ name: s.name, key: s.key, value: counts[s.key] || 0, color: s.color }))
      .filter(s => s.value > 0)
  }, [bookings])

  const outletData = useMemo(() => {
    const counts: Record<string, { count: number; outlet: string }> = {}
    bookings.forEach(b => {
      const k = b.outlet.code
      if (!counts[k]) counts[k] = { count: 0, outlet: b.outlet.name }
      counts[k].count += 1
    })
    return Object.entries(counts).map(([code, v]) => ({ code, name: v.outlet, count: v.count }))
      .sort((a, b) => b.count - a.count)
  }, [bookings])

  const filtered = useMemo(() => {
    return bookings.filter(b => {
      if (statusFilter && b.status !== statusFilter) return false
      if (outletFilter && b.outlet.code !== outletFilter) return false
      if (search) {
        const hay = [b.outlet.name, b.program.name, b.producer, ...b.episodes.map(e => e.episodeId + ' ' + e.title)]
          .join(' ').toLowerCase()
        if (!hay.includes(search.toLowerCase())) return false
      }
      return true
    })
  }, [bookings, statusFilter, outletFilter, search])

  const total = bookings.length

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-normal text-gray-800">Dashboard</h1>
          <p className="text-sm text-gray-500">{total} total bookings · {filtered.length} shown</p>
        </div>
        <Link href="/" className="gf-submit">+ New Booking</Link>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {/* Donut: bookings by status */}
        <div className="gf-card p-5">
          <div className="text-sm font-medium text-gray-700 mb-3">Bookings by Status</div>
          {loading ? (
            <div className="h-64 flex items-center justify-center text-sm text-gray-400">Loading…</div>
          ) : statusData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-gray-400">No data</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%" cy="50%"
                  innerRadius={55} outerRadius={90}
                  paddingAngle={2}
                  dataKey="value"
                  onClick={(d: any) => setStatusFilter(prev => prev === d.key ? '' : d.key)}
                  cursor="pointer"
                >
                  {statusData.map((d, i) => (
                    <Cell key={i} fill={d.color}
                      stroke={statusFilter === d.key ? '#673ab7' : '#fff'}
                      strokeWidth={statusFilter === d.key ? 3 : 2}
                      opacity={statusFilter && statusFilter !== d.key ? 0.4 : 1}
                    />
                  ))}
                </Pie>
                <Tooltip formatter={(v: any) => `${v} booking${v === 1 ? '' : 's'}`} />
                <Legend
                  iconType="circle"
                  formatter={(value, entry: any) => (
                    <span className="text-xs text-gray-600 cursor-pointer hover:text-gray-900">
                      {value} <span className="text-gray-400">({entry.payload.value})</span>
                    </span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
          {statusFilter && (
            <button onClick={() => setStatusFilter('')}
              className="text-xs text-[#673ab7] hover:underline mt-1">
              Clear filter ({statusFilter}) ×
            </button>
          )}
        </div>

        {/* Bar: bookings by outlet */}
        <div className="gf-card p-5">
          <div className="text-sm font-medium text-gray-700 mb-3">Bookings by Outlet</div>
          {loading ? (
            <div className="h-64 flex items-center justify-center text-sm text-gray-400">Loading…</div>
          ) : outletData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-gray-400">No data</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={outletData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="code" tick={{ fontSize: 11, fill: '#6b7280' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6 }}
                  formatter={(v: any) => `${v} booking${v === 1 ? '' : 's'}`}
                  labelFormatter={(label) => outletData.find(o => o.code === label)?.name || label}
                />
                <Bar
                  dataKey="count"
                  fill="#673ab7"
                  cursor="pointer"
                  onClick={(d: any) => setOutletFilter(prev => prev === d.code ? '' : d.code)}
                >
                  {outletData.map((d, i) => (
                    <Cell key={i}
                      fill={outletFilter === d.code ? '#512da8' : '#673ab7'}
                      opacity={outletFilter && outletFilter !== d.code ? 0.4 : 1}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          {outletFilter && (
            <button onClick={() => setOutletFilter('')}
              className="text-xs text-[#673ab7] hover:underline mt-1">
              Clear filter ({outletFilter}) ×
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-3">
        <input
          className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-48 focus:outline-none focus:border-[#673ab7]"
          placeholder="Search by Episode ID, program, producer…"
          value={search} onChange={e => setSearch(e.target.value)}
        />
        <select className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#673ab7]"
          value={outletFilter} onChange={e => setOutletFilter(e.target.value)}>
          <option value="">All Outlets</option>
          {OUTLETS.map(o => <option key={o.code} value={o.code}>{o.name}</option>)}
        </select>
        <select className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#673ab7]"
          value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Status</option>
          {['REQUESTED','CONFIRMED','COMPLETED','CANCELLED'].map(s =>
            <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No bookings match these filters.
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
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor(b.status)}`}>
                      {b.status === 'REQUESTED' ? '[REQUESTED]' : statusLabel(b.status)}
                    </span>
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
    </div>
  )
}
