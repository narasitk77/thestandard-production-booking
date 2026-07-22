'use client'

import { bookingDisplayName } from '@/lib/display'
import { useEffect, useMemo, useState } from 'react'
import MiniMonthCalendar from '@/app/_components/MiniMonthCalendar'
import Link from 'next/link'
import { Loader2, Plus, Search, Inbox } from 'lucide-react'
import { parseISO, startOfToday, isAfter, isToday } from 'date-fns'
import { formatDisplayDate } from '@/lib/utils'
import StatusPill, { categoryCardClass, AdBadge } from '@/app/_components/StatusPill'
import CrewLine from '@/app/_components/CrewLine'
import FootageBadge from '@/app/_components/FootageBadge'

interface Episode { episodeId: string; title: string; program?: { code?: string; name: string } | null }
interface Booking {
  isBlockShot?: boolean
  id: string
  shootDate: string
  shootEndDate?: string | null
  callTime: string
  estimatedWrap?: string
  status: string
  shootType: string
  locationName?: string
  producer: string
  createdByEmail?: string | null
  producerEmail?: string | null
  projectName?: string | null
  category?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
  // v1.111 — resolved crew (from ?withCrew=1): who's on the shoot with you.
  assignedCrew?: { email: string; name: string; isLead?: boolean }[]
  footageFiles?: number | null
  footageSent?: boolean
}

type TabKey = 'upcoming' | 'REQUESTED' | 'ASSIGNED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED'

const TABS: { key: TabKey; label: string; short: string }[] = [
  { key: 'upcoming',  label: 'Upcoming',  short: 'Upcoming' },
  { key: 'REQUESTED', label: 'Requested', short: 'Requested' },
  { key: 'ASSIGNED',  label: 'Assigned',  short: 'Assigned' },
  { key: 'CONFIRMED', label: 'Confirmed', short: 'Confirmed' },
  { key: 'COMPLETED', label: 'Completed', short: 'Done' },
  { key: 'CANCELLED', label: 'Cancelled', short: 'X' },
]

