'use client'

/* =============================================================================
   /admin/routine — v1.56.0
   Routine planner: bulk-generate recurring weekday bookings for daily shows
   (e.g. THE STANDARD NOW, Mon–Fri). Skips weekends, Thai holidays, and any
   custom dates. Live preview before generating; manage existing routine groups.
   ============================================================================= */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, CalendarPlus, X, Trash2, Check, AlertTriangle } from 'lucide-react'
import { OUTLETS, OUTLET_MAP } from '@/lib/data'
import { generateRoutineDates } from '@/lib/routine'

const WEEKDAYS = [
  { n: 1, label: 'จ' }, { n: 2, label: 'อ' }, { n: 3, label: 'พ' },
  { n: 4, label: 'พฤ' }, { n: 5, label: 'ศ' }, { n: 6, label: 'ส' }, { n: 0, label: 'อา' },
]
const SHOOT_TYPES = [
  { value: 'STUDIO', label: 'Studio' },
  { value: 'ON_LOCATION', label: 'On Location' },
  { value: 'REMOTE_ONLINE', label: 'Remote / Online' },
  { value: 'EVENT', label: 'Event' },
]
const CATEGORIES = [
  { value: 'ORIGINAL_CONTENT', label: 'Original Content' },
  { value: 'ADVERTORIAL', label: 'Advertorial' },
  { value: 'EVENT', label: 'Event' },
  { value: 'INTERNAL', label: 'Internal' },
]
const CREW = ['Videographer', 'Sound', 'Photographer', 'Switcher', 'DIT', 'Lighting']

type Group = {
  routineGroupId: string; outlet: string; program: string
  count: number; from: string; to: string; statuses: Record<string, number>
}

