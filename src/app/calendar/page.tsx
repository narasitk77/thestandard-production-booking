'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { format, addMonths, subMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, isSameMonth, isSameDay, parseISO } from 'date-fns'

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
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}

const STATUS_COLOR: Record<string, { dot: string; bg: string; text: string }> = {
  REQUESTED: { dot: 'bg-red-500',    bg: 'bg-red-50',    text: 'text-red-700' },
  CONFIRMED: { dot: 'bg-green-500',  bg: 'bg-green-50',  text: 'text-green-700' },
  COMPLETED: { dot: 'bg-blue-500',   bg: 'bg-blue-50',   text: 'text-blue-700' },
  CANCELLED: { dot: 'bg-gray-400',   bg: 'bg-gray-100',  text: 'text-gray-500' },
}

export default function CalendarPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState(new Date())
  const [selected, setSelected] = useState<Date | null>(null)
  const [hovered, setHovered] = useState<{ booking: Booking; x: number; y: number } | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch('/api/bookings?limit=500')
      .then(r => r.json())
      .then(d => setBookings(d.bookings || []))
      .finally(() => setLoading(false))
  }, [])

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

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="mb-4 flex items-start sm:items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Production Calendar</h1>
          <p className="text-xs sm:text-sm text-gray-500">All bookings · Asia/Bangkok</p>
        </div>
        <div className="flex gap-1.5 sm:gap-2 items-center">
          <button onClick={() => setCursor(subMonths(cursor, 1))}
            className="p-2 border border-gray-300 rounded hover:bg-gray-50 active:bg-gray-100">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={() => setCursor(new Date())}
            className="px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-50 active:bg-gray-100">
            Today
          </button>
          <button onClick={() => setCursor(addMonths(cursor, 1))}
            className="p-2 border border-gray-300 rounded hover:bg-gray-50 active:bg-gray-100">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-3 sm:px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-base sm:text-lg font-medium text-gray-800">{format(cursor, 'MMMM yyyy')}</span>
          <div className="flex gap-2 sm:gap-3 text-[10px] sm:text-xs flex-wrap">
            {Object.entries(STATUS_COLOR).map(([k, c]) => (
              <span key={k} className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${c.dot}`}></span>
                <span className="text-gray-500">{k}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
          {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d, i) => (
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
                  onClick={() => setSelected(day)}
                  className={`min-h-16 sm:min-h-24 border-b border-r border-gray-100 p-1 sm:p-1.5 text-left hover:bg-gray-50 active:bg-gray-100 transition-colors ${
                    !inMonth ? 'bg-gray-50/50' : ''
                  } ${isSelected ? 'ring-2 ring-[#673ab7] ring-inset' : ''}`}
                >
                  <div className={`text-[11px] sm:text-xs mb-0.5 sm:mb-1 ${
                    isToday ? 'inline-flex items-center justify-center w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-[#673ab7] text-white' :
                    inMonth ? 'text-gray-700' : 'text-gray-400'
                  }`}>
                    {format(day, 'd')}
                  </div>
                  <div className="space-y-0.5">
                    {/* Mobile: show only colored dots, Desktop: full chips */}
                    <div className="flex flex-wrap gap-0.5 sm:hidden">
                      {dayBookings.slice(0, 4).map(b => {
                        const c = STATUS_COLOR[b.status] || STATUS_COLOR.REQUESTED
                        return <span key={b.id} className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                      })}
                      {dayBookings.length > 4 && (
                        <span className="text-[9px] text-gray-400">+{dayBookings.length - 4}</span>
                      )}
                    </div>
                    <div className="hidden sm:block space-y-0.5">
                      {dayBookings.slice(0, 3).map(b => {
                        const c = STATUS_COLOR[b.status] || STATUS_COLOR.REQUESTED
                        return (
                          <div key={b.id}
                            onMouseEnter={e => {
                              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                              setHovered({ booking: b, x: r.left + r.width / 2, y: r.top })
                            }}
                            onMouseLeave={() => setHovered(null)}
                            className={`flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${c.bg} ${c.text} border border-current/10 cursor-pointer leading-tight`}>
                            <span className="font-medium tabular-nums flex-shrink-0">{b.callTime}</span>
                            <span className="opacity-50 flex-shrink-0">·</span>
                            <span className="font-medium flex-shrink-0">{b.outlet.code}</span>
                            <span className="opacity-50 flex-shrink-0">·</span>
                            <span className="truncate flex-1 opacity-90">{b.program.name}</span>
                          </div>
                        )
                      })}
                      {dayBookings.length > 3 && (
                        <div className="text-[10px] text-gray-400 px-1">+{dayBookings.length - 3} more</div>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Hover tooltip */}
      {hovered && (() => {
        const b = hovered.booking
        const c = STATUS_COLOR[b.status] || STATUS_COLOR.REQUESTED
        return (
          <div
            className="fixed z-50 bg-white shadow-xl rounded-lg border border-gray-200 p-3 w-72 text-xs pointer-events-none"
            style={{
              left: Math.min(Math.max(8, hovered.x - 144), (typeof window !== 'undefined' ? window.innerWidth : 1024) - 296),
              top: hovered.y - 8,
              transform: 'translateY(-100%)',
            }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${c.bg} ${c.text} border border-current/20`}>
                {b.status === 'REQUESTED' ? '[REQUESTED]' : b.status}
              </span>
              <span className="text-gray-400 text-[11px]">{b.callTime}{b.estimatedWrap && ` → ${b.estimatedWrap}`}</span>
            </div>
            <div className="font-medium text-gray-800 mb-0.5 leading-snug">{b.outlet.name} · {b.program.name}</div>
            <div className="text-gray-500 text-[11px] mb-1.5">
              {b.shootType.replace('_', ' ')}{b.locationName && ` @ ${b.locationName}`}
            </div>
            <div className="border-t border-gray-100 pt-1.5 space-y-0.5">
              <div className="text-gray-500"><span className="text-gray-400">Producer:</span> {b.producer}</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {b.episodes.slice(0, 3).map(ep => (
                  <span key={ep.episodeId} className="episode-badge text-[10px]">{ep.episodeId}</span>
                ))}
                {b.episodes.length > 3 && <span className="text-gray-400">+{b.episodes.length - 3}</span>}
              </div>
              {b.episodes[0]?.title && (
                <div className="text-gray-500 truncate mt-1 text-[11px]"><span className="text-gray-400">First ep:</span> {b.episodes[0].title}</div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Selected day details */}
      {selected && (
        <div className="mt-5 bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-base font-medium text-gray-800">
              {format(selected, 'EEEE, d MMMM yyyy')}
            </h2>
            <button onClick={() => setSelected(null)} className="text-xs text-gray-400 hover:text-gray-700">Close</button>
          </div>
          {selectedBookings.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-gray-400">No bookings on this day.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {selectedBookings.map(b => {
                const c = STATUS_COLOR[b.status] || STATUS_COLOR.REQUESTED
                return (
                  <Link key={b.id} href={`/admin/${b.id}`}
                    className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
                    <div className="text-sm text-gray-500 w-20 flex-shrink-0">
                      {b.callTime}{b.estimatedWrap && ` → ${b.estimatedWrap}`}
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${c.bg} ${c.text} border border-current/20`}>
                      {b.status === 'REQUESTED' ? '[REQUESTED]' : b.status}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-800 font-medium truncate">
                        {b.outlet.name} · {b.program.name}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {b.episodes.slice(0, 2).map(e => e.episodeId).join(' · ')}
                        {b.episodes.length > 2 && ` +${b.episodes.length - 2}`}
                        {' · '}Producer: {b.producer}
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
