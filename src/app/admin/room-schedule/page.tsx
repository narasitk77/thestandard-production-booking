'use client'

// v1.131 — per-room/day availability view for Management (capacity planning):
// "โชว์ได้ว่า วันที่จองมี Slot เวลาไหนว่างบ้าง". Pure read/visibility tool — no
// writes. Physical TSD rooms only (LOCATION_GROUPS STUDIO/A/B); EXTERNAL
// (On Location / Remote / Other) has no fixed slot to show.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { LOCATIONS, LOCATION_GROUPS } from '@/lib/locations'
import { effectiveWrap } from '@/lib/shoot-window'
import { bookingDisplayName } from '@/lib/display'
import StatusPill, { statusDotClass, AdBadge } from '@/app/_components/StatusPill'

interface Row {
  id: string
  status: string
  category?: string | null
  callTime: string
  estimatedWrap?: string | null
  locationName?: string | null
  projectName?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Array<{ title?: string | null; program?: { name: string } | null }>
}

// Visible window 07:00–23:00 — covers the overwhelming majority of shoots;
// anything outside just clamps to the edge instead of disappearing.
const WINDOW_START_MIN = 7 * 60
const WINDOW_END_MIN = 23 * 60
const WINDOW_SPAN = WINDOW_END_MIN - WINDOW_START_MIN
const HOUR_MARKS = [7, 10, 13, 16, 19, 22]

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '')
  if (!m) return null
  return Math.max(0, Math.min(24 * 60, parseInt(m[1], 10) * 60 + parseInt(m[2], 10)))
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ROOMS = LOCATIONS.filter(l => l.group !== 'EXTERNAL')

