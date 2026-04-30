'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Calendar, Clock, Plus, Trash2, Loader2, Lock, Info, AlertTriangle } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { summarizeDay, formatTHB, WEEKDAY_THRESHOLD_HOURS, type DaySummary } from '@/lib/ot-calc'
import { isThaiHoliday, getHolidayName } from '@/lib/thai-holidays'

interface OTRecord {
  id: string
  userEmail: string
  month: string
  date: string
  startTime: string | null
  endTime: string | null
  jobTask: string | null
  justification: string | null
  // legacy
  type: 'HOLIDAY' | 'OVERTIME' | null
  hours: number
  description: string | null
  bookingId: string | null
}

interface Profile {
  email: string
  thaiName: string | null
  employeeId: string | null
  position: string | null
  role: string
}

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']

function todayISO(): string { return new Date().toISOString().slice(0, 10) }
function currentMonth(): string { return todayISO().slice(0, 7) }
function prevMonth(): string {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1)
  return d.toISOString().slice(0, 7)
}
function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-')
  return `${THAI_MONTHS[parseInt(m) - 1]} ${y}`
}

export default function OTPage() {
  const [records, setRecords] = useState<OTRecord[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(currentMonth())
  const [editable, setEditable] = useState(true)
  const [error, setError] = useState('')

  // form
  const [date, setDate] = useState(todayISO())
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [jobTask, setJobTask] = useState('')
  const [justification, setJustification] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = async (m: string) => {
    setLoading(true)
    setError('')
    try {
      const rRes = await fetch(`/api/ot?month=${m}`)
      const rData = await rRes.json()
      if (!rRes.ok) throw new Error(rData.error || 'Failed to load')
      setRecords(rData.records || [])
      setEditable(!!rData.editable)

      const pRes = await fetch('/api/me')
      if (pRes.ok) {
        const pData = await pRes.json()
        setProfile(pData.user)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(month) }, [month])

  // Group records by date
  const days = useMemo(() => {
    const byDate = new Map<string, OTRecord[]>()
    for (const r of records) {
      const key = r.date.slice(0, 10)
      if (!byDate.has(key)) byDate.set(key, [])
      byDate.get(key)!.push(r)
    }
    const out: Array<{ date: string; records: OTRecord[]; summary: DaySummary }> = []
    Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([date, list]) => {
        const tasks = list.map(r => ({
          startTime: r.startTime || '',
          endTime: r.endTime || '',
          jobTask: r.jobTask,
          justification: r.justification,
        }))
        out.push({ date, records: list, summary: summarizeDay(date, tasks) })
      })
    return out
  }, [records])

  const totals = useMemo(() => {
    let amount = 0
    let qualifyingDays = 0
    let weekendHoliday = 0
    let weekdayOT = 0
    for (const d of days) {
      if (d.summary.qualifies) {
        qualifyingDays += 1
        amount += d.summary.otAmountTHB
        if (d.summary.dayType === 'WEEKDAY') weekdayOT += 1
        else weekendHoliday += 1
      }
    }
    return { amount, qualifyingDays, weekendHoliday, weekdayOT }
  }, [days])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (date.slice(0, 7) !== month) {
      setError('Date must be within the selected month.')
      return
    }
    if (!startTime || !endTime) {
      setError('Start time and end time are required.')
      return
    }
    if (!jobTask.trim()) {
      setError('Job task is required.')
      return
    }
    if (!justification.trim()) {
      setError('Justification is required (why OT was necessary).')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/ot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, startTime, endTime, jobTask, justification }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setRecords(prev => [...prev, data.record])
      setStartTime(''); setEndTime(''); setJobTask(''); setJustification('')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('ลบรายการนี้?')) return
    const res = await fetch(`/api/ot/${id}`, { method: 'DELETE' })
    if (res.ok) setRecords(prev => prev.filter(r => r.id !== id))
    else {
      const d = await res.json().catch(() => ({}))
      alert(d.error || 'ลบไม่สำเร็จ')
    }
  }

  const dateInfo = (d: string) => {
    const dt = new Date(d)
    const day = dt.getDay()
    const isWeekend = day === 0 || day === 6
    const isHoliday = isThaiHoliday(d)
    return { isWeekend, isHoliday, holidayName: getHolidayName(d) }
  }

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-2xl sm:text-3xl font-normal text-gray-800 mb-1">OT — Overtime & Holiday Pay</h1>
        <p className="text-xs sm:text-sm text-gray-500">บันทึกชั่วโมงทำงาน · ระบบคำนวณ OT THB อัตโนมัติ</p>
      </div>

      {profile && (
        <div className="gf-card p-4 text-xs sm:text-sm text-gray-600 flex items-center gap-3 flex-wrap">
          <span className="font-medium text-gray-800">{profile.thaiName || profile.email}</span>
          {profile.employeeId && <span className="text-gray-400">{profile.employeeId}</span>}
          {profile.position && <span className="bg-gray-100 px-2 py-0.5 rounded text-gray-600">{profile.position}</span>}
          {profile.role === 'ADMIN' && (
            <Link href="/ot/admin" className="ml-auto text-[#673ab7] hover:underline text-xs">→ Admin / Cover Sheet</Link>
          )}
        </div>
      )}

      {/* Month picker */}
      <div className="gf-card p-4 flex items-center gap-2 flex-wrap">
        <Calendar className="w-4 h-4 text-gray-400" />
        <span className="text-sm text-gray-700 font-medium">{monthLabel(month)}</span>
        {!editable && (
          <span className="inline-flex items-center gap-1 text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 px-2 py-0.5 rounded">
            <Lock className="w-3 h-3" /> Read-only
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <button onClick={() => setMonth(prevMonth())}
            className={`text-xs px-2 py-1 border rounded ${month === prevMonth() ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'border-gray-300 hover:bg-gray-50'}`}>
            เดือนก่อน
          </button>
          <button onClick={() => setMonth(currentMonth())}
            className={`text-xs px-2 py-1 border rounded ${month === currentMonth() ? 'bg-[#673ab7] text-white border-[#673ab7]' : 'border-gray-300 hover:bg-gray-50'}`}>
            เดือนนี้
          </button>
        </div>
      </div>

      {error && <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400">{error}</div>}

      {/* Total summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">รวม OT เดือนนี้</div>
          <div className="text-2xl font-medium text-gray-800">{formatTHB(totals.amount)}</div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">วันที่นับ OT</div>
          <div className="text-2xl font-medium text-gray-800">{totals.qualifyingDays}<span className="text-sm text-gray-400 ml-1">วัน</span></div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">หยุด/วันหยุดประกาศ</div>
          <div className="text-2xl font-medium text-gray-800">{totals.weekendHoliday}</div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">วันธรรมดา &gt;{WEEKDAY_THRESHOLD_HOURS}h</div>
          <div className="text-2xl font-medium text-gray-800">{totals.weekdayOT}</div>
        </div>
      </div>

      {/* Add form */}
      {editable && (
        <form onSubmit={handleAdd} className="gf-card p-4 sm:p-5 space-y-3">
          <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Plus className="w-4 h-4 text-[#673ab7]" /> เพิ่มรายการ
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">วันที่ *</label>
              <input type="date" className="gf-input" value={date}
                onChange={e => setDate(e.target.value)}
                min={`${month}-01`} max={`${month}-31`} required />
              {(() => {
                const info = dateInfo(date)
                if (info.isHoliday) return <p className="text-[10px] text-red-600 mt-1">🎉 {info.holidayName} (วันหยุดประกาศ — 500 THB)</p>
                if (info.isWeekend) return <p className="text-[10px] text-orange-600 mt-1">📅 วันเสาร์/อาทิตย์ (500 THB)</p>
                return <p className="text-[10px] text-gray-400 mt-1">วันธรรมดา (ต้อง span &gt; {WEEKDAY_THRESHOLD_HOURS}h → 300 THB)</p>
              })()}
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">เริ่ม *</label>
              <input type="time" className="gf-input" value={startTime}
                onChange={e => setStartTime(e.target.value)} required />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">สิ้นสุด *</label>
              <input type="time" className="gf-input" value={endTime}
                onChange={e => setEndTime(e.target.value)} required />
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">งานที่ทำ (Job Task) *</label>
            <input type="text" className="gf-input" value={jobTask}
              onChange={e => setJobTask(e.target.value)}
              placeholder="เช่น ถ่ายทำ Key Message EP.5, Standby กองถ่าย Event..."
              required />
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">เหตุผล (Justification) *</label>
            <textarea className="gf-input resize-none" rows={2} value={justification}
              onChange={e => setJustification(e.target.value)}
              placeholder="ทำไมต้องทำงานล่วงเวลา / Standby ในช่วงเวลานี้ — เช่น 'Live event ยืดเวลา', 'รอลูกค้ามาถ่าย', 'ต้องเตรียมอุปกรณ์ก่อนเวลาปกติ'"
              required />
          </div>

          <button type="submit" disabled={submitting}
            className="gf-submit text-sm">
            {submitting ? '…' : '+ เพิ่ม'}
          </button>
        </form>
      )}

      {/* Days list */}
      {loading ? (
        <div className="py-8 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
      ) : days.length === 0 ? (
        <div className="gf-card p-8 text-center text-sm text-gray-400">ยังไม่มีรายการในเดือนนี้</div>
      ) : (
        days.map(d => <DayCard key={d.date} date={d.date} records={d.records} summary={d.summary} editable={editable} onDelete={handleDelete} />)
      )}

      {/* Info banner */}
      <div className="gf-card p-3 text-xs text-gray-500 border-l-4 border-blue-200 space-y-1">
        <p className="flex items-center gap-1"><Info className="w-3 h-3 text-blue-400" /> <strong>กฎ OT:</strong></p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li><strong>วันธรรมดา:</strong> ทำงาน (start ของงานแรก → end ของงานสุดท้าย) เกิน {WEEKDAY_THRESHOLD_HOURS} ชม. → <strong>300 THB</strong></li>
          <li><strong>เสาร์-อาทิตย์:</strong> ทำงานช่วงไหนก็ได้ → <strong>500 THB</strong></li>
          <li><strong>วันหยุดประกาศ:</strong> ตามปฏิทินไทย Google Calendar → <strong>500 THB</strong></li>
          <li>ถ้ามีช่วงว่างระหว่างงาน (เช่น เช้า + เย็น) → นับเป็น <strong>"Standby"</strong></li>
          <li>วันหยุดที่ตรงกับเสาร์/อาทิตย์ → คงที่ 500 THB ไม่บวกซ้อน</li>
        </ul>
      </div>
    </div>
  )
}

function DayCard({ date, records, summary, editable, onDelete }: {
  date: string
  records: OTRecord[]
  summary: DaySummary
  editable: boolean
  onDelete: (id: string) => void
}) {
  const colorClass =
    summary.dayType === 'HOLIDAY' ? 'border-l-red-400 bg-red-50/30' :
    summary.dayType === 'WEEKEND' ? 'border-l-orange-400 bg-orange-50/30' :
    summary.qualifies ? 'border-l-blue-400 bg-blue-50/30' :
    'border-l-gray-200'

  return (
    <div className={`gf-card p-4 sm:p-5 border-l-4 ${colorClass}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
        <div>
          <div className="text-sm font-medium text-gray-800">
            {format(parseISO(date), 'EEE dd MMM yyyy')}
            {summary.holidayName && <span className="ml-2 text-xs text-red-600">🎉 {summary.holidayName}</span>}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            <span className={`inline-block px-1.5 py-0.5 rounded mr-1 ${
              summary.dayType === 'HOLIDAY' ? 'bg-red-100 text-red-700' :
              summary.dayType === 'WEEKEND' ? 'bg-orange-100 text-orange-700' :
              'bg-gray-100 text-gray-600'
            }`}>{summary.dayLabel}</span>
            {summary.totalHours > 0 && <span>span {summary.totalHours}h</span>}
            {summary.hasStandby && <span className="ml-1 inline-block px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">Standby</span>}
          </div>
        </div>
        <div className="text-right">
          <div className={`text-lg font-medium ${summary.qualifies ? 'text-green-700' : 'text-gray-400'}`}>
            {summary.qualifies ? formatTHB(summary.otAmountTHB) : '—'}
          </div>
          <div className="text-[10px] text-gray-500">{summary.status}</div>
        </div>
      </div>

      <div className="divide-y divide-gray-100">
        {records.map(r => (
          <div key={r.id} className="py-2 flex items-start gap-3 flex-wrap">
            <div className="text-xs text-gray-500 font-mono flex-shrink-0 w-24">
              {r.startTime || '—'} → {r.endTime || '—'}
            </div>
            <div className="flex-1 min-w-[150px]">
              <div className="text-sm text-gray-800">{r.jobTask || r.description || '—'}</div>
              {r.justification && (
                <div className="text-xs text-gray-500 mt-0.5">📝 {r.justification}</div>
              )}
              <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                {r.bookingId && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">auto</span>}
              </div>
            </div>
            {editable && !r.bookingId && (
              <button onClick={() => onDelete(r.id)}
                className="text-gray-400 hover:text-red-500 p-1 flex-shrink-0">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