export default function MyBookingsPage() {
  const [bookings, setBookings] = useState<Booking[] | null>(null)
  const [tab, setTab] = useState<TabKey>('upcoming')
  const [search, setSearch] = useState('')
  // v1.111 — โหมดดู: ทั้งหมด / วันนี้ / สัปดาห์นี้
  const [range, setRange] = useState<'all' | 'day' | 'week'>('all')
  // v1.120 — pick a day off a mini calendar to filter to that date.
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [showCal, setShowCal] = useState(false)
  // v1.35.3 — whether to render Upload buttons next to CONFIRMED/COMPLETED rows
  const [canUpload, setCanUpload] = useState(false)
  // v1.63 — current user email, used to show the Edit button only to the owner
  const [meEmail, setMeEmail] = useState('')
  useEffect(() => {
    fetch('/api/me').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.user?.canUpload) setCanUpload(true)
      if (d?.user?.email) setMeEmail(String(d.user.email).toLowerCase())
    }).catch(() => {})
  }, [])

  // Fetch once with scope=mine, then filter client-side per tab. The API
  // already handles "mine" vs "all confirmed" — for an inbox we want the
  // user-owned/assigned set across all statuses.
  useEffect(() => {
    setBookings(null)
    fetch('/api/bookings?scope=mine&limit=200&withCrew=1')
      .then(r => r.json())
      .then(d => setBookings(d.bookings || []))
      .catch(() => setBookings([]))
  }, [])

  const loading = bookings === null

  // Per-tab counts shown on tab pills.
  const counts = useMemo(() => {
    const b = bookings || []
    const today0 = startOfToday()
    return {
      upcoming: b.filter(x => {
        const d = parseISO(x.shootDate)
        if (isNaN(d.getTime())) return false
        if (x.status === 'CANCELLED') return false
        return isToday(d) || isAfter(d, today0)
      }).length,
      REQUESTED: b.filter(x => x.status === 'REQUESTED').length,
      ASSIGNED: b.filter(x => x.status === 'ASSIGNED').length,
      CONFIRMED: b.filter(x => x.status === 'CONFIRMED').length,
      COMPLETED: b.filter(x => x.status === 'COMPLETED').length,
      CANCELLED: b.filter(x => x.status === 'CANCELLED').length,
    } as Record<TabKey, number>
  }, [bookings])

  // v1.120 — days with a booking → dot on the picker.
  const markedDates = useMemo(() => new Set((bookings||[]).map(b => (b.shootDate||'').slice(0,10)).filter(Boolean)), [bookings])

  const filtered = useMemo(() => {
    const b = bookings || []
    const today0 = startOfToday()
    let list = b
    // v1.120 — a picked calendar day wins over range + tab-status filtering, but
    // still respects the current tab's status so "my Completed on 5 Jul" works.
    if (selectedDate) {
      list = list.filter(x => (x.shootDate || '').slice(0, 10) === selectedDate)
      if (tab === 'upcoming') list = list.filter(x => x.status !== 'CANCELLED')
      else list = list.filter(x => x.status === tab)
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        list = list.filter(x => [x.outlet.name, x.outlet.code, x.program.name, x.projectName || '', x.producer, x.locationName || '', ...x.episodes.map(e => `${e.episodeId} ${e.title}`)].join(' ').toLowerCase().includes(q))
      }
      return [...list].sort((a, b) => (a.callTime || '').localeCompare(b.callTime || ''))
    }
    // v1.111 — daily/weekly view: วันนี้ = today's calendar day; สัปดาห์นี้ = the
    // CURRENT week Mon–Sun INCLUDING past days (a Completed job shot on Tuesday
    // must show under สัปดาห์นี้ — the first cut only looked forward, so the
    // Completed tab appeared unfiltered/empty).
    if (range !== 'all') {
      let start = new Date(today0), end = new Date(today0)
      if (range === 'day') { end.setDate(end.getDate() + 1) }
      else { const dow = (start.getDay() + 6) % 7; start.setDate(start.getDate() - dow); end = new Date(start); end.setDate(end.getDate() + 7) }
      list = list.filter(x => {
        const d = parseISO(x.shootDate)
        return !isNaN(d.getTime()) && d >= start && d < end
      })
    }
    if (tab === 'upcoming') {
      list = list.filter(x => {
        const d = parseISO(x.shootDate)
        if (isNaN(d.getTime())) return false
        if (x.status === 'CANCELLED') return false
        return isToday(d) || isAfter(d, today0)
      })
      // Upcoming sorts ascending — soonest first — opposite the API default.
      list = [...list].sort((a, b) => a.shootDate.localeCompare(b.shootDate))
    } else {
      list = list.filter(x => x.status === tab)
      // Sort by shoot date: forward-looking tabs ascending (soonest first),
      // historical tabs (done/cancelled) descending (most recent first).
      const desc = tab === 'COMPLETED' || tab === 'CANCELLED'
      list = [...list].sort((a, b) =>
        desc ? b.shootDate.localeCompare(a.shootDate) : a.shootDate.localeCompare(b.shootDate))
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(x => {
        const hay = [
          x.outlet.name, x.outlet.code, x.program.name, x.projectName || '',
          x.producer, x.locationName || '',
          ...x.episodes.map(e => `${e.episodeId} ${e.title}`),
        ].join(' ').toLowerCase()
        return hay.includes(q)
      })
    }
    return list
  }, [bookings, tab, search, range, selectedDate])

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="flex items-start justify-between gap-2 mb-4 flex-wrap">
        <div>
          <h1>My Bookings</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Bookings you created or were assigned to.
          </p>
        </div>
        <Link href="/new" className="ops-btn-primary"><Plus className="w-4 h-4" /> New Booking</Link>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none -mx-3 px-3 sm:mx-0 sm:px-0 mb-3 border-b border-gray-200">
        {TABS.map(t => {
          const active = tab === t.key
          const count = counts[t.key]
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                active
                  ? 'border-gray-900 text-gray-900 font-medium'
                  : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              <span className="sm:hidden">{t.short}</span>
              <span className="hidden sm:inline">{t.label}</span>
              {count > 0 && (
                <span className={`ml-1.5 text-[10px] tabular-nums px-1.5 py-0.5 rounded-full ${active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* v1.120 — pick a day off a calendar */}
      <div className="mb-2">
        <button onClick={() => setShowCal(s => !s)}
          className={`text-xs px-3 py-1 rounded-full border inline-flex items-center gap-1 ${selectedDate ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'bg-white text-gray-600 border-gray-300 hover:border-[#673ab7]'}`}>
          📅 {selectedDate ? new Date(selectedDate).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' }) : 'เลือกวันจากปฏิทิน'}
          {selectedDate && <span onClick={e => { e.stopPropagation(); setSelectedDate(null) }} className="ml-1 hover:text-gray-200">✕</span>}
        </button>
        {showCal && (
          <div className="mt-2">
            <MiniMonthCalendar markedDates={markedDates} selected={selectedDate} onSelect={d => { setSelectedDate(d); if (d) setRange('all') }} />
          </div>
        )}
      </div>

      {/* v1.111 — daily/weekly view chips */}
      <div className="flex items-center gap-1 mb-2">
        {([['all', 'ทั้งหมด'], ['day', 'วันนี้'], ['week', 'สัปดาห์นี้']] as const).map(([k, label]) => (
          <button key={k} onClick={() => { setRange(k); setSelectedDate(null) }}
            className={`text-xs px-3 py-1 rounded-full border ${!selectedDate && range === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-500'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by episode ID, program, producer, location…"
          className="ops-input pl-8"
        />
      </div>

      {loading ? (
        <div className="ops-card ops-empty">
          <Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="ops-card ops-empty">
          <Inbox className="w-6 h-6 text-gray-300 mx-auto mb-2" />
          {search.trim() ? (
            <>
              No bookings match &ldquo;{search}&rdquo;.
              <button onClick={() => setSearch('')} className="ml-2 text-brand-primary hover:underline text-xs">Clear search</button>
            </>
          ) : tab === 'upcoming' ? (
            <>No upcoming bookings — <Link href="/new" className="text-brand-primary hover:underline">create one</Link></>
          ) : (
            <>No {tab.toLowerCase()} bookings.</>
          )}
        </div>
      ) : (
        <ul className="ops-card divide-y divide-gray-100 overflow-hidden">
          {filtered.map(b => <BookingRow key={b.id} b={b} canUpload={canUpload} meEmail={meEmail} />)}
        </ul>
      )}
    </div>
  )
}

function BookingRow({ b, canUpload, meEmail }: { b: Booking; canUpload: boolean; meEmail: string }) {
  const d = parseISO(b.shootDate)
  const valid = !isNaN(d.getTime())
  const showUpload = canUpload && (b.status === 'CONFIRMED' || b.status === 'COMPLETED')
  const isOwner = !!meEmail && ((b.createdByEmail || '').toLowerCase() === meEmail || (b.producerEmail || '').toLowerCase() === meEmail)
  // v1.150.1 — CONFIRMED bookings stay owner-editable for LOCATION only (the
  // venue link changes after approval more often than anything else).
  const canEdit = (b.status === 'REQUESTED' || b.status === 'CONFIRMED') && isOwner
  const editIsLocationOnly = b.status === 'CONFIRMED'
  return (
    <li className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors ${categoryCardClass(b.category)}`}>
      <Link
        href={`/dashboard/${b.id}`}
        className="flex items-center gap-3 flex-1 min-w-0"
      >
        <div className="flex-shrink-0 w-28">
          <div className="text-xs font-medium text-gray-700 leading-tight">{valid ? formatDisplayDate(b.shootDate) : '—'}</div>
          <div className="text-[10px] text-gray-400 tabular-nums mt-0.5">{b.callTime}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-900 font-medium truncate">
            <span className="text-gray-500 font-normal mr-1">[{b.outlet.code}]</span>
            {b.isBlockShot ? '🧱 ' : ''}{bookingDisplayName(b)}
            {b.episodes[0]?.title ? <span className="text-gray-500 font-normal"> — {b.episodes[0].title}</span> : null}
          </div>
          <div className="text-xs text-gray-500 truncate mt-0.5">
            {b.episodes.slice(0, 2).map(e => e.episodeId).join(' · ')}
            {b.episodes.length > 2 && ` +${b.episodes.length - 2}`}
            {b.locationName && <> · {b.locationName}</>}
          </div>
          <div className="text-xs text-gray-400 truncate mt-0.5">Producer: {b.producer}</div>
          <CrewLine crew={b.assignedCrew} meEmail={meEmail} />
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusPill status={b.status} />
          <AdBadge category={b.category} />
          <FootageBadge files={b.footageFiles} sent={b.footageSent} />
        </div>
      </Link>
      {canEdit && (
        <Link
          href={`/bookings/${b.id}/edit`}
          title={editIsLocationOnly ? 'แก้สถานที่ / ลิงก์แผนที่ (งาน Confirmed แก้ได้เฉพาะสถานที่)' : 'แก้ไขรายละเอียดงาน (เฉพาะงานสถานะ Requested)'}
          className="ml-1 shrink-0 px-2.5 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] bg-white rounded hover:bg-[#673ab7] hover:text-white inline-flex items-center gap-1"
        >
          {editIsLocationOnly ? <>📍 แก้สถานที่</> : <>✏️ แก้ไข</>}
        </Link>
      )}
      {showUpload && (
        <Link
          href={`/upload?bookingId=${b.id}`}
          title="Upload footage — form prefilled with this booking"
          className="ml-1 shrink-0 px-2.5 py-1.5 text-xs border border-[#673ab7] text-white bg-[#673ab7] rounded hover:bg-[#5e35b1] inline-flex items-center gap-1"
        >
          📹 Upload
        </Link>
      )}
    </li>
  )
}
