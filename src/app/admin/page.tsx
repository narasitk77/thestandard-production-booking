'use client'

import { bookingDisplayName } from '@/lib/display'
import CrewLine from '@/app/_components/CrewLine'
import FootageBadge from '@/app/_components/FootageBadge'
import CardFootageActions from '@/app/_components/CardFootageActions'
import MiniMonthCalendar from '@/app/_components/MiniMonthCalendar'
import { CameraMicTag } from './_components/CameraMicTag'
import { useEffect, useState, useCallback, useRef, Fragment } from 'react'
import { resolveTier, tierAllows, type Tier } from '@/lib/tiers'
import Link from 'next/link'
import { ExternalLink, RefreshCw, AlertTriangle, Loader2 } from 'lucide-react'
import { formatDisplayDate, statusLabel } from '@/lib/utils'

interface Episode { episodeId: string; title: string; program?: { code?: string; name: string } | null }
interface Booking {
  id: string; shootDate: string; callTime: string; status: string
  producer: string; producerNick?: string; assignedEmails: string[]
  assignedCrew?: { email: string; name: string; isLead?: boolean }[]
  footageFiles?: number | null
  footageSent?: boolean
  cancelRequestedAt?: string | null; cancelReason?: string | null; cancelRequestedBy?: string | null
  cameraCount?: number | null; micCount?: number | null; isBlockShot?: boolean
  projectName?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  createdAt: string
  isRoutine?: boolean
  // Populated by /api/bookings (Prisma's default scalar select). Used by the
  // card to show a direct Google Calendar link when an event has been
  // created, or a warning + Re-sync button when CONFIRMED status drifted.
  calendarEventId?: string | null
  // v1.32.2 — async calendar sync visibility. PENDING right after
  // approve, OK once background create finishes, FAILED on Google API
  // error (with calendarSyncError + lastSyncedAt for the UI tooltip).
  calendarSyncStatus?: 'PENDING' | 'OK' | 'FAILED' | null
  calendarSyncError?: string | null
  calendarLastSyncedAt?: string | null
}

const STATUS_BADGE: Record<string, string> = {
  REQUESTED: 'bg-red-100 text-red-700 border border-red-200',
  ASSIGNED:  'bg-yellow-100 text-yellow-700 border border-yellow-200',
  CONFIRMED: 'bg-green-100 text-green-700 border border-green-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border border-gray-200',
  COMPLETED: 'bg-blue-100 text-blue-700 border border-blue-200',
}

const STATUS_ORDER = ['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED']

