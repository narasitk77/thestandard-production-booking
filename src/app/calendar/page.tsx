'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Loader2, X, MapPin, User, Tag } from 'lucide-react'
import {
  format, addMonths, subMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isSameDay, parseISO, startOfToday, addDays,
} from 'date-fns'
import StatusPill, { statusDotClass } from '@/app/_components/StatusPill'

interface Episode { episodeId: string; title: string }
interface Booking {
  id: string
  shootDate: string
  callTime: string
  estimatedWrap?: string
  status: string
  shootType: string
  locationName?: string
  producer: string
  needsVan?: boolean
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}

type ViewMode = 'month' | 'agenda'

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

  useEffect(() => {
    setLoading(true)
    fetch('/api/bookings?limit=500')
      .then(r => r.json())
      .then(d => setBookings(d.bookings || []))
      .finally(() => setLoading(false))
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
        <div className="flex items-center gap-2">
          {/* View toggle */}
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
          {view === 'month' && (
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

      {view === 'month' ? (
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
      )}

      {/* Selected-day list — only meaningful in month view. */}
      {view === 'month' && selected && (
        <div className="mt-4 ops-card">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">{format(selected, 'EEEE, d MMMM yyyy')}</h2>
            <button onClick={() => setSelected(null)} className="text-xs text-gray-500 hover:text-gray-900">Close</button>
          </div>
          {selectedBookings.length === 0 ? (
            <div className="ops-empty">No bookings on this day.</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {selectedBookings.map(b => (
                <BookingRow key={b.id} b={b} onOpen={() => setOpenId(b.id)} />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Booking detail drawer */}
      <BookingDrawer booking={openBooking} onClose={() => setOpenId(null)} />
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
                      onClick={e => { e.stopPropagation(); onOpenBooking(b.id) }}
                      className={`flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded cursor-pointer leading-tight border border-gray-100 hover:border-gray-400 transition-colors`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotClass(b.status)}`} aria-hidden />
                      <span className="font-medium tabular-nums flex-shrink-0 text-gray-700">{b.callTime}</span>
                      <span className="text-gray-400 flex-shrink-0">·</span>
                      <span className="font-medium flex-shrink-0 text-gray-600">{b.outlet.code}</span>
                      <span className="text-gray-400 flex-shrink-0">·</span>
                      <span className="truncate flex-1 text-gray-600">{b.needsVan && <span title="ต้องการรถตู้">🚐 </span>}{b.program.name}</span>
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
            {b.program.name}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {b.episodes.slice(0, 2).map(e => e.episodeId).join(' · ')}
            {b.episodes.length > 2 && ` +${b.episodes.length - 2}`}
            {b.producer && ` · ${b.producer}`}
          </div>
        </div>
      </button>
    </li>
  )
}

/* ---------- Slide-in detail drawer ---------- */

function BookingDrawer({ booking, onClose }: { booking: Booking | null | undefined; onClose: () => void }) {
  useEffect(() => {
    if (!booking) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [booking, onClose])

  if (!booking) return null
  const b = booking

  return (
    <>
      {/* Scrim */}
      <button
        aria-label="Close drawer"
        onClick={onClose}
        className="fixed inset-0 bg-black/30 z-40"
      />
      {/* Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        className="fixed z-50 bg-white shadow-xl flex flex-col
                   inset-x-0 bottom-0 max-h-[90vh] rounded-t-2xl
                   sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[420px] sm:max-h-none sm:rounded-none sm:rounded-l-2xl"
      >
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2 flex-shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <StatusPill status={b.status} />
              <span className="text-xs text-gray-500 tabular-nums">{b.callTime}{b.estimatedWrap && ` → ${b.estimatedWrap}`}</span>
            </div>
            <div className="text-sm font-semibold text-gray-900 truncate">{b.needsVan && <span title="ต้องการรถตู้">🚐 </span>}{b.outlet.name} · {b.program.name}</div>
          </div>
          <button onClick={onClose} className="p-1.5 -mr-1 text-gray-500 hover:text-gray-900 rounded-md hover:bg-gray-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-sm">
          <div>
            <div className="ops-section-title mb-2">Schedule</div>
            <div className="text-gray-800">{format(parseISO(b.shootDate), 'EEE d MMM yyyy')}</div>
            <div className="text-gray-500 text-xs tabular-nums">{b.callTime}{b.estimatedWrap && ` → ${b.estimatedWrap}`}</div>
          </div>

          <div>
            <div className="ops-section-title mb-2">Location</div>
            <div className="text-gray-800 flex items-start gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
              <span>{b.locationName || '—'}</span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{b.shootType.replace('_', ' ')}</div>
          </div>

          <div>
            <div className="ops-section-title mb-2">People</div>
            <div className="text-gray-800 flex items-start gap-1.5">
              <User className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
              <span>Producer: {b.producer || '—'}</span>
            </div>
          </div>

          <div>
            <div className="ops-section-title mb-2">Episodes</div>
            <div className="space-y-1">
              {b.episodes.length === 0 ? (
                <span className="text-gray-400 text-xs">—</span>
              ) : b.episodes.map(ep => (
                <div key={ep.episodeId} className="flex items-start gap-2 text-xs">
                  <Tag className="w-3 h-3 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <span className="episode-badge">{ep.episodeId}</span>
                    {ep.title && <span className="ml-2 text-gray-600">{ep.title}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-2 flex-shrink-0">
          <button onClick={onClose} className="ops-btn-ghost ops-btn-sm">Close</button>
          <Link href={`/dashboard/${b.id}`} className="ops-btn-primary ops-btn-sm">
            Open detail →
          </Link>
        </div>
      </div>
    </>
  )
}
