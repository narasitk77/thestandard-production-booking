'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import { ChevronLeft, ChevronRight, Loader2, Check } from 'lucide-react'
import { startOfWeek, addDays, addWeeks, format, parseISO, isSameDay } from 'date-fns'
import { bookingDisplayName } from '@/lib/display'
import CrewLine from '@/app/_components/CrewLine'
import { effectiveWrap, timeWindowsOverlap } from '@/lib/shoot-window'

type Camera = { id: string; name: string; serialNumber: string | null; status: string }
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
  assignedEquipmentIds: string[]
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  projectName?: string | null
  episodes: Episode[]
}

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
  // (fire-and-forget, server-side), so collapse rapid camera toggles into one call.
  const pendingRef = useRef<Record<string, string[]>>({})
  const timerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const cameraIds = useMemo(() => new Set(cameras.map(c => c.id)), [cameras])
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      // Fetch ONLY the visible week (half-open [from, to)) so the planner is correct
      // for any week regardless of total CONFIRMED count, and conflict detection
      // (always same-day, within the week) sees every holder.
      const fromD = format(weekStart, 'yyyy-MM-dd')
      const toD = format(addDays(weekStart, 7), 'yyyy-MM-dd')
      const [b, c] = await Promise.all([
        fetch(`/api/bookings?status=CONFIRMED&from=${fromD}&to=${toD}&limit=200&withCrew=1`),
        fetch('/api/admin/equipment?category=CAMERA'),
      ])
      if (!b.ok) throw new Error(`โหลดงานไม่สำเร็จ (HTTP ${b.status})`)
      if (!c.ok) throw new Error(`โหลดรายการกล้องไม่สำเร็จ (HTTP ${c.status})`)
      const bRes = await b.json(); const cRes = await c.json()
      setBookings(bRes.bookings || [])
      // hide retired/disposed units from the allocation picker
      setCameras((cRes.equipment || []).filter((e: Camera) => e.status !== 'RETIRED'))
    } catch (e: any) { setError(e?.message || String(e)) } finally { setLoading(false) }
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
  const overlaps = (a: Booking, b: Booking) => {
    // v1.121 — a booking with no call time has an unknowable window, so we can't
    // prove two same-day holders DON'T overlap → flag it (conservative), matching
    // the pre-v1.118 same-day clash. Only skip the red flag when both times exist.
    if (!a.callTime || !b.callTime) return true
    const wa = windowOf(a), wb = windowOf(b)
    return timeWindowsOverlap(wa.start, wa.end, wb.start, wb.end)
  }
  const camsOf = (b: Booking) => (b.assignedEquipmentIds || []).filter(id => cameraIds.has(id))

  // v1.118 — a camera is a CLASH for a booking only when another booking on the
  // same day holds the SAME unit AND their time windows overlap (not just same
  // day). Returns the set of "<bookingId>|<camId>" pairs that clash.
  const clashPairs = (day: Date): Set<string> => {
    const dayB = bookingsOn(day)
    const holders = new Map<string, Booking[]>()
    for (const b of dayB) for (const id of camsOf(b)) (holders.get(id) ?? holders.set(id, []).get(id)!).push(b)
    const out = new Set<string>()
    for (const [camId, hs] of Array.from(holders.entries())) {
      for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
        if (overlaps(hs[i], hs[j])) { out.add(`${hs[i].id}|${camId}`); out.add(`${hs[j].id}|${camId}`) }
      }
    }
    return out
  }

  // v1.118 — one-click "fill every under-allocated shoot with cameras that are
  // FREE during its window". Additive (keeps what's already assigned); reuses a
  // unit across non-overlapping shoots. Zero clashes by construction.
  const autoAssignDay = async (day: Date) => {
    const dayB = bookingsOn(day) // earliest first
    // occupancy: camId → windows already taken today (from current assignments)
    const occ = new Map<string, Array<{ start: string; end: string }>>()
    for (const b of dayB) { const w = windowOf(b); for (const id of camsOf(b)) (occ.get(id) ?? occ.set(id, []).get(id)!).push(w) }
    // v1.121 — auto-assign ONLY units that are physically AVAILABLE (a bulk,
    // no-look commit must not hand out a camera that's ON_LOAN or IN_REPAIR;
    // manual per-unit toggling still allows the whole non-retired set on purpose).
    const assignable = cameras.filter(c => c.status === 'AVAILABLE')
    const patches: Array<{ b: Booking; add: string[] }> = []
    for (const b of dayB) {
      // no call time = unknowable window → don't auto-place (needs manual).
      if (!b.callTime) continue
      const need = (b.cameraCount || 0) - camsOf(b).length
      if (need <= 0) continue
      const w = windowOf(b)
      const add: string[] = []
      for (const c of assignable) {
        if (add.length >= need) break
        if (camsOf(b).includes(c.id)) continue
        const busy = (occ.get(c.id) || []).some(x => timeWindowsOverlap(w.start, w.end, x.start, x.end))
        if (!busy) { add.push(c.id); (occ.get(c.id) ?? occ.set(c.id, []).get(c.id)!).push(w) }
      }
      if (add.length) patches.push({ b, add })
    }
    if (!patches.length) return
    // optimistic UI + one debounced save per booking (reuse the existing path)
    for (const { b, add } of patches) {
      const next = [...(b.assignedEquipmentIds || []), ...add]
      setBookings(prev => prev.map(x => x.id === b.id ? { ...x, assignedEquipmentIds: next } : x))
      pendingRef.current[b.id] = next
      setSavingId(b.id)
      saveBooking(b.id)
    }
  }

  const toggleCamera = (b: Booking, camId: string) => {
    const has = (b.assignedEquipmentIds || []).includes(camId)
    // preserve non-camera equipment; only flip the camera id
    const nonCamera = (b.assignedEquipmentIds || []).filter(id => !cameraIds.has(id))
    const cams = (b.assignedEquipmentIds || []).filter(id => cameraIds.has(id))
    const nextCams = has ? cams.filter(id => id !== camId) : [...cams, camId]
    const next = [...nonCamera, ...nextCams]
    // optimistic update + remember the latest target for the debounced save
    setBookings(prev => prev.map(x => x.id === b.id ? { ...x, assignedEquipmentIds: next } : x))
    setSavingId(b.id)
    pendingRef.current[b.id] = next
    if (timerRef.current[b.id]) clearTimeout(timerRef.current[b.id])
    timerRef.current[b.id] = setTimeout(() => saveBooking(b.id), 700)
  }

  const saveBooking = async (bookingId: string) => {
    const next = pendingRef.current[bookingId]
    if (!next) return
    delete pendingRef.current[bookingId]
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignedEquipmentIds: next }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setSavedId(bookingId); setTimeout(() => setSavedId(s => s === bookingId ? null : s), 1500)
    } catch (e: any) {
      setError(e?.message || String(e))
      load() // re-sync on failure
    } finally { setSavingId(s => s === bookingId ? null : s) }
  }

  // flush pending saves on unmount so a quick navigate-away doesn't lose a toggle
  useEffect(() => () => { Object.keys(pendingRef.current).forEach(saveBooking) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const weekLabel = `${format(weekStart, 'd MMM')} – ${format(addDays(weekStart, 6), 'd MMM yyyy')}`

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4">
      <BackButton fallback="/admin" label="คิวงาน" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800" />

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-medium text-gray-800">📅 Week Plan · จัดสรรกล้อง</h1>
          <p className="text-sm text-gray-500">กด <b>⚡ จัดกล้องอัตโนมัติ</b> ให้ระบบเลือกกล้องให้ทั้งวัน · กล้องจะแดงเมื่อ<b>ชนเวลากันจริง</b> (คนละเวลาใช้ตัวเดียวกันได้)</p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setWeekStart(w => addWeeks(w, -1))} className="p-1.5 border border-gray-300 rounded hover:bg-gray-50"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">สัปดาห์นี้</button>
          <button onClick={() => setWeekStart(w => addWeeks(w, 1))} className="p-1.5 border border-gray-300 rounded hover:bg-gray-50"><ChevronRight className="w-4 h-4" /></button>
          <span className="ml-2 text-sm font-medium text-gray-700 tabular-nums">{weekLabel}</span>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      {cameras.length === 0 && !loading && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          ยังไม่มีกล้องในคลัง (Equipment category = CAMERA) — เพิ่มที่ <Link href="/admin/equipment" className="underline">Equipment</Link> ก่อน
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
      ) : (
        <div className="space-y-3">
          {days.map(day => {
            const dayBookings = bookingsOn(day)
            const clashes = clashPairs(day)
            const needed = dayBookings.reduce((s, b) => s + (b.cameraCount || 0), 0)
            const allocated = dayBookings.reduce((s, b) => s + camsOf(b).length, 0)
            const hasConflict = clashes.size > 0
            // fully allocated = every booking has all the cameras it needs
            const fullyDone = dayBookings.length > 0 && dayBookings.every(b => camsOf(b).length >= (b.cameraCount || 0))
            return (
              <div key={day.toISOString()} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100 gap-2 flex-wrap">
                  <div className="text-sm font-medium text-gray-700">{TH_DAY[day.getDay()]} {format(day, 'd MMM')}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                    <span>{dayBookings.length} งาน</span>
                    {needed > 0 && <span>· 📷 จัดแล้ว {allocated}/{needed}</span>}
                    {hasConflict && <span className="text-red-600 font-medium">· ⚠️ กล้องชนเวลากัน</span>}
                    {needed > 0 && !fullyDone && (
                      <button
                        onClick={() => autoAssignDay(day)}
                        className="ml-1 px-2 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-medium">
                        ⚡ จัดกล้องอัตโนมัติ
                      </button>
                    )}
                    {fullyDone && !hasConflict && <span className="text-green-600 font-medium">· ✓ จัดครบ</span>}
                  </div>
                </div>
                {dayBookings.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-gray-400">— ไม่มีงาน Confirmed —</div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {dayBookings.map(b => {
                      const assigned = new Set((b.assignedEquipmentIds || []).filter(id => cameraIds.has(id)))
                      return (
                        <div key={b.id} className="px-3 py-3">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="text-sm">
                              <Link href={`/admin/${b.id}`} className="text-[#673ab7] hover:underline font-medium">{b.isBlockShot ? '🧱 ' : ''}{b.outlet.code} · {bookingDisplayName(b)}</Link>
                              {(() => { const w = windowOf(b); return (
                                <span className="text-gray-500 ml-2 text-xs tabular-nums" title={w.estimated ? 'เวลาเลิกกองโดยประมาณ (ไม่ได้กรอก) — call + 8 ชม.' : 'call → เวลาเลิกกอง'}>
                                  🕐 {w.start} → {w.end}{w.estimated ? ' ~' : ''}
                                </span>
                              )})()}
                              <CrewLine crew={b.assignedCrew} className="text-[11px] text-gray-500 mt-0.5" />
                            </div>
                            <div className="text-xs flex items-center gap-2">
                              <span className={assigned.size >= (b.cameraCount || 0) ? 'text-green-700' : 'text-amber-700'}>
                                กล้อง {assigned.size}/{b.cameraCount ?? '—'}
                              </span>
                              {savingId === b.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
                              {savedId === b.id && <Check className="w-3.5 h-3.5 text-green-600" />}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {cameras.map(c => {
                              const on = assigned.has(c.id)
                              // v1.118 — red only when THIS unit clashes IN TIME with another booking.
                              const conflict = on && clashes.has(`${b.id}|${c.id}`)
                              // No disable during the 700ms debounce — rapid toggles must collapse
                              // into one PATCH (the optimistic update + reschedule keep it consistent).
                              return (
                                <button key={c.id} onClick={() => toggleCamera(b, c.id)}
                                  title={c.serialNumber || c.name}
                                  className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                                    conflict ? 'bg-red-100 border-red-400 text-red-800'
                                    : on ? 'bg-[#673ab7] border-[#673ab7] text-white'
                                    : 'bg-white border-gray-300 text-gray-600 hover:border-[#673ab7]'}`}>
                                  {c.name}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
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