export default function AdminPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('REQUESTED')
  // v1.111 — โหมดดู: ทั้งหมด / วันนี้ / สัปดาห์นี้ (กรองตามวันถ่าย)
  const [range, setRange] = useState<'all' | 'day' | 'week'>('all')
  // v1.35.2 — only show the "Upload" shortcut on cards to crew that can use it.
  const [canUpload, setCanUpload] = useState(false)
  // v1.51 — soft delete (hide test queues) is an ADMIN power; the Deleted tab
  // and the trash buttons only render for ADMIN.
  const [isAdmin, setIsAdmin] = useState(false)
  // v1.91 — sound-mgmt tier (Senior Sound Engineer) sees the queue filtered to
  // jobs that need sound/mics; everyone else can toggle it.
  const [tier, setTier] = useState<Tier>('crew')
  const [soundOnly, setSoundOnly] = useState(false)
  // v1.107 — CONFIRMED tab: spot jobs whose crew isn't fully assigned yet.
  const [crewGaps, setCrewGaps] = useState<Record<string, { missing: string[]; missingTh: string[] }>>({})
  const [crewIncompleteOnly, setCrewIncompleteOnly] = useState(false)
  // v1.105.3 — filter the queue by shoot month + sort by date (default earliest→latest).
  const [monthFilter, setMonthFilter] = useState('all') // 'all' | 'YYYY-MM'
  const [sortAsc, setSortAsc] = useState(true)
  // v1.119 — sort field: by shoot date, or by REQUEST ORDER (createdAt = who
  // booked first). Ops need "ใครจองมาก่อน" for fair first-come crew/gear calls.
  const [sortBy, setSortBy] = useState<'shoot' | 'request'>('shoot')
  // v1.120 — pick a single day off a mini calendar to filter the queue to that
  // day (much faster than the วันนี้/สัปดาห์นี้ chips for browsing any date).
  const [selectedDate, setSelectedDate] = useState<string | null>(null) // 'yyyy-MM-dd'
  const [showCal, setShowCal] = useState(false)
  // v1.109 — unified ID search (Episode ID / Production ID / internal id).
  // `search` is the input box; `searchApplied` is what the query actually uses
  // (set on Enter / button) so we don't refetch on every keystroke.
  const [search, setSearch] = useState('')
  const [searchApplied, setSearchApplied] = useState('')
  useEffect(() => {
    fetch('/api/me').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.user?.canUpload) setCanUpload(true)
      if (d?.user?.role === 'ADMIN') setIsAdmin(true)
      const t = resolveTier(d?.user?.role, d?.user?.position)
      setTier(t)
      if (t === 'sound-mgmt') setSoundOnly(true) // auto-on + locked below
    }).catch(() => {})
  }, [])

  // v1.124 — filters live in the URL so they survive opening a booking and
  // coming Back (and a filtered view can be shared as a link). Read once on
  // mount; write via history.replaceState (no navigation, no router churn).
  // Params that equal their default are omitted so a plain /admin stays clean.
  const [urlHydrated, setUrlHydrated] = useState(false)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const st = p.get('st'); if (st) setFilter(st)
    const rg = p.get('rg'); if (rg === 'day' || rg === 'week') setRange(rg)
    const m = p.get('m'); if (m) setMonthFilter(m)
    const d = p.get('d'); if (d) { setSelectedDate(d); setShowCal(true) }
    const sb = p.get('sb'); if (sb === 'request') setSortBy('request')
    if (p.get('sa') === '0') setSortAsc(false)
    if (p.get('snd') === '1') setSoundOnly(true)
    if (p.get('gap') === '1') setCrewIncompleteOnly(true)
    const q = p.get('q'); if (q) { setSearch(q); setSearchApplied(q) }
    setUrlHydrated(true)
  }, [])
  useEffect(() => {
    if (!urlHydrated) return
    const p = new URLSearchParams()
    if (filter !== 'REQUESTED') p.set('st', filter)
    if (range !== 'all') p.set('rg', range)
    if (monthFilter !== 'all') p.set('m', monthFilter)
    if (selectedDate) p.set('d', selectedDate)
    if (sortBy !== 'shoot') p.set('sb', sortBy)
    if (!sortAsc) p.set('sa', '0')
    if (soundOnly) p.set('snd', '1')
    if (crewIncompleteOnly) p.set('gap', '1')
    if (searchApplied) p.set('q', searchApplied)
    const qs = p.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [urlHydrated, filter, range, monthFilter, selectedDate, sortBy, sortAsc, soundOnly, crewIncompleteOnly, searchApplied])

  // Months present in the current tab's bookings (ascending, e.g. Jul→Dec).
  const months = Array.from(new Set(bookings.map(b => (b.shootDate || '').slice(0, 7)).filter(Boolean))).sort()
  // v1.120 — days (yyyy-MM-dd) that have a booking in this tab → dotted on the picker.
  const markedDates = new Set(bookings.map(b => (b.shootDate || '').slice(0, 10)).filter(Boolean))
  const monthLabel = (ym: string) => {
    const d = new Date(ym + '-01')
    return isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }
  // A job "needs sound" when it requests mics. sound-mgmt is locked to this view.
  // Then filter by selected month and sort by shoot date (default earliest first).
  const visibleBookings = (() => {
    let list = soundOnly ? bookings.filter(b => (b.micCount ?? 0) > 0) : bookings
    if (crewIncompleteOnly) list = list.filter(b => crewGaps[b.id])
    // v1.120 — a picked calendar day wins over the month/range filters.
    if (selectedDate) {
      list = list.filter(b => (b.shootDate || '').slice(0, 10) === selectedDate)
      return [...list].sort((a, b) => {
        const cmp = (a.callTime || '').localeCompare(b.callTime || '')
        return cmp
      })
    }
    if (monthFilter !== 'all') list = list.filter(b => (b.shootDate || '').slice(0, 7) === monthFilter)
    // v1.111 — daily/weekly view: วันนี้ = today's calendar day; สัปดาห์นี้ = the
    // CURRENT week Mon–Sun including past days (so the Completed tab filters too).
    if (range !== 'all') {
      const t0 = new Date(); t0.setHours(0, 0, 0, 0)
      let start = new Date(t0), end = new Date(t0)
      if (range === 'day') { end.setDate(end.getDate() + 1) }
      else { const dow = (start.getDay() + 6) % 7; start.setDate(start.getDate() - dow); end = new Date(start); end.setDate(end.getDate() + 7) }
      list = list.filter(b => { const d = new Date(b.shootDate); return !isNaN(d.getTime()) && d >= start && d < end })
    }
    return [...list].sort((a, b) => {
      const cmp = sortBy === 'request'
        ? (a.createdAt || '').localeCompare(b.createdAt || '')   // request order (createdAt ISO sorts lexically)
        : (a.shootDate || '').localeCompare(b.shootDate || '')
      return sortAsc ? cmp : -cmp
    })
  })()

  const showingDeleted = filter === 'DELETED'
  const showingRoutine = filter === 'ROUTINE'

  // v1.54.1 — limit raised 50→200 (parity with the other list surfaces; at 50
  // the desc sort silently dropped the most imminent rows), the fetch is
  // race-guarded so a slow earlier tab can't overwrite a faster later one,
  // and loading always clears even when the request fails.
  const fetchSeq = useRef(0)
  const fetch_ = useCallback(async () => {
    const seq = ++fetchSeq.current
    setLoading(true)
    try {
      // v1.56 — Routine tab shows only routine bookings (any status); the
      // status/All tabs exclude routine so the normal queue stays focused on
      // one-off jobs. Deleted tab unchanged.
      // v1.109 — a non-empty search overrides the tab: find a booking by its
      // Production/Episode ID (or internal id) across EVERY status, so you never
      // have to guess which tab it's on.
      const params = searchApplied
        ? new URLSearchParams({ limit: '200', search: searchApplied })
        : filter === 'DELETED'
        ? new URLSearchParams({ limit: '200', deleted: '1' })
        : filter === 'ROUTINE'
          ? new URLSearchParams({ limit: '200', routine: 'only' })
          : filter === 'CANCEL_REQ'
            ? new URLSearchParams({ limit: '200', cancelRequested: '1' })
            : new URLSearchParams({ limit: '200', routine: 'exclude', ...(filter && { status: filter }) })
      params.set('withCrew', '1')
      const res = await fetch(`/api/bookings?${params}`)
      const data = await res.json()
      if (seq !== fetchSeq.current) return // stale response — a newer tab fetch won
      setBookings(data.bookings || [])
      setTotal(data.total || 0)
    } catch {
      if (seq === fetchSeq.current) setBookings([])
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [filter, searchApplied])

  useEffect(() => { fetch_() }, [fetch_])
  // Switching status tab → reset the month filter (months differ per tab) and
  // clear any active ID search so the clicked tab actually takes over (v1.109).
  useEffect(() => { setMonthFilter('all'); setSearch(''); setSearchApplied('') }, [filter])
  // v1.107 — load crew-gap map only on the CONFIRMED tab (where assignment matters);
  // reset the "incomplete only" filter when leaving the tab.
  useEffect(() => {
    if (filter !== 'CONFIRMED') { setCrewGaps({}); setCrewIncompleteOnly(false); return }
    let cancelled = false
    fetch('/api/bookings/crew-gaps')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setCrewGaps(d.gaps || {}) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [filter, bookings])

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8">

      {/* Header */}
      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">คิวงาน</h1>
          {/* v1.73 — queue-only tools. Back-office + system (Reminders/Team/
              Health/Permissions) moved to the Admin hub (/admin/production-space). */}
          {/* v1.91 — hide console-tool links for sound-mgmt (they're blocked by middleware too) */}
          <div className="flex gap-2">
            {tierAllows(tier, '/admin/workspace') && (
              <Link href="/admin/workspace" className="px-3 py-1.5 text-xs sm:text-sm border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors">
                รายงาน
              </Link>
            )}
            {tierAllows(tier, '/admin/routine') && (
              <Link href="/admin/routine" className="px-3 py-1.5 text-xs sm:text-sm border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors">
                Routine
              </Link>
            )}
            {isAdmin && (
              <Link href="/admin/week-plan" className="px-3 py-1.5 text-xs sm:text-sm border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors">
                📅 Week Plan
              </Link>
            )}
            {tierAllows(tier, '/new') && <Link href="/new" className="gf-submit text-xs sm:text-sm">+ New</Link>}
          </div>
        </div>
        <p className="text-xs sm:text-sm text-gray-500 mt-1">
          Review, assign crew, and approve bookings → Google Calendar
        </p>
        {/* v1.64.0 — back-office modules moved to ADMIN-only /admin/production-space */}
      </div>

      {/* v1.109 — unified ID search: matches Episode ID / Production ID / internal
          booking id across EVERY status (overrides the tab while active). */}
      <form
        onSubmit={(e) => { e.preventDefault(); setSearchApplied(search.trim()) }}
        className="mb-3 flex items-center gap-2"
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 ค้นหาทุกอย่าง — ID / ชื่อรายการ / ชื่อตอน / โปรดิวเซอร์ / สถานที่ / ทีม…"
          className="flex-1 max-w-md px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-[#673ab7]/40"
        />
        <button type="submit" className="px-3 py-2 text-sm border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors">ค้นหา</button>
        {searchApplied && (
          <button type="button" onClick={() => { setSearch(''); setSearchApplied('') }} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-800">ล้าง</button>
        )}
      </form>
      {searchApplied && (
        <div className="mb-3 text-xs text-gray-500">ผลการค้นหา “{searchApplied}” (ทุกสถานะ) · {total} รายการ</div>
      )}

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
        <button
          onClick={() => setFilter('ROUTINE')}
          title="งาน Routine รายสัปดาห์ (เช่น THE STANDARD NOW) — สร้างที่หน้า Routine Planner"
          className={`px-4 py-2 text-sm border-b-2 transition-colors -mb-px ${
            showingRoutine
              ? 'border-[#673ab7] text-[#673ab7] font-medium'
              : 'border-transparent text-gray-400 hover:text-gray-600'
          }`}
        >
          🔁 Routine
        </button>
        <button
          onClick={() => setFilter('CANCEL_REQ')}
          title="งานที่มีคนขอยกเลิก — รอ admin ตัดสินใจยกเลิกจริงหรือไม่"
          className={`px-4 py-2 text-sm border-b-2 transition-colors -mb-px ${
            filter === 'CANCEL_REQ'
              ? 'border-red-500 text-red-600 font-medium'
              : 'border-transparent text-gray-400 hover:text-gray-600'
          }`}
        >
          🚫 ขอยกเลิก
        </button>
        {isAdmin && (
          <button
            onClick={() => setFilter('DELETED')}
            title="คิวที่ถูกลบ (ซ่อนจากเว็บ แต่ยังอยู่ในฐานข้อมูล) — กู้คืนหรือลบถาวรได้จากที่นี่"
            className={`px-4 py-2 text-sm border-b-2 transition-colors -mb-px ml-auto ${
              showingDeleted
                ? 'border-gray-700 text-gray-800 font-medium'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            🗑 Deleted
          </button>
        )}
      </div>

      {/* v1.91 — sound/mic filter. Locked on for sound-mgmt (ทีมเสียง); a toggle for the rest. */}
      <label className="flex items-center gap-2 mb-4 text-sm text-gray-600 w-fit cursor-pointer">
        <input type="checkbox" checked={soundOnly} disabled={tier === 'sound-mgmt'}
          onChange={e => setSoundOnly(e.target.checked)} className="accent-[#673ab7]" />
        🎙️ เฉพาะงานที่ต้องการเสียง/ไมค์
        {tier === 'sound-mgmt' && <span className="text-[10px] text-amber-700">(ล็อกสำหรับทีมเสียง)</span>}
      </label>

      {/* v1.107 — CONFIRMED tab only: filter to jobs whose crew isn't fully assigned */}
      {filter === 'CONFIRMED' && (
        <label className="flex items-center gap-2 mb-4 -mt-2 text-sm text-gray-600 w-fit cursor-pointer">
          <input type="checkbox" checked={crewIncompleteOnly} onChange={e => setCrewIncompleteOnly(e.target.checked)} className="accent-orange-500" />
          🚨 เฉพาะงานที่ทีมงานยังไม่ครบ
          <span className="text-[10px] text-orange-700">({Object.keys(crewGaps).length} งาน)</span>
        </label>
      )}

      {/* v1.120 — pick a day off a calendar to filter the queue (or a chip for the
          common today/this-week views). */}
      {!showingDeleted && (
        <div className="mb-3">
          <button onClick={() => setShowCal(s => !s)}
            className={`px-2.5 py-1 text-xs rounded-full border inline-flex items-center gap-1 ${selectedDate ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'border-gray-300 text-gray-600 hover:border-[#673ab7]'}`}>
            📅 {selectedDate
              ? new Date(selectedDate).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })
              : 'เลือกวันจากปฏิทิน'}
            {selectedDate && <span onClick={e => { e.stopPropagation(); setSelectedDate(null) }} className="ml-1 hover:text-gray-200">✕</span>}
          </button>
          {showCal && (
            <div className="mt-2">
              <MiniMonthCalendar
                markedDates={markedDates}
                selected={selectedDate}
                onSelect={d => { setSelectedDate(d); if (d) { setRange('all'); setMonthFilter('all') } }}
              />
            </div>
          )}
        </div>
      )}

      {/* v1.105.3 — month filter tabs (ascending) + sort toggle */}
      {!showingDeleted && months.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="flex gap-1 flex-wrap">
            {([['all', 'ทั้งหมด'], ['day', 'วันนี้'], ['week', 'สัปดาห์นี้']] as const).map(([k, label]) => (
              <button key={k} onClick={() => { setRange(k); setSelectedDate(null) }}
                className={`px-2.5 py-1 text-xs rounded-full border ${!selectedDate && range === k ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-600 hover:border-gray-900'}`}>
                {label}
              </button>
            ))}
            <span className="w-px bg-gray-200 mx-1" />
            <button onClick={() => setMonthFilter('all')}
              className={`px-2.5 py-1 text-xs rounded-full border ${monthFilter === 'all' ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'border-gray-300 text-gray-600 hover:border-[#673ab7]'}`}>
              ทุกเดือน
            </button>
            {months.map(m => (
              <button key={m} onClick={() => setMonthFilter(m)}
                className={`px-2.5 py-1 text-xs rounded-full border ${monthFilter === m ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'border-gray-300 text-gray-600 hover:border-[#673ab7]'}`}>
                {monthLabel(m)}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {/* v1.119 — sort field: วันถ่าย ↔ ลำดับที่จอง (createdAt) */}
            <button onClick={() => setSortBy(s => s === 'shoot' ? 'request' : 'shoot')}
              title="สลับ: เรียงตามวันถ่าย / เรียงตามลำดับที่จอง"
              className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1">
              {sortBy === 'shoot' ? '📅 วันถ่าย' : '🕐 ลำดับที่จอง'}
            </button>
            <button onClick={() => setSortAsc(s => !s)}
              title="สลับทิศทางการเรียง"
              className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1">
              {sortBy === 'request'
                ? (sortAsc ? '↑ จองก่อน→หลัง' : '↓ จองหลัง→ก่อน')
                : (sortAsc ? '↑ วันน้อย→มาก' : '↓ วันมาก→น้อย')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
      ) : visibleBookings.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">
          {crewIncompleteOnly ? '🎉 งาน CONFIRMED ทุกงานทีมครบแล้ว' : soundOnly ? 'ไม่มีงานที่ต้องการเสียง/ไมค์ในแท็บนี้' : `No ${filter || ''} bookings.`}
        </div>
      ) : (
        <>
        {soundOnly ? (
          <p className="text-xs text-gray-400 mb-2">🎙️ เฉพาะงานที่ต้องการเสียง/ไมค์ — {visibleBookings.length} จาก {bookings.length} ในแท็บนี้</p>
        ) : total > bookings.length ? (
          <p className="text-xs text-gray-400 mb-2">
            แสดง {bookings.length} จาก {total} รายการ (เรียงตาม{sortBy === 'request' ? 'ลำดับที่จอง' : 'วันถ่าย'})
          </p>
        ) : null}
        <div className="space-y-3">
          {(() => { let lastMonth = ''; return visibleBookings.map(b => {
            // Group cards by shoot month (en-US = Gregorian, so "July 2026" not 2569).
            const md = new Date(b.shootDate)
            const m = isNaN(md.getTime()) ? '—' : md.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
            const showHeader = m !== lastMonth
            lastMonth = m
            return (
            <Fragment key={b.id}>
            {!selectedDate && sortBy === 'shoot' && monthFilter === 'all' && showHeader && <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2">{m}</div>}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3 flex-col sm:flex-row">
                <div className="flex-1 min-w-0 w-full">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {showingDeleted && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-800 text-white">
                        DELETED
                      </span>
                    )}
                    {b.isRoutine && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[#673ab7]/10 text-[#673ab7] border border-[#673ab7]/30">
                        🔁 Routine
                      </span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[b.status] || STATUS_BADGE.REQUESTED}`}>
                      {b.status === 'REQUESTED' ? '[REQUESTED]' : statusLabel(b.status)}
                    </span>
                    <span className="text-xs text-gray-400">
                      {formatDisplayDate(b.shootDate)} · {b.callTime}
                    </span>
                    {/* v1.119 — request time (date + HH:MM) so "ใครจองมาก่อน" is
                        visible at a glance; emphasised when sorting by request order. */}
                    {b.createdAt && (
                      <span className={`text-[11px] ${sortBy === 'request' ? 'text-[#673ab7] font-medium' : 'text-gray-400'}`}
                        title="เวลาที่จองเข้ามา (createdAt)">
                        · 📝 จอง {new Date(b.createdAt).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {crewGaps[b.id] && (
                      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200 font-medium">
                        ⚠️ ขาด: {crewGaps[b.id].missingTh.join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="font-medium text-gray-800 text-sm sm:text-base">
                    {b.isBlockShot ? '🧱 ' : ''}{b.outlet.name} · {bookingDisplayName(b)}
                  </div>
                  <div className="text-xs sm:text-sm text-gray-500 mt-0.5">
                    Producer: {b.producerNick || b.producer}
                    <CrewLine crew={b.assignedCrew} className="mt-0.5 text-[12px] text-blue-700" />
                    <div className="mt-1"><FootageBadge files={b.footageFiles} sent={b.footageSent} /></div>
                  </div>
                  {b.cancelRequestedAt && (
                    <div className="mt-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 flex items-center justify-between gap-2">
                      <span>🚫 ขอยกเลิก: {b.cancelReason || '—'}{b.cancelRequestedBy ? ` (${b.cancelRequestedBy})` : ''}</span>
                      <button
                        onClick={async () => {
                          if (!confirm('เก็บงานนี้ไว้ (ปฏิเสธคำขอยกเลิก)?')) return
                          await fetch(`/api/bookings/${b.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clearCancelRequest: true }) })
                          fetch_()
                        }}
                        title="เก็บงานไว้ — ลบคำขอยกเลิก"
                        className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-red-300 text-red-700 hover:bg-red-100">
                        เก็บงานไว้
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-1 mt-2">
                    {b.episodes.map(ep => (
                      <span key={ep.episodeId} className="episode-badge text-xs">{ep.episodeId}</span>
                    ))}
                    {!showingDeleted && (
                      <CameraMicTag cameraCount={b.cameraCount} micCount={b.micCount} isBlockShot={b.isBlockShot} />
                    )}
                  </div>
                  {/* Calendar status — only meaningful once approved.
                      v1.29.2 — surfaces the actual Google Calendar state so
                      "approved but no event" is visible at a glance instead
                      of being hidden behind a button click on /admin/[id]. */}
                  {!showingDeleted && (b.status === 'CONFIRMED' || b.status === 'COMPLETED') && (
                    <CalendarStatus
                      bookingId={b.id}
                      calendarEventId={b.calendarEventId}
                      syncStatus={b.calendarSyncStatus}
                      syncError={b.calendarSyncError}
                      lastSyncedAt={b.calendarLastSyncedAt}
                      onResynced={fetch_}
                    />
                  )}
                </div>

                <div className="flex gap-2 flex-shrink-0 w-full sm:w-auto justify-end flex-wrap">
                  {showingDeleted && (
                    <>
                      <UndeleteButton bookingId={b.id} onDone={fetch_} />
                      <HardDeleteButton bookingId={b.id} onDone={fetch_} />
                    </>
                  )}
                  {!showingDeleted && (b.status === 'REQUESTED' || b.status === 'ASSIGNED') && (
                    <>
                      <Link href={`/admin/${b.id}`}
                        className="px-3 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors">
                        EDIT
                      </Link>
                      <ApproveButton bookingId={b.id} onDone={fetch_} />
                      <CancelButton bookingId={b.id} onDone={fetch_} />
                    </>
                  )}
                  {!showingDeleted && b.status === 'CONFIRMED' && (
                    <>
                      {canUpload && (
                        <Link href={`/upload?bookingId=${b.id}`}
                          title="Upload footage — opens the dedicated upload page"
                          className="px-3 py-1.5 text-xs border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] inline-flex items-center gap-1">
                          📹 Upload
                        </Link>
                      )}
                      {/* v1.115 — CONFIRMED shoots that already have footage can be
                          consolidated + announced inline too (files often land before
                          the booking is flipped to COMPLETED). */}
                      <CardFootageActions bookingId={b.id} canMerge={canUpload} onChanged={fetch_} />
                      <Link href={`/admin/${b.id}`}
                        className="px-3 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] rounded hover:bg-[#673ab7] hover:text-white transition-colors">
                        EDIT
                      </Link>
                      <CancelButton bookingId={b.id} onDone={fetch_} />
                      <span className="px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded border border-green-200">
                        ✓ Approved
                      </span>
                    </>
                  )}
                  {!showingDeleted && b.status === 'COMPLETED' && (
                    <>
                      {/* v1.115 — consolidate + notify right here, no page hop. */}
                      <CardFootageActions bookingId={b.id} canMerge={canUpload} onChanged={fetch_} />
                      {canUpload && (
                        <Link href={`/upload?bookingId=${b.id}`}
                          title="Upload footage — opens the dedicated upload page"
                          className="px-3 py-1.5 text-xs border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] inline-flex items-center gap-1">
                          📹 Upload
                        </Link>
                      )}
                      <Link href={`/admin/${b.id}`}
                        className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
                        View
                      </Link>
                      <span className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded border border-blue-200">
                        ✓ Completed
                      </span>
                    </>
                  )}
                  {!showingDeleted && b.status === 'CANCELLED' && (
                    <RestoreButton bookingId={b.id} onDone={fetch_} />
                  )}
                  {!showingDeleted && isAdmin && (
                    <SoftDeleteButton bookingId={b.id} onDone={fetch_} />
                  )}
                </div>
              </div>
            </div>
            </Fragment>
            )})})()}
        </div>
        </>
      )}
    </div>
  )
}