export default function RoomSchedulePage() {
  const [date, setDate] = useState(todayStr())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let dead = false
    setLoading(true)
    setError('')
    fetch(`/api/bookings?date=${date}&limit=300`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (dead) return
        if (d.error) { setError(d.error); setRows([]); return }
        setRows((d.bookings || []).filter((b: Row) => b.status !== 'CANCELLED'))
      })
      .catch(e => { if (!dead) setError(e?.message || 'โหลดไม่สำเร็จ') })
      .finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true }
  }, [date])

  // Group bookings by room, matched on locationName === Location.fullName —
  // exactly what the wizard writes for a physical room (BookingWizard.tsx
  // resolvedLocationName). Off-site/remote bookings (locationName unset, or
  // free text for EXTERNAL) never match a room and land in `unmatched`
  // instead of silently vanishing — a capacity-planning view that hides
  // some bookings without saying so is worse than one with an "other" pile.
  const { byRoom, unmatched } = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const room of ROOMS) m.set(room.id, [])
    const leftover: Row[] = []
    for (const b of rows) {
      const room = ROOMS.find(r => r.fullName === b.locationName)
      if (room) m.get(room.id)!.push(b)
      else if ((b.locationName || '').trim()) leftover.push(b)
    }
    m.forEach(list => list.sort((a, b) => (a.callTime || '').localeCompare(b.callTime || '')))
    leftover.sort((a, b) => (a.callTime || '').localeCompare(b.callTime || ''))
    return { byRoom: m, unmatched: leftover }
  }, [rows])

  const isToday = date === todayStr()

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-6 space-y-4">
      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-xl sm:text-2xl font-normal text-gray-800">ตารางห้อง/สตูดิโอ</h1>
        <p className="text-xs sm:text-sm text-gray-500">ดูว่าวันไหน ห้องไหนว่าง — สำหรับวางแผนจองคิวถ่าย</p>
      </div>

      <div className="gf-card p-3 flex items-center gap-2 flex-wrap">
        <button onClick={() => setDate(d => addDays(d, -1))}
          className="p-1.5 rounded border border-gray-300 hover:bg-gray-50" aria-label="วันก่อนหน้า">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm" />
        <button onClick={() => setDate(d => addDays(d, 1))}
          className="p-1.5 rounded border border-gray-300 hover:bg-gray-50" aria-label="วันถัดไป">
          <ChevronRight className="w-4 h-4" />
        </button>
        {!isToday && (
          <button onClick={() => setDate(todayStr())}
            className="text-xs px-2.5 py-1.5 rounded border border-gray-300 hover:bg-gray-50">
            วันนี้
          </button>
        )}
        <span className="text-xs text-gray-400 ml-auto">
          {new Date(date + 'T00:00:00').toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </span>
      </div>

      {error && <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400">{error}</div>}

      {loading ? (
        <div className="gf-card p-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
      ) : (
        <div className="gf-card p-4 space-y-5">
          {/* Hour ruler — same left-spacer + relative/absolute layout as the room
              rows below, so labels line up exactly with the gridlines. */}
          <div className="hidden sm:flex items-center gap-2">
            <div className="w-36 sm:w-40 shrink-0" />
            <div className="relative flex-1 h-4 text-[10px] text-gray-400">
              {HOUR_MARKS.map(h => (
                <span key={h} className="absolute -translate-x-1/2"
                  style={{ left: `${((h * 60 - WINDOW_START_MIN) / WINDOW_SPAN) * 100}%` }}>
                  {String(h).padStart(2, '0')}:00
                </span>
              ))}
            </div>
          </div>

          {LOCATION_GROUPS.filter(g => g.key !== 'EXTERNAL').map(group => (
            <div key={group.key} className="space-y-2">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">{group.label}</div>
              {ROOMS.filter(r => r.group === group.key).map(room => {
                const bookings = byRoom.get(room.id) || []
                return (
                  <div key={room.id} className="flex items-center gap-2">
                    <div className="w-36 sm:w-40 shrink-0 text-xs text-gray-700 truncate" title={room.fullName}>{room.name}</div>
                    <div className="relative flex-1 h-8 bg-gray-50 rounded border border-gray-100 overflow-hidden">
                      {/* hour gridlines */}
                      {HOUR_MARKS.map(h => (
                        <div key={h} className="absolute top-0 bottom-0 border-l border-gray-200"
                          style={{ left: `${((h * 60 - WINDOW_START_MIN) / WINDOW_SPAN) * 100}%` }} />
                      ))}
                      {bookings.length === 0 ? (
                        <div className="absolute inset-0 flex items-center pl-2 text-[11px] text-green-600">ว่างทั้งวัน</div>
                      ) : (
                        bookings.map(b => {
                          const start = Math.max(WINDOW_START_MIN, Math.min(WINDOW_END_MIN, toMinutes(b.callTime) ?? WINDOW_START_MIN))
                          const { end: wrap } = effectiveWrap(b.callTime, b.estimatedWrap)
                          const end = Math.max(start + 20, Math.min(WINDOW_END_MIN, toMinutes(wrap) ?? start + 20))
                          const left = ((start - WINDOW_START_MIN) / WINDOW_SPAN) * 100
                          const width = Math.max(2, ((end - start) / WINDOW_SPAN) * 100)
                          const label = `[${b.outlet.code}] ${bookingDisplayName(b)} · ${b.callTime}${b.estimatedWrap ? `→${b.estimatedWrap}` : ''}`
                          return (
                            <Link key={b.id} href={`/dashboard/${b.id}`} title={label}
                              className={`absolute top-0.5 bottom-0.5 rounded px-1.5 flex items-center gap-1 overflow-hidden text-white text-[10px] font-medium hover:brightness-95 transition ${statusDotClass(b.status)}`}
                              style={{ left: `${left}%`, width: `${width}%` }}>
                              {!!b.category && b.category === 'ADVERTORIAL' && (
                                <span className="bg-white/90 text-amber-800 rounded-full px-1 text-[9px] font-semibold shrink-0">AD</span>
                              )}
                              <span className="truncate">[{b.outlet.code}] {bookingDisplayName(b)}</span>
                            </Link>
                          )
                        })
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}

          {/* v1.131 — bookings with a locationName that doesn't match any known
              room (legacy free text, admin manual edit) — surfaced instead of
              silently vanishing from a tool people use to judge "is X free". */}
          {unmatched.length > 0 && (
            <div className="pt-3 border-t border-gray-100">
              <div className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-2">
                ไม่ตรงกับห้องที่มีในระบบ ({unmatched.length})
              </div>
              <div className="space-y-1">
                {unmatched.map(b => (
                  <Link key={b.id} href={`/dashboard/${b.id}`}
                    className="flex items-center gap-2 text-xs text-gray-700 hover:bg-gray-50 rounded px-2 py-1">
                    <span className="tabular-nums text-gray-500 w-10 shrink-0">{b.callTime}</span>
                    <StatusPill status={b.status} />
                    <AdBadge category={b.category} />
                    <span className="truncate flex-1">[{b.outlet.code}] {bookingDisplayName(b)}</span>
                    <span className="text-gray-400 truncate max-w-[140px]" title={b.locationName || ''}>{b.locationName}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="pt-3 border-t border-gray-100 flex items-center gap-3 text-[10px] text-gray-500 flex-wrap">
            <span className="font-medium">สถานะ:</span>
            {['REQUESTED', 'ASSIGNED', 'CONFIRMED', 'COMPLETED'].map(s => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${statusDotClass(s)}`} /> {s}
              </span>
            ))}
            <span className="inline-flex items-center gap-1"><AdBadge category="ADVERTORIAL" /> Advertorial</span>
          </div>
        </div>
      )}
    </div>
  )
}
