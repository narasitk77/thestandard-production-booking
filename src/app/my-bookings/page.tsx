'use client'

import { bookingShowName } from '@/lib/display'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Plus, Search, Inbox } from 'lucide-react'
import { format, parseISO, startOfToday, isAfter, isToday } from 'date-fns'
import StatusPill from '@/app/_components/StatusPill'

interface Episode { episodeId: string; title: string; program?: { code?: string; name: string } | null }
interface Booking {
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
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
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
    fetch('/api/bookings?scope=mine&limit=200')
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

  const filtered = useMemo(() => {
    const b = bookings || []
    const today0 = startOfToday()
    let list = b
    if (tab === 'upcoming') {
      list = b.filter(x => {
        const d = parseISO(x.shootDate)
        if (isNaN(d.getTime())) return false
        if (x.status === 'CANCELLED') return false
        return isToday(d) || isAfter(d, today0)
      })
      // Upcoming sorts ascending — soonest first — opposite the API default.
      list = [...list].sort((a, b) => a.shootDate.localeCompare(b.shootDate))
    } else {
      list = b.filter(x => x.status === tab)
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
  }, [bookings, tab, search])

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
  const canEdit = b.status === 'REQUESTED' && isOwner
  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
      <Link
        href={`/dashboard/${b.id}`}
        className="flex items-center gap-3 flex-1 min-w-0"
      >
        <div className="flex-shrink-0 w-14 text-center">
          <div className="text-[10px] text-gray-400 uppercase">{valid ? format(d, 'EEE') : '—'}</div>
          <div className="text-base font-semibold text-gray-800 tabular-nums leading-none">{valid ? format(d, 'd') : '--'}</div>
          <div className="text-[10px] text-gray-400 tabular-nums mt-0.5">{b.callTime}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-900 font-medium truncate">
            <span className="text-gray-500 font-normal mr-1">[{b.outlet.code}]</span>
            {bookingShowName(b)}
          </div>
          <div className="text-xs text-gray-500 truncate mt-0.5">
            {b.episodes.slice(0, 2).map(e => e.episodeId).join(' · ')}
            {b.episodes.length > 2 && ` +${b.episodes.length - 2}`}
            {b.locationName && <> · {b.locationName}</>}
          </div>
          <div className="text-xs text-gray-400 truncate mt-0.5">Producer: {b.producer}</div>
        </div>
        <StatusPill status={b.status} />
      </Link>
      {canEdit && (
        <Link
          href={`/bookings/${b.id}/edit`}
          title="แก้ไขรายละเอียดงาน (เฉพาะงานสถานะ Requested)"
          className="ml-1 shrink-0 px-2.5 py-1.5 text-xs border border-[#673ab7] text-[#673ab7] bg-white rounded hover:bg-[#673ab7] hover:text-white inline-flex items-center gap-1"
        >
          ✏️ แก้ไข
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
