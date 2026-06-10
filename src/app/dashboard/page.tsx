'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import { formatDisplayDate } from '@/lib/utils'
import { OUTLETS } from '@/lib/data'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import { Download, Search, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react'
import StatusPill from '@/app/_components/StatusPill'
import type { ProjectMonitorRow } from '@/app/api/projects/monitor/route'

interface Episode { episodeId: string; title: string }
interface Booking {
  id: string; shootDate: string; callTime: string; estimatedWrap?: string; status: string
  shootType: string; producer: string; category: string
  assignedEmails: string[]
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}

function parseTimeToMinutes(t?: string | null): number | null {
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return null
  return parseInt(m[1]) * 60 + parseInt(m[2])
}

// Default duration when no wrap time specified
const DEFAULT_DURATION_HOURS = 4

function bookingHours(b: Booking): number {
  const start = parseTimeToMinutes(b.callTime)
  const end = parseTimeToMinutes(b.estimatedWrap)
  if (start == null) return DEFAULT_DURATION_HOURS
  if (end == null) return DEFAULT_DURATION_HOURS
  const diff = end - start
  if (diff <= 0) return DEFAULT_DURATION_HOURS
  return Math.round((diff / 60) * 100) / 100
}

interface TeamRow {
  email: string
  bookingCount: number
  totalHours: number
  bookings: Booking[]
}

// Color values mirror the status palette in tailwind.config.ts so the donut
// reads identically to StatusPill in the table below.
const STATUS_PIE: { name: string; key: string; color: string }[] = [
  { name: 'Requested', key: 'REQUESTED', color: '#EF4444' },
  { name: 'Assigned',  key: 'ASSIGNED',  color: '#F59E0B' },
  { name: 'Confirmed', key: 'CONFIRMED', color: '#10B981' },
  { name: 'Completed', key: 'COMPLETED', color: '#3B82F6' },
  { name: 'Cancelled', key: 'CANCELLED', color: '#94A3B8' },
]

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
function monthStartISO(): string {
  const d = new Date()
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}

export default function DashboardPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [outletFilter, setOutletFilter] = useState('')
  const [search, setSearch] = useState('')

  // Team workload range
  const [rangeFrom, setRangeFrom] = useState(monthStartISO())
  const [rangeTo, setRangeTo] = useState(todayISO())
  const [includeRequested, setIncludeRequested] = useState(false)
  const [teamSort, setTeamSort] = useState<'hours' | 'count'>('hours')

  // Sheet monitor state
  const [sheetProjects, setSheetProjects] = useState<ProjectMonitorRow[] | null>(null)
  const [sheetLoading, setSheetLoading] = useState(false)
  const [sheetError, setSheetError] = useState('')
  const [sheetTs, setSheetTs] = useState<Date | null>(null)
  const [sheetSyncing, setSheetSyncing] = useState(false)
  const [sheetSyncMsg, setSheetSyncMsg] = useState('')
  const [sheetSearch, setSheetSearch] = useState('')
  const [sheetFilter, setSheetFilter] = useState<'all' | 'active' | 'unbooked'>('all')

  useEffect(() => {
    setLoading(true)
    fetch('/api/bookings?limit=500')
      .then(r => r.json())
      .then(d => setBookings(d.bookings || []))
      .finally(() => setLoading(false))
  }, [])

  const fetchSheetMonitor = useCallback((refresh = false) => {
    setSheetLoading(true)
    setSheetError('')
    const url = refresh ? '/api/projects/monitor?refresh=1' : '/api/projects/monitor'
    fetch(url)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setSheetError(d.error); return }
        setSheetProjects(d.projects || [])
        setSheetTs(new Date(d.ts))
      })
      .catch(e => setSheetError(String(e)))
      .finally(() => setSheetLoading(false))
  }, [])

  const handleSheetSync = useCallback(() => {
    setSheetSyncing(true)
    setSheetSyncMsg('')
    fetch('/api/projects/monitor?refresh=1')
      .then(r => r.json())
      .then(d => {
        if (d.error) { setSheetError(d.error); return }
        setSheetProjects(d.projects || [])
        setSheetTs(new Date(d.ts))
        setSheetSyncMsg(`Synced — ${d.total} projects`)
        setTimeout(() => setSheetSyncMsg(''), 4000)
      })
      .catch(e => setSheetError(String(e)))
      .finally(() => setSheetSyncing(false))
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

  // Team workload aggregation
  const teamData = useMemo(() => {
    const validStatuses = includeRequested
      ? ['REQUESTED', 'CONFIRMED', 'COMPLETED']
      : ['CONFIRMED', 'COMPLETED']

    const inRange = bookings.filter(b => {
      const d = b.shootDate.slice(0, 10)
      if (rangeFrom && d < rangeFrom) return false
      if (rangeTo && d > rangeTo) return false
      return validStatuses.includes(b.status)
    })

    const map = new Map<string, TeamRow>()
    inRange.forEach(b => {
      const hours = bookingHours(b)
      ;(b.assignedEmails || []).forEach(email => {
        if (!email) return
        const e = email.toLowerCase()
        if (!map.has(e)) map.set(e, { email: e, bookingCount: 0, totalHours: 0, bookings: [] })
        const row = map.get(e)!
        row.bookingCount += 1
        row.totalHours += hours
        row.bookings.push(b)
      })
    })

    const rows = Array.from(map.values()).map(r => ({
      ...r,
      totalHours: Math.round(r.totalHours * 100) / 100,
    }))
    rows.sort((a, b) => teamSort === 'hours'
      ? b.totalHours - a.totalHours
      : b.bookingCount - a.bookingCount)
    return rows
  }, [bookings, rangeFrom, rangeTo, includeRequested, teamSort])

  const teamTotals = useMemo(() => ({
    bookings: teamData.reduce((s, r) => s + r.bookingCount, 0),
    hours: Math.round(teamData.reduce((s, r) => s + r.totalHours, 0) * 100) / 100,
    people: teamData.length,
  }), [teamData])

  const exportTeamCSV = () => {
    const header = ['Email', 'Bookings Assigned', 'Total Hours', 'Avg Hours per Booking', 'Date Range', 'Production IDs']
    const rows = teamData.map(r => [
      r.email,
      String(r.bookingCount),
      String(r.totalHours),
      r.bookingCount > 0 ? String(Math.round((r.totalHours / r.bookingCount) * 100) / 100) : '0',
      `${rangeFrom} to ${rangeTo}`,
      r.bookings.map(b => b.id).join(';'),
    ])
    const csv = [header, ...rows]
      .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `team-workload_${rangeFrom}_to_${rangeTo}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const exportBookingsCSV = () => {
    const header = ['Date', 'Call Time', 'Wrap', 'Status', 'Outlet', 'Program', 'Shoot Type', 'Producer', 'Episodes', 'Assigned', 'Production ID']
    const rows = filtered.map(b => [
      b.shootDate.slice(0, 10),
      b.callTime,
      b.estimatedWrap || '',
      b.status,
      b.outlet.name,
      b.program.name,
      b.shootType,
      b.producer,
      b.episodes.map(e => e.episodeId).join(';'),
      (b.assignedEmails || []).join(';'),
      b.id,
    ])
    const csv = [header, ...rows]
      .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bookings_${todayISO()}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

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
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="flex items-start sm:items-center justify-between gap-2 mb-4 flex-wrap">
        <div>
          <h1>Admin Dashboard</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Org-wide booking metrics, team workload, and exports · {total} total · {filtered.length} shown
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={exportBookingsCSV} className="ops-btn-secondary ops-btn-sm">
            <Download className="w-3.5 h-3.5" /> Export Bookings
          </button>
          <Link href="/new" className="ops-btn-primary ops-btn-sm">+ New Booking</Link>
        </div>
      </div>

      {/* Section: Booking Overview */}
      <SectionLabel index={1} title="Booking Overview"
        hint={<>คลิกที่ slice/แท่งเพื่อกรองตาราง · ดู Producer Dashboard ที่หน้า <Link href="/producer" className="text-brand-primary hover:underline">Producer</Link> สำหรับมุมมองส่วนตัว</>}
      />

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2 mt-3">
        {/* Donut: bookings by status */}
        <div className="ops-card ops-card-pad">
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
                      stroke={statusFilter === d.key ? '#111827' : '#fff'}
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
              className="text-xs text-brand-primary hover:underline mt-1">
              Clear filter ({statusFilter}) ×
            </button>
          )}
        </div>

        {/* Bar: bookings by outlet */}
        <div className="ops-card ops-card-pad">
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
              className="text-xs text-brand-primary hover:underline mt-1">
              Clear filter ({outletFilter}) ×
            </button>
          )}
        </div>
      </div>

      {/* Section: Team Workload */}
      <SectionLabel index={2} title="Team Workload"
        hint={<>ชั่วโมง assignment ของ crew ในช่วงที่เลือก · ใช้สำหรับวางแผน utilization และ exports</>}
      />

      <div className="ops-card ops-card-pad mt-3 mb-2">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="text-sm font-medium text-gray-700">Team Workload</div>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={rangeFrom} onChange={e => setRangeFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1 text-xs" />
            <span className="text-xs text-gray-400">to</span>
            <input type="date" value={rangeTo} onChange={e => setRangeTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1 text-xs" />
            <button onClick={() => { setRangeFrom(monthStartISO()); setRangeTo(todayISO()) }}
              className="ops-btn-secondary ops-btn-sm">This month</button>
            <label className="flex items-center gap-1 text-xs text-gray-500 ml-2">
              <input type="checkbox" checked={includeRequested}
                onChange={e => setIncludeRequested(e.target.checked)}
                className="accent-brand-primary" />
              Include Requested
            </label>
            <select value={teamSort} onChange={e => setTeamSort(e.target.value as any)}
              className="text-xs border border-gray-300 rounded-lg px-2 py-1">
              <option value="hours">Sort: Hours</option>
              <option value="count">Sort: Bookings</option>
            </select>
            <button onClick={exportTeamCSV} className="ops-btn-secondary ops-btn-sm">
              <Download className="w-3 h-3" /> Export CSV
            </button>
          </div>
        </div>

        <div className="text-xs text-gray-500 mb-3">
          {teamTotals.people} people · {teamTotals.bookings} assignments · {teamTotals.hours} hours total
          {' · '}
          <span className="text-gray-400">
            (Status counted: {includeRequested ? 'Requested + Confirmed + Completed' : 'Confirmed + Completed only'})
          </span>
        </div>

        {teamData.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">
            No assignments in the selected range.
          </div>
        ) : (
          <>
            {/* Top-N bar chart */}
            <div className="mb-4 -mx-1">
              <ResponsiveContainer width="100%" height={Math.min(280, 40 + teamData.length * 28)}>
                <BarChart data={teamData.slice(0, 12)} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#6b7280' }} />
                  <YAxis type="category" dataKey="email" width={180}
                    tick={{ fontSize: 11, fill: '#374151' }}
                    tickFormatter={(v: string) => v.split('@')[0]} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 6 }}
                    formatter={(v: any, name: any) => [
                      teamSort === 'hours' ? `${v} hours` : `${v} bookings`,
                      teamSort === 'hours' ? 'Total Hours' : 'Bookings'
                    ]}
                  />
                  <Bar
                    dataKey={teamSort === 'hours' ? 'totalHours' : 'bookingCount'}
                    fill="#673ab7"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Detailed table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200">
                  <tr className="text-xs text-gray-500 uppercase tracking-wide">
                    <th className="text-left py-2 pr-3">#</th>
                    <th className="text-left py-2 pr-3">Email</th>
                    <th className="text-right py-2 pr-3">Bookings</th>
                    <th className="text-right py-2 pr-3">Total Hours</th>
                    <th className="text-right py-2 pr-3">Avg / Booking</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {teamData.map((r, i) => (
                    <tr key={r.email} className="hover:bg-gray-50">
                      <td className="py-2 pr-3 text-gray-400">{i + 1}</td>
                      <td className="py-2 pr-3 text-gray-800">{r.email}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-gray-800">{r.bookingCount}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-gray-800 font-medium">{r.totalHours}h</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-gray-500">
                        {r.bookingCount > 0 ? (Math.round((r.totalHours / r.bookingCount) * 100) / 100) : 0}h
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Section: All Bookings */}
      <SectionLabel index={3} title="All Bookings"
        hint={<>ค้นหา/กรองตาม Outlet · Status · Episode ID · ใช้ Export ด้านบนเพื่อโหลด CSV ของผลลัพธ์</>}
      />

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3 mt-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          <input
            className="ops-input pl-8"
            placeholder="Search by Episode ID, program, producer…"
            value={search} onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="ops-input w-auto" value={outletFilter} onChange={e => setOutletFilter(e.target.value)}>
          <option value="">All Outlets</option>
          {OUTLETS.map(o => <option key={o.code} value={o.code}>{o.name}</option>)}
        </select>
        <select className="ops-input w-auto" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Status</option>
          {['REQUESTED','ASSIGNED','CONFIRMED','COMPLETED','CANCELLED'].map(s =>
            <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="ops-card overflow-hidden">
        {loading ? (
          <div className="ops-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="ops-empty">No bookings match these filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="ops-table min-w-[640px]">
              <thead>
                <tr>
                  {['Date', 'Outlet / Program', 'Episode IDs', 'Producer', 'Status', ''].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(b => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td>
                      <div className="font-medium text-gray-800">{formatDisplayDate(b.shootDate)}</div>
                      <div className="text-xs text-gray-400 tabular-nums">{b.callTime}</div>
                    </td>
                    <td>
                      <div className="text-gray-800">{b.outlet.name}</div>
                      <div className="text-xs text-gray-500">{b.program.name}</div>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {b.episodes.slice(0, 2).map(ep => (
                          <span key={ep.episodeId} className="episode-badge">{ep.episodeId}</span>
                        ))}
                        {b.episodes.length > 2 && <span className="text-xs text-gray-400 self-center">+{b.episodes.length - 2}</span>}
                      </div>
                    </td>
                    <td className="text-gray-700">{b.producer}</td>
                    <td><StatusPill status={b.status} /></td>
                    <td>
                      <Link href={`/dashboard/${b.id}`} className="text-xs text-brand-primary hover:underline">View →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 4: Sheet Data Monitor */}
      <SectionLabel index={4} title="Sheet Data Monitor"
        hint={<>Projects จาก Producer Dashboard Sheet · Episode statuses · Booking counts · กด Sync เพื่อ refresh ทันที</>}
      />

      <SheetMonitor
        projects={sheetProjects}
        loading={sheetLoading}
        error={sheetError}
        ts={sheetTs}
        syncing={sheetSyncing}
        syncMsg={sheetSyncMsg}
        search={sheetSearch}
        filter={sheetFilter}
        onSearch={setSheetSearch}
        onFilter={setSheetFilter}
        onLoad={() => { if (!sheetProjects && !sheetLoading) fetchSheetMonitor(false) }}
        onRefresh={() => fetchSheetMonitor(false)}
        onSync={handleSheetSync}
      />
    </div>
  )
}

/* ---------- Sheet Monitor ---------- */

const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes

function SheetMonitor({
  projects, loading, error, ts, syncing, syncMsg,
  search, filter, onSearch, onFilter, onLoad, onRefresh, onSync,
}: {
  projects: ProjectMonitorRow[] | null
  loading: boolean
  error: string
  ts: Date | null
  syncing: boolean
  syncMsg: string
  search: string
  filter: 'all' | 'active' | 'unbooked'
  onSearch: (v: string) => void
  onFilter: (v: 'all' | 'active' | 'unbooked') => void
  onLoad: () => void
  onRefresh: () => void
  onSync: () => void
}) {
  // Initial load + auto-poll every 2 minutes (quiet, no cache bust)
  useEffect(() => {
    onLoad()
    const id = setInterval(onRefresh, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!projects) return []
    return projects.filter(p => {
      if (filter === 'active') {
        const hasActive = p.epCounts.production > 0 || p.epCounts.preProduction > 0 || p.epCounts.postProduction > 0 || p.epCounts.pending > 0 || p.epCounts.other > 0
        if (!hasActive) return false
      }
      if (filter === 'unbooked' && p.bookingCount > 0) return false
      if (search) {
        const hay = [p.projectId, p.projectName, p.client, p.producer, p.director].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(search.toLowerCase())) return false
      }
      return true
    })
  }, [projects, filter, search])

  const stats = useMemo(() => {
    if (!projects) return null
    return {
      total: projects.length,
      bookable: projects.filter(p => p.isBookable).length,
      active: projects.filter(p => p.epCounts.production > 0).length,
      unbooked: projects.filter(p => p.bookingCount === 0 && p.isBookable).length,
    }
  }, [projects])

  const syncAgo = ts ? Math.round((Date.now() - ts.getTime()) / 60000) : null
  const syncLabel = ts
    ? ts.toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        day: 'numeric', month: 'short', year: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : null

  return (
    <div className="ops-card overflow-hidden mt-3 mb-6">
      {/* Toolbar */}
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-40">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          <input
            className="ops-input pl-8 py-1 text-xs"
            placeholder="ค้นหา Project ID, ชื่อ, Client, Producer…"
            value={search}
            onChange={e => onSearch(e.target.value)}
          />
        </div>

        {/* Filter tabs */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          {(['all', 'active', 'unbooked'] as const).map(f => (
            <button
              key={f}
              onClick={() => onFilter(f)}
              className={`px-3 py-1.5 capitalize border-r last:border-r-0 border-gray-200 transition-colors ${
                filter === f
                  ? 'bg-brand-primary text-white font-medium'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f === 'all' ? 'All' : f === 'active' ? 'Active (Prod)' : 'Unbooked'}
              {stats && f === 'active' && <span className="ml-1 opacity-70">({stats.active})</span>}
              {stats && f === 'unbooked' && <span className="ml-1 opacity-70">({stats.unbooked})</span>}
            </button>
          ))}
        </div>

        {/* Sync button + status */}
        <div className="flex items-center gap-2 ml-auto">
          {syncMsg && (
            <span className="text-xs text-green-700 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {syncMsg}
            </span>
          )}
          {ts && !syncMsg && (
            <span className="text-xs text-gray-400" title={`ดึงข้อมูลล่าสุด: ${syncLabel}`}>
              อัปเดต {syncLabel}
              {syncAgo !== null && syncAgo > 0 && (
                <span className="ml-1 opacity-60">({syncAgo}m ago)</span>
              )}
            </span>
          )}
          <button
            onClick={onSync}
            disabled={syncing}
            className="ops-btn-secondary ops-btn-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync Booking List'}
          </button>
        </div>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="px-4 py-2 border-b border-gray-50 flex gap-4 text-xs text-gray-500">
          <span><strong className="text-gray-800">{stats.total}</strong> projects in Sheet</span>
          <span><strong className="text-gray-800">{stats.bookable}</strong> bookable</span>
          <span><strong className="text-amber-600">{stats.active}</strong> in Production</span>
          <span><strong className="text-gray-600">{stats.unbooked}</strong> unbooked</span>
          <span className="ml-auto text-gray-400">{filtered.length} shown</span>
        </div>
      )}

      {/* Legend */}
      <div className="px-4 py-1.5 border-b border-gray-50 flex gap-3 text-[11px] text-gray-400">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-300 inline-block" />Pre-prod</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />Production</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />Post-prod</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400 inline-block" />Published</span>
      </div>

      {/* Content */}
      {error ? (
        <div className="px-4 py-6 text-center text-sm text-red-600 flex items-center justify-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      ) : loading ? (
        <div className="ops-empty text-gray-400">Loading Sheet data…</div>
      ) : !projects ? (
        <div className="ops-empty text-gray-400">
          <button onClick={onSync} className="text-brand-primary hover:underline">Load Sheet data →</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="ops-empty">No projects match.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="ops-table min-w-[700px]">
            <thead>
              <tr>
                <th>Project ID</th>
                <th>Name / Client</th>
                <th>Producer</th>
                <th>Episodes</th>
                <th className="text-right">Bookings</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const isInProd = p.epCounts.production > 0
                return (
                  <tr key={p.projectId} className={`hover:bg-gray-50 ${isInProd ? 'bg-amber-50/40' : ''}`}>
                    <td>
                      <span className="episode-badge font-mono">{p.projectId}</span>
                      {p.videoType && <div className="text-[10px] text-gray-400 mt-0.5">{p.videoType}</div>}
                    </td>
                    <td>
                      <div className="text-gray-800 font-medium">{p.projectName || '—'}</div>
                      {p.client && <div className="text-xs text-gray-400">{p.client}</div>}
                    </td>
                    <td className="text-gray-700 text-xs">
                      {p.producer || '—'}
                      {p.director && p.director !== p.producer && (
                        <div className="text-gray-400">Dir: {p.director}</div>
                      )}
                    </td>
                    <td>
                      <EpStatusBar counts={p.epCounts} total={p.totalEps} />
                    </td>
                    <td className="text-right">
                      {p.bookingCount > 0 ? (
                        <Link
                          href={`/dashboard?projectId=${encodeURIComponent(p.projectId)}`}
                          className="text-xs font-medium text-brand-primary hover:underline tabular-nums"
                        >
                          {p.bookingCount}
                        </Link>
                      ) : (
                        <span className="text-xs text-gray-300 tabular-nums">—</span>
                      )}
                    </td>
                    <td>
                      {!p.isBookable ? (
                        <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Finished</span>
                      ) : isInProd ? (
                        <span className="text-[11px] text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full font-medium">Active</span>
                      ) : p.totalEps === 0 ? (
                        <span className="text-[11px] text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">No EPs</span>
                      ) : (
                        <span className="text-[11px] text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Bookable</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function EpStatusBar({ counts, total }: { counts: ProjectMonitorRow['epCounts']; total: number }) {
  if (total === 0) {
    return <span className="text-xs text-gray-300">No episodes</span>
  }
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {counts.pending > 0 && (
        <span className="text-[11px] bg-rose-50 text-rose-400 px-1.5 py-0.5 rounded tabular-nums">
          {counts.pending} pending
        </span>
      )}
      {counts.preProduction > 0 && (
        <span className="text-[11px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded tabular-nums">
          {counts.preProduction} pre
        </span>
      )}
      {counts.production > 0 && (
        <span className="text-[11px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium tabular-nums">
          {counts.production} prod
        </span>
      )}
      {counts.postProduction > 0 && (
        <span className="text-[11px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded tabular-nums">
          {counts.postProduction} post
        </span>
      )}
      {counts.published > 0 && (
        <span className="text-[11px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded tabular-nums">
          {counts.published} pub
        </span>
      )}
      {counts.other > 0 && (
        <span className="text-[11px] bg-gray-50 text-gray-400 px-1.5 py-0.5 rounded tabular-nums">
          {counts.other} other
        </span>
      )}
    </div>
  )
}

function SectionLabel({ index, title, hint }: { index: number; title: string; hint: React.ReactNode }) {
  return (
    <div className="pt-4 pb-1 px-1">
      <div className="flex items-baseline gap-2">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-200 text-[10px] font-mono font-medium text-gray-600 tabular-nums">{index}</span>
        <h2 className="ops-section-title">{title}</h2>
      </div>
      <p className="text-xs text-gray-400 mt-1 ml-7 leading-snug">{hint}</p>
    </div>
  )
}
