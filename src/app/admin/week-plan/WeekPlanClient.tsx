'use client'

/* Week Plan — v1.198: หนึ่งแถว = **หนึ่งกอง (หนึ่งอีเวนต์ปฏิทิน)** และหัวแถวโชว์
   **Production ID ทุกตัวของกองนั้นคู่กัน** — เดิมหน้านี้ไม่แสดงเลข ID เลยสักที่

   operator 2026-08-25 (สองรอบ):
     1. "ให้แยกตามเลข Production ID ดูงาน แล้วใส่อุปกรณ์ตามไอดี"
     2. "ถ้ามี 2 ไอดีในงานเดียว ให้รวมกัน · 1 calendar 2 id เขาจะเบิกชุดเดียวกัน
        แต่ใช้ต่อเนื่อง อาจจะโชว์ ID คู่กันไปเลย"
   → การเบิกเกิด **ต่อกอง** ไม่ใช่ต่อ ID ฉะนั้นช่องอุปกรณ์มีชุดเดียวต่อกอง
   ส่วนเลข ID ทำหน้าที่บอกว่าชุดนั้นครอบคลุมงานไหนบ้าง (บอท Norbert ใช้จับคู่)

   ข้อมูลยังเก็บราย Episode อยู่ (v1.197) — PATCH ใบจอง write-through ลงทุก ID
   ให้เอง และ summarizeGearNotes ยุบข้อความที่เหมือนกันเหลือชุดเดียว */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import { ChevronLeft, ChevronRight, Loader2, Check } from 'lucide-react'
import { startOfWeek, addDays, addWeeks, format, parseISO, isSameDay } from 'date-fns'
import { bookingDisplayName } from '@/lib/display'
import CrewLine from '@/app/_components/CrewLine'
import { effectiveWrap } from '@/lib/shoot-window'
import { buildGearExportText, formatProductionIds, GearExportRow } from '@/lib/gear-notes'

type Episode = {
  id: string
  episodeId: string
  title: string
  sequence?: number
  equipmentNote?: string | null
  rentalGearNote?: string | null
  program?: { code?: string; name: string } | null
}
type Booking = {
  id: string
  equipmentNote?: string | null
  rentalGearNote?: string | null
  isBlockShot?: boolean
  assignedCrew?: { email: string; name: string; isLead?: boolean }[]
  shootDate: string
  callTime: string
  estimatedWrap?: string | null
  status: string
  cameraCount: number | null
  assignedEquipmentIds?: string[]
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  projectName?: string | null
  episodes: Episode[]
}

type NotePatch = { equipmentNote?: string; rentalGearNote?: string }
type Camera = { id: string; name: string; status: string }

/** หนึ่งแถวบนหน้าจอ = หนึ่งกอง พร้อมเลข Production ID ทุกตัวของกองนั้น */
type Row = { b: Booking; productionIds: string[] }

const TH_DAY = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']

