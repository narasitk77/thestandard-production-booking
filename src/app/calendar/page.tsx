'use client'

import { bookingDisplayName } from '@/lib/display'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Loader2, X, Copy, Check, ExternalLink, CalendarPlus } from 'lucide-react'
import {
  format, addMonths, subMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isSameDay, startOfToday, addDays,
} from 'date-fns'
import StatusPill, { statusDotClass } from '@/app/_components/StatusPill'
import { hasConsoleAccess, type Role } from '@/lib/roles'
// v1.129 — the drawer became a full edit/assign surface; it lives in its own file.
import { BookingDrawer } from './BookingDrawer'
import type { Booking } from './types'

// The show the crew is shooting — shared rule (src/lib/display.ts), same
// as the Google Calendar event title (v1.45.0).
const showName = bookingDisplayName

type ViewMode = 'month' | 'agenda'
type CalSource = 'app' | 'google'

// v1.60 — the shared Google Calendar all approved bookings sync to. Embed +
// "subscribe" links use this. Defaults to the production calendar (same id as
// GOOGLE_CALENDAR_ID's fallback in google-calendar.ts); override at build time
// with NEXT_PUBLIC_GOOGLE_CALENDAR_ID if the target calendar ever changes.
const CALENDAR_ID =
  process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_ID ||
  '72bf6ae390fb09d1e0a117dbaf421799be6bcc3b21ec2b7c3e2d7a65e65f9dc5@group.calendar.google.com'
const CAL_ENC = encodeURIComponent(CALENDAR_ID)
const EMBED_SRC = `https://calendar.google.com/calendar/embed?src=${CAL_ENC}&ctz=Asia%2FBangkok`
const SUBSCRIBE_URL = `https://calendar.google.com/calendar/render?cid=${CAL_ENC}`
const SOURCE_KEY = 'probook.calendar.source'

