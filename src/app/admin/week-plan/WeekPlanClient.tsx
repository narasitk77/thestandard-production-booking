'use client'

/* Week Plan — v1.144: ops asked to switch this page from the camera-chip
   allocator to TWO free-text fields per shoot — อุปกรณ์ (equipmentNote) and
   เช่า (rentalGearNote) — "ใส่ข้อความก่อน ปรับกันทีหลัง". The chip-based
   per-unit allocator (+ auto-assign + time-clash detection) lived here until
   v1.143 (see git history) and can come back refined later; the underlying
   Booking.assignedEquipmentIds data is untouched. Both note fields flow into
   the Google Calendar event description via the PATCH's background re-sync. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import { ChevronLeft, ChevronRight, Loader2, Check } from 'lucide-react'
import { startOfWeek, addDays, addWeeks, format, parseISO, isSameDay } from 'date-fns'
import { bookingDisplayName } from '@/lib/display'
import CrewLine from '@/app/_components/CrewLine'
import { effectiveWrap } from '@/lib/shoot-window'

type Episode = { episodeId: string; title: string; program?: { code?: string; name: string } | null }
type Booking = {
  id: string
  isBlockShot?: boolean
  assignedCrew?: { email: string; name: string; isLead?: boolean }[]
  shootDate: string
  callTime: string
  estimatedWrap?: string | null
  status: string
  cameraCount: number | null
  assignedEquipmentIds?: string[]
  equipmentNote?: string | null
  rentalGearNote?: string | null
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  projectName?: string | null
  episodes: Episode[]
}

type NotePatch = { equipmentNote?: string; rentalGearNote?: string }
type Camera = { id: string; name: string; status: string }

const TH_DAY = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']

export default function WeekPlanClient() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [bookings, setBookings] = useState<Booking[]>([])
  const [cameras, setCameras] = useState<Camera[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  // Debounce the save per booking: each PATCH re-syncs the Google Calendar event
  // (fire-and-forget, server-side), so collapse rapid keystrokes into one call.
  const pendingRef = useRef<Record<string, NotePatch>>({})
  const timerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

  const load = useCallback(async (opts: { background?: boolean } = {}) => {
    // background=true → re-sync without unmounting the textareas (a full-page
    // spinner mid-typing would eat focus + drop the caret).
    if (!opts.background) setLoading(true)
    setError('')
    try {
      // Flush queued edits first: switching weeks swaps the rows out, and an
      // un-flushed debounce would otherwise fire against unmounted state.
      Object.values(timerRef.current).forEach(clearTimeout)
      timerRef.current = {}
      await Promise.all(Object.keys(pendingRef.current).map(id => saveBooking(id)))
      // Fetch ONLY the visible week (half-open [from, to)) so the planner is
      // correct for any week regardless of total CONFIRMED count.
      const fromD = format(weekStart, 'yyyy-MM-dd')
      const toD = format(addDays(weekStart, 7), 'yyyy-MM-dd')
      const [b, c] = await Promise.all([
        fetch(`/api/bookings?status=CONFIRMED&from=${fromD}&to=${toD}&limit=200&withCrew=1`),
        // read-only: names for legacy per-unit camera assignments (see chips below)
        fetch('/api/admin/equipment?category=CAMERA').catch(() => null),
      ])
      if (!b.ok) throw new Error(`โหลดงานไม่สำเร็จ (HTTP ${b.status})`)
      const bRes = await b.json()
      if (c && c.ok) { const cRes = await c.json().catch(() => ({})); setCameras(cRes.equipment || []) }
      // Unsaved edits win over fetched data — a background re-sync (or a save
      // failure elsewhere) must never clobber what the user is typing.
      setBookings((bRes.bookings || []).map((row: Booking) => ({ ...row, ...pendingRef.current[row.id] })))
    } catch (e: any) { setError(e?.message || String(e)) } finally { if (!opts.background) setLoading(false) }
  }, [weekStart])
  useEffect(() => { load() }, [load])

  // bookings on a given day (by shootDate), earliest call time first
  const bookingsOn = (day: Date) =>
    bookings
      .filter(b => { const d = parseISO(b.shootDate); return !isNaN(d.getTime()) && isSameDay(d, day) })
      .sort((a, b) => (a.callTime || '').localeCompare(b.callTime || ''))

  // v1.118 — the shoot's time window "09:00 → 18:00" (wrap computed when blank).
  const windowOf = (b: Booking) => {
    const { end, estimated } = effectiveWrap(b.callTime, b.estimatedWrap)
    return { start: b.callTime, end, estimated }
  }

  const editNote = (b: Booking, field: keyof NotePatch, value: string) => {
    // optimistic update + remember the latest target for the debounced save
    setBookings(prev => prev.map(x => x.id === b.id ? { ...x, [field]: value } : x))
    setSavingId(b.id)
    pendingRef.current[b.id] = { ...pendingRef.current[b.id], [field]: value }
    if (timerRef.current[b.id]) clearTimeout(timerRef.current[b.id])
    timerRef.current[b.id] = setTimeout(() => saveBooking(b.id), 700)
  }

  const saveBooking = async (bookingId: string) => {
    const patch = pendingRef.current[bookingId]
    if (!patch) return
    delete pendingRef.current[bookingId]
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setSavedId(bookingId); setTimeout(() => setSavedId(s => s === bookingId ? null : s), 1500)
    } catch (e: any) {
      // Free text is precious: put the failed patch BACK (newer keystrokes win)
      // and retry — never blanket-reload, which would eat in-progress typing.
      pendingRef.current[bookingId] = { ...patch, ...pendingRef.current[bookingId] }
      setError(`บันทึกไม่สำเร็จ (${e?.message || e}) — จะลองใหม่อัตโนมัติ`)
      if (timerRef.current[bookingId]) clearTimeout(timerRef.current[bookingId])
      timerRef.current[bookingId] = setTimeout(() => saveBooking(bookingId), 3000)
    } finally { setSavingId(s => s === bookingId ? null : s) }
  }

  // flush pending saves on unmount so a quick navigate-away doesn't lose typing
  useEffect(() => () => { Object.keys(pendingRef.current).forEach(saveBooking) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ...and on hard unload (reload / tab close) — React cleanup doesn't run
  // there, and a non-keepalive fetch would be aborted mid-flight.
  useEffect(() => {
    const flush = () => {
      for (const [id, patch] of Object.entries(pendingRef.current)) {
        try { fetch(`/api/bookings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), keepalive: true }) } catch {}
      }
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  const weekLabel = `${format(weekStart, 'd MMM')} – ${format(addDays(weekStart, 6), 'd MMM yyyy')}`

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4">
      <BackButton fallback="/admin" label="คิวงาน" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800" />

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-medium text-gray-800">📅 Week Plan · อุปกรณ์ / เช่า</h1>
          <p className="text-sm text-gray-500">พิมพ์รายการ<b>อุปกรณ์</b>และ<b>ของเช่า</b>ของแต่ละงาน — บันทึกอัตโนมัติ และแสดงต่อในหน้า Booking + Google Calendar</p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setWeekStart(w => addWeeks(w, -1))} className="p-1.5 border border-gray-300 rounded hover:bg-gray-50"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">สัปดาห์นี้</button>
          <button onClick={() => setWeekStart(w => addWeeks(w, 1))} className="p-1.5 border border-gray-300 rounded hover:bg-gray-50"><ChevronRight className="w-4 h-4" /></button>
          <span className="ml-2 text-sm font-medium text-gray-700 tabular-nums">{weekLabel}</span>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {loading ? (
        <div className="py-16 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
      ) : (
        <div className="space-y-3">
          {days.map(day => {
            const dayBookings = bookingsOn(day)
            const filled = dayBookings.filter(b => (b.equipmentNote || '').trim() || (b.rentalGearNote || '').trim()).length
            return (
              <div key={day.toISOString()} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100 gap-2 flex-wrap">
                  <div className="text-sm font-medium text-gray-700">{TH_DAY[day.getDay()]} {format(day, 'd MMM')}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                    <span>{dayBookings.length} งาน</span>
                    {dayBookings.length > 0 && <span>· ✍️ ใส่แล้ว {filled}/{dayBookings.length}</span>}
                  </div>
                </div>
                {dayBookings.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-gray-400">— ไม่มีงาน Confirmed —</div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {dayBookings.map(b => (
                      <div key={b.id} className="px-3 py-3">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="text-sm">
                            <Link href={`/admin/${b.id}`} className="text-[#673ab7] hover:underline font-medium">{b.isBlockShot ? '🧱 ' : ''}{b.outlet.code} · {bookingDisplayName(b)}</Link>
                            {(() => { const w = windowOf(b); return (
                              <span className="text-gray-500 ml-2 text-xs tabular-nums" title={w.estimated ? 'เวลาเลิกกองโดยประมาณ (ไม่ได้กรอก) — call + 8 ชม.' : 'call → เวลาเลิกกอง'}>
                                🕐 {w.start} → {w.end}{w.estimated ? ' ~' : ''}
                              </span>
                            )})()}
                            {(b.cameraCount ?? 0) > 0 && <span className="text-gray-400 ml-2 text-xs">🎥 {b.cameraCount}</span>}
                            <CrewLine crew={b.assignedCrew} className="text-[11px] text-gray-500 mt-0.5" />
                            {/* legacy per-unit camera assignments (from the old
                                allocator) stay VISIBLE read-only — data kept. */}
                            {(b.assignedEquipmentIds || []).length > 0 && cameras.length > 0 && (
                              <div className="text-[11px] text-gray-400 mt-0.5">
                                📷 จัดไว้เดิม: {(b.assignedEquipmentIds || []).map(id => cameras.find(c => c.id === id)?.name).filter(Boolean).join(', ') || '—'}
                              </div>
                            )}
                          </div>
                          <div className="text-xs flex items-center gap-2">
                            {savingId === b.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
                            {savedId === b.id && <Check className="w-3.5 h-3.5 text-green-600" />}
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                          <div>
                            <label className="text-[11px] text-gray-400 mb-0.5 block">🎬 อุปกรณ์</label>
                            <textarea
                              value={b.equipmentNote || ''}
                              onChange={e => editNote(b, 'equipmentNote', e.target.value)}
                              rows={2}
                              placeholder="เช่น FX3 x2 · ขาตั้ง · ไฟ 2 ดวง…"
                              className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 outline-none focus:border-[#673ab7] resize-y" />
                          </div>
                          <div>
                            <label className="text-[11px] text-gray-400 mb-0.5 block">📦 เช่า</label>
                            <textarea
                              value={b.rentalGearNote || ''}
                              onChange={e => editNote(b, 'rentalGearNote', e.target.value)}
                              rows={2}
                              placeholder="เช่น เช่าเลนส์ 24-70 · จอมอนิเตอร์…"
                              className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 outline-none focus:border-[#673ab7] resize-y" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