export default function WeekPlanClient() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [bookings, setBookings] = useState<Booking[]>([])
  const [cameras, setCameras] = useState<Camera[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [exportText, setExportText] = useState<string | null>(null)
  const [filledOnly, setFilledOnly] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [viewOnly, setViewOnly] = useState(false)
  useEffect(() => { try { setViewOnly(localStorage.getItem('weekplan-view') === '1') } catch {} }, [])
  const toggleView = () => setViewOnly(v => { const n = !v; try { localStorage.setItem('weekplan-view', n ? '1' : '0') } catch {}; return n })

  // debounce ต่อกอง — หนึ่งแถวคือหนึ่งการเบิก
  const pendingRef = useRef<Record<string, NotePatch>>({})
  const timerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

  const saveBooking = useCallback(async (bookingId: string) => {
    const patch = pendingRef.current[bookingId]
    if (!patch) return
    delete pendingRef.current[bookingId]
    try {
      // PATCH ใบจอง = การเบิกหนึ่งชุดต่อหนึ่งกอง; ฝั่ง server write-through ลงทุก
      // Production ID ของกองนั้นเอง (v1.197) ข้อมูลราย ID จึงยังตรงเสมอ
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || `บันทึกไม่สำเร็จ (HTTP ${res.status})`)
      }
      setSavedId(bookingId)
      setTimeout(() => setSavedId(cur => (cur === bookingId ? null : cur)), 1500)
    } catch (e: any) {
      // คืนค่าที่ยังไม่ได้บันทึกกลับคิว เพื่อให้ครั้งหน้ายังส่งไป และบอกให้เห็น
      pendingRef.current[bookingId] = patch
      setError(e?.message || String(e))
    } finally {
      setSavingId(cur => (cur === bookingId ? null : cur))
    }
  }, [])

  const load = useCallback(async (opts: { background?: boolean } = {}) => {
    if (!opts.background) setLoading(true)
    setError('')
    try {
      Object.values(timerRef.current).forEach(clearTimeout)
      timerRef.current = {}
      await Promise.all(Object.keys(pendingRef.current).map(id => saveBooking(id)))
      const fromD = format(weekStart, 'yyyy-MM-dd')
      const toD = format(addDays(weekStart, 7), 'yyyy-MM-dd')
      const [b, c] = await Promise.all([
        fetch(`/api/bookings?status=CONFIRMED&from=${fromD}&to=${toD}&limit=200&withCrew=1`),
        fetch('/api/admin/equipment?category=CAMERA').catch(() => null),
      ])
      if (!b.ok) throw new Error(`โหลดงานไม่สำเร็จ (HTTP ${b.status})`)
      const bRes = await b.json()
      if (c && c.ok) { const cRes = await c.json().catch(() => ({})); setCameras(cRes.equipment || []) }
      // ที่ยังพิมพ์ค้างชนะข้อมูลที่โหลดมาเสมอ — background re-sync ต้องไม่ทับสิ่งที่กำลังพิมพ์
      setBookings((bRes.bookings || []).map((row: Booking) => ({ ...row, ...pendingRef.current[row.id] })))
    } catch (e: any) { setError(e?.message || String(e)) } finally { if (!opts.background) setLoading(false) }
  }, [weekStart, saveBooking])
  useEffect(() => { load() }, [load])

  const windowOf = (b: Booking) => {
    const { end, estimated } = effectiveWrap(b.callTime, b.estimatedWrap)
    return { start: b.callTime, end, estimated }
  }

  /** แถวของวันนั้น — หนึ่งกองหนึ่งแถว พร้อม Production ID ทุกตัว เรียงตามเวลาเรียกกอง */
  const rowsOn = (day: Date): Row[] =>
    bookings
      .filter(b => { const d = parseISO(b.shootDate); return !isNaN(d.getTime()) && isSameDay(d, day) })
      .sort((a, b) => (a.callTime || '').localeCompare(b.callTime || ''))
      .map(b => ({
        b,
        productionIds: (b.episodes || [])
          .slice().sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0))
          .map(e => e.episodeId).filter(Boolean),
      }))

  const editNote = (r: Row, field: keyof NotePatch, value: string) => {
    setBookings(prev => prev.map(x => x.id === r.b.id ? { ...x, [field]: value } : x))
    setSavingId(r.b.id)
    pendingRef.current[r.b.id] = { ...pendingRef.current[r.b.id], [field]: value }
    if (timerRef.current[r.b.id]) clearTimeout(timerRef.current[r.b.id])
    timerRef.current[r.b.id] = setTimeout(() => saveBooking(r.b.id), 700)
  }

  // flush ที่ค้างเมื่อปิดแท็บ — เดิมงานที่พิมพ์ค้าง 700ms สุดท้ายหายไปเงียบ ๆ
  useEffect(() => () => { Object.values(timerRef.current).forEach(clearTimeout) }, [])

  const weekLabel = `${format(weekStart, 'd MMM')} – ${format(addDays(weekStart, 6), 'd MMM yyyy')}`

  // ประกอบจากตัวช่วยชุดเดียวกับที่เรนเดอร์บนจอ — ข้อความที่ส่งกับที่เห็นจะไม่มีทางไม่ตรงกัน
  const buildText = (onlyFilled: boolean) => buildGearExportText({
    heading: `📅 อุปกรณ์ราย Production ID · ${weekLabel}`,
    filledOnly: onlyFilled,
    rows: days.flatMap(d => rowsOn(d).map((r): GearExportRow => {
      const w = windowOf(r.b)
      return {
        productionIds: r.productionIds,
        title: `${r.b.isBlockShot ? '🧱 ' : ''}${r.b.outlet.code} · ${bookingDisplayName(r.b)}`,
        time: `${format(d, 'd MMM')} ${w.start} → ${w.end}${w.estimated ? ' ~' : ''}`,
        crew: (r.b.assignedCrew || []).map(c => `${c.name}${c.isLead ? ' ⭐' : ''}`),
        equipment: r.b.equipmentNote,
        rental: r.b.rentalGearNote,
      }
    })),
  })

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-4">
      <BackButton fallback="/admin" label="คิวงาน" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800" />

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-medium text-gray-800">📅 Week Plan · อุปกรณ์ราย Production ID</h1>
          <p className="text-sm text-gray-500">ใส่<b>อุปกรณ์</b>และ<b>ของเช่า</b>แยกตามเลข Production ID — บันทึกอัตโนมัติ และแสดงต่อในหน้า Booking + Google Calendar</p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => { setCopied(false); setExportText('') }}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 mr-1">
            📄 Export ข้อความ
          </button>
          <button onClick={toggleView}
                  className={`px-3 py-1.5 text-sm border rounded mr-1 ${viewOnly ? 'border-[#673ab7] text-[#673ab7] bg-purple-50' : 'border-gray-300 hover:bg-gray-50'}`}>
            {viewOnly ? '✏️ กลับไปพิมพ์' : '👁 ดูสรุป'}
          </button>
          <button onClick={() => setWeekStart(w => addWeeks(w, -1))} className="p-1.5 border border-gray-300 rounded hover:bg-gray-50"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))} className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50">สัปดาห์นี้</button>
          <button onClick={() => setWeekStart(w => addWeeks(w, 1))} className="p-1.5 border border-gray-300 rounded hover:bg-gray-50"><ChevronRight className="w-4 h-4" /></button>
          <span className="ml-2 text-sm font-medium text-gray-700 tabular-nums">{weekLabel}</span>
        </div>
      </div>

      {exportText !== null && (() => {
        const text = buildText(filledOnly)
        return (
          <div className="border border-gray-200 rounded-lg bg-white p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-gray-700">📄 ข้อความราย Production ID</span>
              <label className="text-xs text-gray-600 inline-flex items-center gap-1">
                <input type="checkbox" checked={filledOnly} onChange={e => { setFilledOnly(e.target.checked); setCopied(false) }} />
                เฉพาะ ID ที่กรอกแล้ว
              </label>
              <button
                onClick={async () => {
                  try { await navigator.clipboard.writeText(text); setCopied(true) }
                  catch { setCopied(false) }
                }}
                className="px-2.5 py-1 text-xs border border-[#673ab7] text-[#673ab7] rounded hover:bg-purple-50">
                {copied ? '✓ คัดลอกแล้ว' : '📋 คัดลอก'}
              </button>
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
                download={`week-plan-${format(weekStart, 'yyyy-MM-dd')}.txt`}
                className="px-2.5 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">
                ⬇︎ .txt
              </a>
              <button onClick={() => { setExportText(null); setCopied(false) }}
                      className="ml-auto text-xs text-gray-500 hover:text-gray-800">ปิด</button>
            </div>
            <textarea readOnly value={text} onFocus={e => e.currentTarget.select()}
              className="w-full h-56 text-xs font-mono border border-gray-200 rounded p-2 bg-gray-50" />
            <p className="text-[11px] text-gray-400">แตะในกล่องเพื่อเลือกทั้งหมด — วางลงบอทได้เลย</p>
          </div>
        )
      })()}

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {loading ? (
        <div className="py-16 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
      ) : (
        <div className="space-y-3">
          {days.map(day => {
            const dayRows = rowsOn(day)
            const filled = dayRows.filter(r => (r.b.equipmentNote || '').trim() || (r.b.rentalGearNote || '').trim()).length
            return (
              <div key={day.toISOString()} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100 gap-2 flex-wrap">
                  <div className="text-sm font-medium text-gray-700">{TH_DAY[day.getDay()]} {format(day, 'd MMM')}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                    <span>{dayRows.length} งาน</span>
                    {dayRows.length > 0 && <span>· ✍️ ใส่แล้ว {filled}/{dayRows.length}</span>}
                  </div>
                </div>
                {dayRows.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-gray-400">— ไม่มีงาน Confirmed —</div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {dayRows.map(r => (
                      <div key={r.b.id} className="px-3 py-3">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="text-sm min-w-0">
                            {/* เลข Production ID ทุกตัวของกองนี้ — ชุดอุปกรณ์ชุดเดียวครอบคลุมทั้งหมด */}
                            <span className="font-mono text-[13px] font-medium text-gray-900 break-all">
                              {formatProductionIds(r.productionIds) || '(ไม่มี Production ID)'}
                            </span>
                            {r.productionIds.length > 1 && (
                              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
                                    title="กองเดียวกัน ถ่ายต่อเนื่อง เบิกอุปกรณ์ชุดเดียว">
                                {r.productionIds.length} ID · เบิกชุดเดียว
                              </span>
                            )}
                            <div className="text-xs text-gray-600 mt-0.5">
                              <Link href={`/admin/${r.b.id}`} className="text-[#673ab7] hover:underline">
                                {r.b.isBlockShot ? '🧱 ' : ''}{r.b.outlet.code} · {bookingDisplayName(r.b)}
                              </Link>
                              {(() => { const w = windowOf(r.b); return (
                                <span className="text-gray-500 ml-2 tabular-nums" title={w.estimated ? 'เวลาเลิกกองโดยประมาณ (ไม่ได้กรอก) — call + 8 ชม.' : 'call → เวลาเลิกกอง'}>
                                  🕐 {w.start} → {w.end}{w.estimated ? ' ~' : ''}
                                </span>
                              )})()}
                              {(r.b.cameraCount ?? 0) > 0 && <span className="text-gray-400 ml-2">🎥 {r.b.cameraCount}</span>}
                            </div>
                            {/* ครูอยู่ระดับใบจอง — โชว์ที่แถวแรกของใบพอ ไม่ต้องซ้ำทุก ID */}
                            <CrewLine crew={r.b.assignedCrew} className="text-[11px] text-gray-500 mt-0.5" />
                            {(r.b.assignedEquipmentIds || []).length > 0 && cameras.length > 0 && (
                              <div className="text-[11px] text-gray-400 mt-0.5">
                                📷 จัดไว้เดิม: {(r.b.assignedEquipmentIds || []).map(id => cameras.find(c => c.id === id)?.name).filter(Boolean).join(', ') || '—'}
                              </div>
                            )}
                          </div>
                          <div className="text-xs flex items-center gap-2">
                            {savingId === r.b.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
                            {savedId === r.b.id && <Check className="w-3.5 h-3.5 text-green-600" />}
                          </div>
                        </div>
                        {viewOnly ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mt-1.5">
                            <div className="text-sm text-gray-800 whitespace-pre-line leading-snug">
                              <span className="text-[11px] text-gray-400 mr-1">🎬</span>
                              {r.b.equipmentNote?.trim() || <span className="text-gray-300">—</span>}
                            </div>
                            <div className="text-sm text-gray-800 whitespace-pre-line leading-snug">
                              <span className="text-[11px] text-gray-400 mr-1">📦</span>
                              {r.b.rentalGearNote?.trim() || <span className="text-gray-300">—</span>}
                            </div>
                          </div>
                        ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                          <div>
                            <label className="text-[11px] text-gray-400 mb-0.5 block">🎬 อุปกรณ์</label>
                            <textarea
                              value={r.b.equipmentNote || ''}
                              onChange={e => editNote(r, 'equipmentNote', e.target.value)}
                              rows={2}
                              placeholder="เช่น FX3 x2 · ขาตั้ง · ไฟ 2 ดวง…"
                              className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 outline-none focus:border-[#673ab7] resize-y" />
                          </div>
                          <div>
                            <label className="text-[11px] text-gray-400 mb-0.5 block">📦 เช่า</label>
                            <textarea
                              value={r.b.rentalGearNote || ''}
                              onChange={e => editNote(r, 'rentalGearNote', e.target.value)}
                              rows={2}
                              placeholder="เช่น เช่าเลนส์ 24-70 · จอมอนิเตอร์…"
                              className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 outline-none focus:border-[#673ab7] resize-y" />
                          </div>
                        </div>
                        )}
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