export default function RoutinePlannerPage() {
  // form state
  const [outletCode, setOutletCode] = useState('NWS')
  const [programCode, setProgramCode] = useState('TSN')
  const [episodeTitle, setEpisodeTitle] = useState('THE STANDARD NOW')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5])
  const [skipHolidays, setSkipHolidays] = useState(true)
  const [customSkip, setCustomSkip] = useState<string[]>([])
  const [customSkipInput, setCustomSkipInput] = useState('')
  const [shootType, setShootType] = useState('STUDIO')
  const [category, setCategory] = useState('ORIGINAL_CONTENT')
  const [callTime, setCallTime] = useState('10:00')
  const [estimatedWrap, setEstimatedWrap] = useState('')
  const [locationName, setLocationName] = useState('')
  const [producer, setProducer] = useState('')
  const [crewRequired, setCrewRequired] = useState<string[]>(['Videographer', 'Sound'])
  const [cameraCount, setCameraCount] = useState('')
  const [micCount, setMicCount] = useState('')
  const [notes, setNotes] = useState('')

  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<{ created: number; duplicatesSkipped?: number; failed: { date: string; error: string }[] } | null>(null)
  const [error, setError] = useState('')

  // existing groups
  const [groups, setGroups] = useState<Group[]>([])
  const [groupsLoading, setGroupsLoading] = useState(true)

  const programs = OUTLET_MAP[outletCode]?.programs || []

  const loadGroups = () => {
    setGroupsLoading(true)
    fetch('/api/admin/routine', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { groups: [] })
      .then(d => setGroups(d.groups || []))
      .catch(() => {})
      .finally(() => setGroupsLoading(false))
  }
  useEffect(loadGroups, [])

  // when outlet changes, keep program valid
  useEffect(() => {
    if (!programs.find(p => p.code === programCode)) {
      setProgramCode(programs[0]?.code || '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletCode])

  const preview = useMemo(() => {
    if (!startDate || !endDate) return null
    return generateRoutineDates({ startDate, endDate, weekdays, skipHolidays, customSkip })
  }, [startDate, endDate, weekdays, skipHolidays, customSkip])

  const toggleWeekday = (n: number) =>
    setWeekdays(w => w.includes(n) ? w.filter(x => x !== n) : [...w, n].sort())
  const toggleCrew = (c: string) =>
    setCrewRequired(cr => cr.includes(c) ? cr.filter(x => x !== c) : [...cr, c])
  const addCustomSkip = () => {
    const d = customSkipInput.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !customSkip.includes(d)) {
      setCustomSkip(s => [...s, d].sort())
      setCustomSkipInput('')
    }
  }

  const canGenerate = !!preview && !preview.error && preview.dates.length > 0 && !!producer.trim() && !!episodeTitle.trim()

  const generate = async () => {
    if (!canGenerate || !preview) return
    if (!confirm(`สร้าง ${preview.dates.length} booking (REQUESTED) สำหรับ ${programCode}?\nวันแรก ${preview.dates[0]} · วันสุดท้าย ${preview.dates[preview.dates.length - 1]}`)) return
    setGenerating(true); setError(''); setResult(null)
    try {
      const res = await fetch('/api/admin/routine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          outletCode, programCode, episodeTitle, category, shootType,
          callTime, estimatedWrap, locationName, producer,
          crewRequired, cameraCount, micCount, notes,
          plan: { startDate, endDate, weekdays, skipHolidays, customSkip },
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setResult({ created: d.created, duplicatesSkipped: d.duplicatesSkipped || 0, failed: d.failed || [] })
      loadGroups()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setGenerating(false)
    }
  }

  const cancelGroup = async (g: Group) => {
    if (!confirm(`ลบงาน Routine ทั้งชุดนี้? (${g.program} · ${g.count} ใบ · ${g.from} – ${g.to})\nงานจะถูกซ่อน (soft-delete) กู้คืนได้จากแท็บ Deleted`)) return
    try {
      const res = await fetch('/api/admin/routine', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', routineGroupId: g.routineGroupId }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      loadGroups()
    } catch (e: any) {
      alert('ลบไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      <div className="mb-4">
        <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Routine Planner</h1>
        <p className="text-xs sm:text-sm text-gray-500 mt-0.5">
          สร้างคิวถ่ายซ้ำรายสัปดาห์สำหรับรายการ daily (เช่น THE STANDARD NOW จ–ศ) — ข้ามเสาร์-อาทิตย์ วันหยุด และวันที่กำหนดเอง
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Form ── */}
        <div className="space-y-3">
          <div className="ops-card ops-card-pad space-y-3">
            <div className="ops-section-title">รายการ</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="ops-label">Outlet</label>
                <select className="ops-input" value={outletCode} onChange={e => setOutletCode(e.target.value)}>
                  {OUTLETS.map(o => <option key={o.code} value={o.code}>{o.code} · {o.name}</option>)}
                </select>
              </div>
              <div>
                <label className="ops-label">Program</label>
                <select className="ops-input" value={programCode} onChange={e => setProgramCode(e.target.value)}>
                  {programs.map(p => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="ops-label">ชื่อตอน (Episode title)</label>
              <input className="ops-input" value={episodeTitle} onChange={e => setEpisodeTitle(e.target.value)}
                placeholder="เช่น THE STANDARD NOW" />
            </div>
          </div>

          <div className="ops-card ops-card-pad space-y-3">
            <div className="ops-section-title">ช่วงวันและรอบ</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="ops-label">วันเริ่ม</label>
                <input type="date" className="ops-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
              </div>
              <div>
                <label className="ops-label">วันสิ้นสุด</label>
                <input type="date" className="ops-input" value={endDate} onChange={e => setEndDate(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="ops-label">วันในสัปดาห์</label>
              <div className="flex gap-1">
                {WEEKDAYS.map(d => (
                  <button key={d.n} type="button" onClick={() => toggleWeekday(d.n)}
                    className={`w-9 h-9 rounded text-xs font-medium border transition-colors ${
                      weekdays.includes(d.n) ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'bg-white text-gray-500 border-gray-200 hover:border-[#673ab7]'
                    }`}>{d.label}</button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={skipHolidays} onChange={e => setSkipHolidays(e.target.checked)} />
              ข้ามวันหยุดราชการไทย
            </label>
            <div>
              <label className="ops-label">ข้ามวันที่กำหนดเอง</label>
              <div className="flex gap-1">
                <input type="date" className="ops-input flex-1" value={customSkipInput} onChange={e => setCustomSkipInput(e.target.value)} />
                <button type="button" onClick={addCustomSkip} className="ops-btn ops-btn-secondary ops-btn-sm">เพิ่ม</button>
              </div>
              {customSkip.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {customSkip.map(d => (
                    <span key={d} className="inline-flex items-center gap-1 text-[11px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                      {d}
                      <button onClick={() => setCustomSkip(s => s.filter(x => x !== d))}><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="ops-card ops-card-pad space-y-3">
            <div className="ops-section-title">รายละเอียดงาน (ใช้กับทุกใบ)</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="ops-label">Shoot type</label>
                <select className="ops-input" value={shootType} onChange={e => setShootType(e.target.value)}>
                  {SHOOT_TYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="ops-label">Category</label>
                <select className="ops-input" value={category} onChange={e => setCategory(e.target.value)}>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="ops-label">Call time</label>
                <input type="time" className="ops-input" value={callTime} onChange={e => setCallTime(e.target.value)} />
              </div>
              <div>
                <label className="ops-label">Wrap (โดยประมาณ)</label>
                <input type="time" className="ops-input" value={estimatedWrap} onChange={e => setEstimatedWrap(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="ops-label">Producer <span className="ops-required">*</span></label>
              <input className="ops-input" value={producer} onChange={e => setProducer(e.target.value)} placeholder="ชื่อผู้รับผิดชอบรายการ" />
            </div>
            <div>
              <label className="ops-label">Location</label>
              <input className="ops-input" value={locationName} onChange={e => setLocationName(e.target.value)} placeholder="เช่น Studio 1" />
            </div>
            <div>
              <label className="ops-label">Crew</label>
              <div className="flex flex-wrap gap-1">
                {CREW.map(c => (
                  <button key={c} type="button" onClick={() => toggleCrew(c)}
                    className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                      crewRequired.includes(c) ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'bg-white text-gray-500 border-gray-200 hover:border-[#673ab7]'
                    }`}>{c}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="ops-label">กล้อง</label>
                <input type="number" min="0" className="ops-input" value={cameraCount} onChange={e => setCameraCount(e.target.value)} />
              </div>
              <div>
                <label className="ops-label">ไมค์</label>
                <input type="number" min="0" className="ops-input" value={micCount} onChange={e => setMicCount(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="ops-label">Notes</label>
              <textarea className="ops-input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </div>
        </div>

        {/* ── Preview + generate ── */}
        <div className="space-y-3">
          <div className="ops-card ops-card-pad">
            <div className="ops-section-title mb-2">พรีวิว</div>
            {!preview ? (
              <p className="text-sm text-gray-400">เลือกวันเริ่ม–สิ้นสุดเพื่อดูพรีวิว</p>
            ) : preview.error ? (
              <p className="text-sm text-red-600 inline-flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> {preview.error}</p>
            ) : (
              <>
                <div className="flex items-baseline gap-3 mb-3">
                  <span className="text-3xl font-medium text-[#673ab7]">{preview.dates.length}</span>
                  <span className="text-sm text-gray-500">booking จะถูกสร้าง · ข้าม {preview.skipped.length} วัน</span>
                </div>
                <div className="max-h-44 overflow-y-auto border border-gray-100 rounded p-2 text-[12px] grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5">
                  {preview.dates.map(d => <span key={d} className="text-gray-700 font-mono">{d}</span>)}
                </div>
                {preview.skipped.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs text-gray-500 cursor-pointer">วันที่ข้าม ({preview.skipped.length})</summary>
                    <div className="mt-1 text-[11px] text-gray-500 space-y-0.5 max-h-32 overflow-y-auto">
                      {preview.skipped.map(s => (
                        <div key={s.date} className="flex justify-between">
                          <span className="font-mono">{s.date}</span>
                          <span>{s.reason === 'holiday' ? s.label : s.reason === 'custom' ? 'กำหนดเอง' : 'นอกรอบ'}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </div>

          <button onClick={generate} disabled={!canGenerate || generating}
            className="ops-btn ops-btn-primary w-full inline-flex items-center justify-center gap-2 disabled:opacity-50">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />}
            สร้าง Routine {preview && !preview.error ? `(${preview.dates.length})` : ''}
          </button>
          {!producer.trim() && <p className="text-[11px] text-amber-600">* ต้องกรอก Producer ก่อนสร้าง</p>}
          {error && <div className="ops-card px-3 py-2 text-sm text-red-700 bg-red-50 border-red-200 border-l-4 border-l-red-500">{error}</div>}
          {result && (
            <div className="ops-card px-3 py-2 text-sm bg-green-50 border-green-200 border-l-4 border-l-green-500 text-green-800">
              <div className="inline-flex items-center gap-1 font-medium"><Check className="w-4 h-4" /> สร้างสำเร็จ {result.created} ใบ (REQUESTED)</div>
              {!!result.duplicatesSkipped && (
                <div className="text-amber-700 mt-1">ข้ามวันที่มี booking อยู่แล้ว {result.duplicatesSkipped} วัน</div>
              )}
              {result.failed.length > 0 && (
                <div className="text-red-700 mt-1">ล้มเหลว {result.failed.length}: {result.failed.slice(0, 3).map(f => f.date).join(', ')}{result.failed.length > 3 ? '…' : ''}</div>
              )}
            </div>
          )}

          {/* existing groups */}
          <div className="ops-card ops-card-pad">
            <div className="ops-section-title mb-2">ชุด Routine ที่มีอยู่</div>
            {groupsLoading ? (
              <p className="text-sm text-gray-400">กำลังโหลด…</p>
            ) : groups.length === 0 ? (
              <p className="text-sm text-gray-400">ยังไม่มีชุด Routine</p>
            ) : (
              <div className="space-y-2">
                {groups.map(g => (
                  <div key={g.routineGroupId} className="flex items-center justify-between gap-2 border border-gray-100 rounded p-2">
                    <div className="min-w-0">
                      <div className="text-sm text-gray-800 font-medium truncate">{g.outlet} · {g.program}</div>
                      <div className="text-[11px] text-gray-500">
                        {g.count} ใบ · {g.from} – {g.to} ·{' '}
                        {Object.entries(g.statuses).map(([s, n]) => `${s} ${n}`).join(', ')}
                      </div>
                    </div>
                    <button onClick={() => cancelGroup(g)}
                      className="ops-btn ops-btn-sm text-red-600 border border-red-200 hover:bg-red-50 inline-flex items-center gap-1 flex-shrink-0">
                      <Trash2 className="w-3.5 h-3.5" /> ลบทั้งชุด
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