/**
 * Calendar status chip + Re-sync button shown on CONFIRMED booking cards.
 *
 * Three visible states:
 *  - `calendarEventId` present  → "📅 Open in Google Calendar" link (the
 *    happy path; admin can click through to confirm guests).
 *  - `calendarEventId` null     → red warning chip "⚠ No calendar event"
 *    with a Re-sync button that triggers an immediate per-booking
 *    reconcile (creates the event, adds guests, persists the new id).
 *  - Re-sync in progress / done → inline result (created / patched / ok /
 *    failed) with the resolved htmlLink if applicable.
 *
 * The Re-sync button stays visible even when the event exists, so an admin
 * who notices "guests missing on the calendar" can force a patch without
 * waiting for the 10-minute worker tick.
 */
function CalendarStatus({
  bookingId,
  calendarEventId,
  syncStatus,
  syncError,
  lastSyncedAt,
  onResynced,
}: {
  bookingId: string
  calendarEventId?: string | null
  syncStatus?: 'PENDING' | 'OK' | 'FAILED' | null
  syncError?: string | null
  lastSyncedAt?: string | null
  onResynced: () => void
}) {
  type ResyncResult = {
    ok: boolean
    action?: 'ok' | 'patched' | 'created' | 'failed' | 'skipped'
    eventId?: string | null
    htmlLink?: string | null
    assignedEmails?: string[]
    calendarAttendees?: string[]
    error?: string
  }
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<ResyncResult | null>(null)
  // The resolved event id is whatever we know most recently — fresh from
  // a re-sync if available, else the value from the list fetch.
  const effectiveEventId = result?.eventId ?? calendarEventId ?? null

  const handleResync = async () => {
    setSyncing(true)
    setResult(null)
    try {
      const res = await fetch(`/api/admin/${bookingId}/calendar-resync`, { method: 'POST' })
      const data: ResyncResult = await res.json()
      setResult(data)
      // Refresh list when the event id changes so the link updates without
      // a manual reload. (Same trigger used by Approve/Cancel.)
      if (data.ok && data.eventId && data.eventId !== calendarEventId) onResynced()
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) })
    } finally {
      setSyncing(false)
    }
  }

  // Google Calendar event URLs follow the {/event?eid=<base64(eventId + ' ' +
  // calendarId)>} pattern, but the proper public link comes from
  // events.get(htmlLink). We persist the eventId in the DB but not the link,
  // so the link is only known after a fresh re-sync. Fallback: build the
  // base64 eid ourselves — it's just `${eventId} ${calendarId}` b64-encoded.
  // For safety in browsers we only build it when the calendar id is the
  // default one baked into the worker (we don't have access to runtime env).
  // Result: link is "Open" when we have htmlLink, otherwise we surface the
  // raw event id so the admin can paste-search in Calendar.
  const link = result?.htmlLink || null

  // v1.32.2 — primary status chip now comes from the DB-tracked
  // calendarSyncStatus field (PENDING / OK / FAILED) instead of just
  // inferring from calendarEventId. Approve writes PENDING; background
  // task / reconciler / assign write OK or FAILED. The chip shows the
  // sync state; the link chip (separate, below) shows the actual
  // Google Calendar event if there is one.
  const effectiveStatus = syncStatus ?? (effectiveEventId ? 'OK' : null)

  // v1.116 — the queue card only needs the AT-A-GLANCE calendar state: one chip
  // when it's fine, and the Re-sync affordance ONLY when it actually needs
  // attention (FAILED / no event). The 10-min reconciler auto-retries and the
  // detail page (BookingConfirmedCard) keeps the full timestamp/link/result UI.
  const needsAttention = effectiveStatus === 'FAILED' || effectiveStatus === null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {effectiveStatus === 'PENDING' && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
          <Loader2 className="w-3 h-3 animate-spin" /> ปฏิทิน: กำลังซิงค์…
        </span>
      )}
      {effectiveStatus === 'OK' && effectiveEventId && (
        link ? (
          <a href={link} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 hover:bg-green-100"
            title={`Calendar event: ${effectiveEventId}`}>
            📅 ปฏิทิน OK <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200"
            title={`Calendar event: ${effectiveEventId}`}>
            📅 ปฏิทิน OK
          </span>
        )
      )}
      {needsAttention && (
        <>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200"
            title={syncError || 'Calendar sync failed / no event — Re-sync to retry'}>
            <AlertTriangle className="w-3 h-3" /> {effectiveStatus === 'FAILED' ? 'ปฏิทินซิงค์ล้มเหลว' : 'ยังไม่มี event'}
          </span>
          <button onClick={handleResync} disabled={syncing}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="Force a calendar sync now">
            {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {syncing ? 'กำลังซิงค์…' : 'Re-sync'}
          </button>
          {result && !syncing && (
            <span className={`px-2 py-0.5 rounded-full ${result.ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`} title={result.error || ''}>
              {result.ok ? `✓ ${result.action}` : `⚠ ${result.error || 'sync failed'}`}
            </span>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Compact relative-time formatter used by the calendar sync chip.
 * Examples: "12s", "5m", "2h", "3d". Anything older falls back to a
 * short ISO date.
 */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

/**
 * v1.51 — soft delete (ADMIN only). Hides the booking from every web surface
 * but keeps the row in the DB; restorable from the Deleted tab. The matching
 * calendar event is removed server-side.
 */
function SoftDeleteButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const handle = async () => {
    if (!confirm('ลบ booking นี้ออกจากหน้าเว็บ?\n\nข้อมูลยังเก็บอยู่ในฐานข้อมูล — กู้คืนได้จากแท็บ 🗑 Deleted\n(event ใน Google Calendar จะถูกลบออก)')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/${bookingId}/soft-delete`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onDone()
    } catch (e: any) {
      alert('Delete failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button onClick={handle} disabled={loading} title="ลบออกจากเว็บ (เก็บข้อมูลไว้ กู้คืนได้)"
      className="px-3 py-1.5 text-xs border border-gray-300 text-gray-500 rounded hover:border-red-300 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50">
      {loading ? '…' : '🗑 DELETE'}
    </button>
  )
}

/** v1.51 — bring a soft-deleted booking back onto the web surfaces. */
function UndeleteButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const handle = async () => {
    if (!confirm('กู้คืน booking นี้กลับมาแสดงบนเว็บ?\n(ถ้าเป็นงาน CONFIRMED ให้กด Re-sync calendar อีกครั้งเพื่อสร้าง event ใหม่)')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/${bookingId}/undelete`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onDone()
    } catch (e: any) {
      alert('Restore failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button onClick={handle} disabled={loading}
      className="px-3 py-1.5 text-xs border border-yellow-400 text-yellow-700 bg-yellow-50 rounded hover:bg-yellow-500 hover:text-white transition-colors disabled:opacity-50">
      {loading ? '…' : '↺ RESTORE'}
    </button>
  )
}

/**
 * v1.51 — hard delete from the Deleted tab (existing v1.44 endpoint, first UI
 * surface for it). Permanent: cascades episodes/uploads and cleans audit/OT.
 */
function HardDeleteButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const handle = async () => {
    if (!confirm('⚠️ ลบถาวร?\n\nbooking, episodes, uploads และ audit log ของใบนี้จะหายทั้งหมด — กู้คืนไม่ได้')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/${bookingId}/delete`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onDone()
    } catch (e: any) {
      alert('Delete failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button onClick={handle} disabled={loading}
      className="px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors disabled:opacity-50">
      {loading ? '…' : 'ลบถาวร'}
    </button>
  )
}

function RestoreButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const handle = async () => {
    if (!confirm('Restore booking นี้กลับมาเป็น [REQUESTED]?')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/${bookingId}/restore`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onDone()
    } catch (e: any) {
      alert('Restore failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button onClick={handle} disabled={loading}
      className="px-3 py-1.5 text-xs border border-yellow-400 text-yellow-700 bg-yellow-50 rounded hover:bg-yellow-500 hover:text-white transition-colors disabled:opacity-50">
      {loading ? '…' : '↺ RESTORE'}
    </button>
  )
}

function CancelButton({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false)
  const handle = async () => {
    if (!confirm('Cancel this booking? It will be moved to Cancelled and removed from the calendar.')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'CANCELLED' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onDone()
    } catch (e: any) {
      alert('Cancel failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <button onClick={handle} disabled={loading}
      className="px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 transition-colors disabled:opacity-50">
      {loading ? '…' : 'CANCEL'}
    </button>
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
