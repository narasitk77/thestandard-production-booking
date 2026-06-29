'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, Check } from 'lucide-react'
import { startOfWeek, addDays, addWeeks, format, parseISO, isSameDay } from 'date-fns'
import { bookingShowName } from '@/lib/display'

type Camera = { id: string; name: string; serialNumber: string | null; status: string }
type Episode = { episodeId: string; title: string; program?: { code?: string; name: string } | null }
type Booking = {
  id: string
  shootDate: string
  callTime: string
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
        fetch(`/api/bookings?status=CONFIRMED&from=${fromD}&to=${toD}&limit=200`),
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

  // bookings on a given day (by shootDate)
  const bookingsOn = (day: Date) => bookings.filter(b => { const d = parseISO(b.shootDate); return !isNaN(d.getTime()) && isSameDay(d, day) })

  // camera id → how many of THIS day's bookings hold it (>1 = double-booked)
  const conflictMap = (day: Date) => {
    const m = new Map<string, number>()
    for (const b of bookingsOn(day)) for (const id of (b.assignedEquipmentIds || [])) if (cameraIds.has(id)) m.set(id, (m.get(id) || 0) + 1)
    return m
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
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="w-4 h-4" /> คิวงาน
      </Link>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-medium text-gray-800">📅 Week Plan · จัดสรรกล้อง</h1>
          <p className="text-sm text-gray-500">เลือกกล้องให้งานที่ Confirmed แล้ว — กล้องที่ชนกันในวันเดียวจะขึ้นสีแดง</p>
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
            const conflicts = conflictMap(day)
            const needed = dayBookings.reduce((s, b) => s + (b.cameraCount || 0), 0)
            const allocated = dayBookings.reduce((s, b) => s + (b.assignedEquipmentIds || []).filter(id => cameraIds.has(id)).length, 0)
            const hasConflict = Array.from(conflicts.values()).some(n => n > 1)
            return (
              <div key={day.toISOString()} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
                  <div className="text-sm font-medium text-gray-700">{TH_DAY[day.getDay()]} {format(day, 'd MMM')}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2">
                    <span>{dayBookings.length} งาน</span>
                    {needed > 0 && <span>· 📷 จัดแล้ว {allocated}/{needed}</span>}
                    {hasConflict && <span className="text-red-600 font-medium">· ⚠️ กล้องชนกัน</span>}
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
                              <Link href={`/admin/${b.id}`} className="text-[#673ab7] hover:underline font-medium">{b.outlet.code} · {bookingShowName(b)}</Link>
                              <span className="text-gray-500 ml-2 text-xs">{b.callTime}</span>
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
                              const conflict = on && (conflicts.get(c.id) || 0) > 1
                              return (
                                <button key={c.id} onClick={() => toggleCamera(b, c.id)} disabled={savingId === b.id}
                                  title={c.serialNumber || c.name}
                                  className={`text-[11px] px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
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