export default function CalendarPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState(new Date())
  const [selected, setSelected] = useState<Date | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  // Mobile defaults to agenda; desktop to month. View persists per session
  // but resets if the user navigates away — kept in component state.
  const [view, setView] = useState<ViewMode>('month')
  const [autoSwitched, setAutoSwitched] = useState(false)
  // v1.60 — switch between the in-app calendar and the embedded Google Calendar
  const [source, setSource] = useState<CalSource>('app')
  useEffect(() => {
    try { if (localStorage.getItem(SOURCE_KEY) === 'google') setSource('google') } catch {}
  }, [])
  const pickSource = (s: CalSource) => {
    setSource(s)
    try { localStorage.setItem(SOURCE_KEY, s) } catch {}
  }

  // v1.128 — Coordinator-and-above can edit/assign a booking straight from the drawer.
  const [canEdit, setCanEdit] = useState(false)
  const [meEmail, setMeEmail] = useState<string | undefined>(undefined)
  useEffect(() => {
    fetch('/api/me').then(r => r.ok ? r.json() : null)
      .then(d => {
        const role = (d?.role ?? d?.user?.role) as Role | undefined
        if (role) setCanEdit(hasConsoleAccess(role))
        const email = d?.email ?? d?.user?.email
        if (email) setMeEmail(String(email).toLowerCase())
      })
      .catch(() => {})
  }, [])

  // Silent refetch (no grid flash) — used after a drawer save.
  const refresh = () =>
    fetch('/api/bookings?limit=500&withCrew=1')
      .then(r => r.json())
      .then(d => setBookings(d.bookings || []))
      .catch(() => {})

  useEffect(() => {
    setLoading(true)
    refresh().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-switch to agenda on first paint if viewport is narrow.
  useEffect(() => {
    if (autoSwitched) return
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      setView('agenda')
    }
    setAutoSwitched(true)
  }, [autoSwitched])

  const monthStart = startOfMonth(cursor)
  const monthEnd = endOfMonth(cursor)
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 })
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd })

  const bookingsByDay = useMemo(() => {
    const map = new Map<string, Booking[]>()
    bookings.forEach(b => {
      const key = b.shootDate.slice(0, 10)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(b)
    })
    map.forEach(arr => arr.sort((a, b) => a.callTime.localeCompare(b.callTime)))
    return map
  }, [bookings])

  const selectedBookings = selected
    ? bookingsByDay.get(format(selected, 'yyyy-MM-dd')) || []
    : []

  const openBooking = openId ? bookings.find(b => b.id === openId) : null

  // Agenda: next 30 days grouped by day, today first.
  const agenda = useMemo(() => {
    const today = startOfToday()
    const end = addDays(today, 30)
    const days: { date: Date; bookings: Booking[] }[] = []
    for (let i = 0; i < 30; i++) {
      const d = addDays(today, i)
      const key = format(d, 'yyyy-MM-dd')
      const list = bookingsByDay.get(key)
      if (list && list.length > 0) days.push({ date: d, bookings: list })
    }
    return days
  }, [bookingsByDay])

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="mb-4 flex items-start sm:items-center justify-between gap-2 flex-wrap">
        <div>
          <h1>Production Calendar</h1>
          <p className="text-xs text-gray-500 mt-0.5">All bookings · Asia/Bangkok</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Source toggle: in-app calendar vs embedded Google Calendar */}
          <div className="inline-flex rounded-lg border border-gray-300 p-0.5 bg-white">
            <button
              onClick={() => pickSource('app')}
              className={`px-2.5 py-1 text-xs rounded-md ${source === 'app' ? 'bg-[#673ab7] text-white' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              ปฏิทินในระบบ
            </button>
            <button
              onClick={() => pickSource('google')}
              className={`px-2.5 py-1 text-xs rounded-md ${source === 'google' ? 'bg-[#673ab7] text-white' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              Google Calendar
            </button>
          </div>
          {/* View toggle (in-app only) */}
          {source === 'app' && (
          <div className="inline-flex rounded-lg border border-gray-300 p-0.5 bg-white">
            <button
              onClick={() => setView('month')}
              className={`px-2.5 py-1 text-xs rounded-md ${view === 'month' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              Month
            </button>
            <button
              onClick={() => setView('agenda')}
              className={`px-2.5 py-1 text-xs rounded-md ${view === 'agenda' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              Agenda
            </button>
          </div>
          )}
          {source === 'app' && view === 'month' && (
            <div className="flex gap-1 items-center">
              <button onClick={() => setCursor(subMonths(cursor, 1))}
                className="ops-btn-secondary ops-btn-sm" aria-label="Previous month">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => setCursor(new Date())}
                className="ops-btn-secondary ops-btn-sm">
                Today
              </button>
              <button onClick={() => setCursor(addMonths(cursor, 1))}
                className="ops-btn-secondary ops-btn-sm" aria-label="Next month">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {source === 'google' && <GoogleCalendarPanel />}

      {source === 'app' && (view === 'month' ? (
        <MonthGrid
          cursor={cursor}
          days={days}
          loading={loading}
          bookingsByDay={bookingsByDay}
          selected={selected}
          onSelectDay={d => setSelected(d)}
          onOpenBooking={id => setOpenId(id)}
        />
      ) : (
        <AgendaList
          loading={loading}
          agenda={agenda}
          onOpenBooking={id => setOpenId(id)}
        />
      ))}

      {/* v1.128 — clicking a day opens its list as a right-side drawer (was a
          card below the grid); picking a booking stacks the detail/edit drawer
          on top, with "←" back to the day list. */}
      <DayDrawer
        date={openId ? null : selected}
        bookings={selectedBookings}
        onClose={() => setSelected(null)}
        onOpenBooking={id => setOpenId(id)}
      />
      <BookingDrawer
        booking={openBooking}
        onClose={() => { setOpenId(null); setSelected(null) }}
        onBack={selected ? () => setOpenId(null) : undefined}
        canEdit={canEdit}
        onSaved={refresh}
        meEmail={meEmail}
      />
    </div>
  )
}

/* ---------- Day drawer: a whole day's bookings as a right slide-over ---------- */

function DayDrawer({ date, bookings, onClose, onOpenBooking }: {
  date: Date | null
  bookings: Booking[]
  onClose: () => void
  onOpenBooking: (id: string) => void
}) {
  useEffect(() => {
    if (!date) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [date, onClose])

  if (!date) return null
  return (
    <>
      <button aria-label="Close drawer" onClick={onClose} className="fixed inset-0 bg-black/30 z-40" />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed z-50 bg-white shadow-xl flex flex-col
                   inset-x-0 bottom-0 max-h-[90vh] rounded-t-2xl
                   sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[420px] sm:max-h-none sm:rounded-none sm:rounded-l-2xl"
      >
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2 flex-shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900">{format(date, 'EEEE, d MMMM yyyy')}</div>
            <div className="text-xs text-gray-500 mt-0.5">{bookings.length} booking{bookings.length === 1 ? '' : 's'} · กดงานเพื่อดู/แก้ไข</div>
          </div>
          <button onClick={onClose} className="p-1.5 -mr-1 text-gray-500 hover:text-gray-900 rounded-md hover:bg-gray-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {bookings.length === 0 ? (
            <div className="ops-empty">No bookings on this day.</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {bookings.map(b => <BookingRow key={b.id} b={b} onOpen={() => onOpenBooking(b.id)} />)}
            </ul>
          )}
        </div>
        <div className="px-4 py-3 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose} className="ops-btn-ghost ops-btn-sm">Close</button>
        </div>
      </div>
    </>
  )
}

/* ---------- Google Calendar embed + subscribe (v1.60) ---------- */
function GoogleCalendarPanel() {
  const [copied, setCopied] = useState(false)
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(CALENDAR_ID)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }
  return (
    <div className="space-y-3">
      {/* Subscribe card */}
      <div className="ops-card ops-card-pad">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">ติดตามปฏิทินนี้ (Subscribe)</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              เพิ่มปฏิทินงานถ่ายเข้า Google Calendar ของคุณ — งานที่อนุมัติแล้วจะซิงก์มาที่นี่อัตโนมัติ
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a href={SUBSCRIBE_URL} target="_blank" rel="noopener noreferrer"
              className="ops-btn ops-btn-primary ops-btn-sm inline-flex items-center gap-1">
              <CalendarPlus className="w-3.5 h-3.5" /> เพิ่มลงปฏิทินของฉัน
            </a>
            <a href={EMBED_SRC} target="_blank" rel="noopener noreferrer"
              className="ops-btn ops-btn-secondary ops-btn-sm inline-flex items-center gap-1">
              <ExternalLink className="w-3.5 h-3.5" /> เปิดเต็มจอ
            </a>
          </div>
        </div>
        <div className="mt-3">
          <div className="text-[11px] text-gray-500 mb-1">Calendar ID (สำหรับ Subscribe ด้วยตนเองใน Google Calendar → “Subscribe to calendar”)</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1.5 text-gray-700">
              {CALENDAR_ID}
            </code>
            <button onClick={copyId}
              className="ops-btn ops-btn-secondary ops-btn-sm inline-flex items-center gap-1 flex-shrink-0">
              {copied ? <><Check className="w-3.5 h-3.5 text-green-600" /> คัดลอกแล้ว</> : <><Copy className="w-3.5 h-3.5" /> คัดลอก</>}
            </button>
          </div>
        </div>
      </div>

      {/* Embed */}
      <div className="ops-card overflow-hidden">
        <iframe
          src={EMBED_SRC}
          title="THE STANDARD Production Bookings — Google Calendar"
          className="w-full"
          style={{ border: 0, height: '70vh', minHeight: 480 }}
          loading="lazy"
        />
      </div>
      <p className="text-[11px] text-gray-500 leading-snug">
        ถ้าช่องด้านบนว่าง: ปฏิทินถูกตั้งเป็นส่วนตัว — กด <span className="text-[#673ab7]">“เพิ่มลงปฏิทินของฉัน”</span> เพื่อดู event ใน Google Calendar ของคุณ
        (เห็นครบเมื่อล็อกอินบัญชีที่มีสิทธิ์) หรือให้แอดมินตั้งปฏิทินเป็น “สาธารณะ — เห็นรายละเอียด event” เพื่อให้ embed แสดงกับทุกคน ·
        งานจะขึ้นปฏิทินเฉพาะที่ <strong>อนุมัติแล้ว (CONFIRMED)</strong> เท่านั้น
      </p>
    </div>
  )
}

/* ---------- Month grid ---------- */

function MonthGrid({
  cursor, days, loading, bookingsByDay, selected, onSelectDay, onOpenBooking,
}: {
  cursor: Date
  days: Date[]
  loading: boolean
  bookingsByDay: Map<string, Booking[]>
  selected: Date | null
  onSelectDay: (d: Date) => void
  onOpenBooking: (id: string) => void
}) {
  return (
    <div className="ops-card overflow-hidden">
      <div className="px-3 sm:px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2 flex-wrap">
        <span className="text-base font-semibold text-gray-900">{format(cursor, 'MMMM yyyy')}</span>
        <div className="flex gap-2 sm:gap-3 text-[11px] flex-wrap">
          {(['REQUESTED','ASSIGNED','CONFIRMED','COMPLETED','CANCELLED'] as const).map(s => (
            <span key={s} className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full ${statusDotClass(s)}`}></span>
              <span className="text-gray-500">{s}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
        {['Mo','Tu','We','Th','Fr','Sa','Su'].map((d, i) => (
          <div key={d} className="px-1 sm:px-2 py-2 text-[10px] sm:text-xs font-medium text-gray-500 text-center">
            <span className="sm:hidden">{d}</span>
            <span className="hidden sm:inline">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}</span>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="py-20 text-center"><Loader2 className="w-6 h-6 animate-spin text-gray-400 mx-auto" /></div>
      ) : (
        <div className="grid grid-cols-7">
          {days.map(day => {
            const key = format(day, 'yyyy-MM-dd')
            const dayBookings = bookingsByDay.get(key) || []
            const inMonth = isSameMonth(day, cursor)
            const isToday = isSameDay(day, new Date())
            const isSelected = selected && isSameDay(day, selected)
            return (
              <button
                key={key}
                onClick={() => onSelectDay(day)}
                className={`min-h-20 sm:min-h-28 border-b border-r border-gray-100 p-1 sm:p-1.5 text-left hover:bg-gray-50 active:bg-gray-100 transition-colors ${
                  !inMonth ? 'bg-gray-50/50' : ''
                } ${isSelected ? 'ring-2 ring-brand-primary ring-inset' : ''}`}
              >
                <div className={`text-[11px] sm:text-xs mb-1 ${
                  isToday ? 'inline-flex items-center justify-center w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-gray-900 text-white font-medium' :
                  inMonth ? 'text-gray-700' : 'text-gray-400'
                }`}>
                  {format(day, 'd')}
                </div>
                {/* Mobile: colored dots */}
                <div className="flex flex-wrap gap-0.5 sm:hidden">
                  {dayBookings.slice(0, 4).map(b => (
                    <span key={b.id} className={`w-1.5 h-1.5 rounded-full ${statusDotClass(b.status)}`} />
                  ))}
                  {dayBookings.length > 4 && (
                    <span className="text-[9px] text-gray-400">+{dayBookings.length - 4}</span>
                  )}
                </div>
                {/* Desktop: event chips */}
                <div className="hidden sm:block space-y-0.5">
                  {dayBookings.slice(0, 3).map(b => (
                    <div
                      key={b.id}
                      onClick={e => { e.stopPropagation(); onSelectDay(day); onOpenBooking(b.id) }}
                      className={`flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded cursor-pointer leading-tight border border-gray-100 hover:border-gray-400 transition-colors`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotClass(b.status)}`} aria-hidden />
                      <span className="font-medium tabular-nums flex-shrink-0 text-gray-700">{b.callTime}</span>
                      <span className="text-gray-400 flex-shrink-0">·</span>
                      <span className="font-medium flex-shrink-0 text-gray-600">{b.outlet.code}</span>
                      <span className="text-gray-400 flex-shrink-0">·</span>
                      <span className="truncate flex-1 text-gray-600">{b.needsVan && <span title="ต้องการรถตู้">🚐 </span>}{showName(b)}</span>
                    </div>
                  ))}
                  {dayBookings.length > 3 && (
                    <div className="text-[10px] text-gray-400 px-1">+{dayBookings.length - 3} more</div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------- Agenda list ---------- */

function AgendaList({ loading, agenda, onOpenBooking }: {
  loading: boolean
  agenda: { date: Date; bookings: Booking[] }[]
  onOpenBooking: (id: string) => void
}) {
  if (loading) {
    return (
      <div className="ops-card py-16 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400 mx-auto" />
      </div>
    )
  }
  if (agenda.length === 0) {
    return (
      <div className="ops-card ops-empty">
        No bookings in the next 30 days.
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {agenda.map(({ date, bookings }) => {
        const today = isSameDay(date, new Date())
        return (
          <div key={format(date, 'yyyy-MM-dd')} className="ops-card overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <div className="text-sm font-semibold text-gray-900">
                {today && <span className="inline-block mr-2 text-[10px] bg-gray-900 text-white px-1.5 py-0.5 rounded font-medium uppercase tracking-wider">Today</span>}
                {format(date, 'EEE, d MMM yyyy')}
              </div>
              <span className="text-xs text-gray-500">{bookings.length} booking{bookings.length === 1 ? '' : 's'}</span>
            </div>
            <ul className="divide-y divide-gray-100">
              {bookings.map(b => <BookingRow key={b.id} b={b} onOpen={() => onOpenBooking(b.id)} />)}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/* ---------- Booking row (used by selected-day + agenda) ---------- */

function BookingRow({ b, onOpen }: { b: Booking; onOpen: () => void }) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="text-sm text-gray-700 w-20 flex-shrink-0 tabular-nums">
          {b.callTime}
          {b.estimatedWrap && <span className="text-gray-400 text-xs"> → {b.estimatedWrap}</span>}
        </div>
        <StatusPill status={b.status} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-900 font-medium truncate">
            <span className="text-gray-500 font-normal mr-1">[{b.outlet.code}]</span>
            {b.needsVan && <span title="ต้องการรถตู้">🚐 </span>}
            {b.isBlockShot ? '🧱 ' : ''}{showName(b)}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {b.episodes.slice(0, 2).map(e => e.episodeId).join(' · ')}
            {b.episodes.length > 2 && ` +${b.episodes.length - 2}`}
            {b.producer && ` · ${b.producer}`}
            {/* v1.97.0 — show camera (+mic) count in the agenda row */}
            {b.isBlockShot
              ? <span className="text-gray-400"> · 🎥 TBC</span>
              : (typeof b.cameraCount === 'number' && b.cameraCount > 0) && (
                  <span className="text-gray-600"> · 🎥 {b.cameraCount}{typeof b.micCount === 'number' && b.micCount > 0 ? ` · 🎙 ${b.micCount}` : ''}</span>
                )}
          </div>
        </div>
      </button>
    </li>
  )
}
