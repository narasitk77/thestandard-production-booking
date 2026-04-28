'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Calendar, Clock, Plus, Trash2, Loader2, Lock, Info } from 'lucide-react'
import { format, parseISO } from 'date-fns'

interface OTRecord {
  id: string
  userEmail: string
  month: string
  date: string
  type: 'HOLIDAY' | 'OVERTIME'
  hours: number
  description: string | null
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
  const [type, setType] = useState<'HOLIDAY' | 'OVERTIME'>('OVERTIME')
  const [hours, setHours] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = async (m: string) => {
    setLoading(true)
    setError('')
    try {
      const [rRes, pRes] = await Promise.all([
        fetch(`/api/ot?month=${m}`),
        fetch('/api/auth/session'),
      ])
      const rData = await rRes.json()
      if (!rRes.ok) throw new Error(rData.error || 'Failed to load')
      setRecords(rData.records || [])
      setEditable(!!rData.editable)

      // fetch self profile
      const pRes2 = await fetch('/api/me')
      if (pRes2.ok) {
        const pData = await pRes2.json()
        setProfile(pData.user)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(month) }, [month])

  const summary = useMemo(() => {
    let holidayDays = 0, otHours = 0
    for (const r of records) {
      if (r.type === 'HOLIDAY') holidayDays += 1
      if (r.type === 'OVERTIME') otHours += r.hours
    }
    return { holidayDays, otHours: Math.round(otHours * 100) / 100 }
  }, [records])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (date.slice(0, 7) !== month) {
      setError('Date must be within the selected month.')
      return
    }
    if (type === 'OVERTIME' && (!hours || Number(hours) <= 0)) {
      setError('Enter OT hours (greater than 0).')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/ot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, type, hours: Number(hours) || 0, description }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setRecords(prev => [...prev, data.record].sort((a, b) => a.date.localeCompare(b.date)))
      setHours(''); setDescription('')
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
    else alert('ลบไม่สำเร็จ')
  }

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-2xl sm:text-3xl font-normal text-gray-800 mb-1">บันทึกเวลาทำงานวันหยุด / OT</h1>
        <p className="text-xs sm:text-sm text-gray-500">บันทึกการทำงานวันเสาร์-อาทิตย์/วันหยุด และค่าทำงานล่วงเวลาประจำเดือน</p>
      </div>

      {/* Profile */}
      {profile && (
        <div className="gf-card p-4 text-xs sm:text-sm text-gray-600 flex items-center gap-3 flex-wrap">
          <span className="font-medium text-gray-800">{profile.thaiName || profile.email}</span>
          {profile.employeeId && <span className="text-gray-400">{profile.employeeId}</span>}
          {profile.position && <span className="bg-gray-100 px-2 py-0.5 rounded text-gray-600">{profile.position}</span>}
          {profile.role === 'ADMIN' && (
            <Link href="/ot/admin" className="ml-auto text-[#673ab7] hover:underline text-xs">
              → Admin / Cover Sheet
            </Link>
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

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3">
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">วันทำงานวันหยุด</div>
          <div className="text-2xl font-medium text-gray-800">{summary.holidayDays} <span className="text-sm text-gray-400">วัน</span></div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">ค่าทำงานล่วงเวลา</div>
          <div className="text-2xl font-medium text-gray-800">{summary.otHours} <span className="text-sm text-gray-400">ชั่วโมง</span></div>
        </div>
      </div>

      {/* Add form */}
      {editable && (
        <form onSubmit={handleAdd} className="gf-card p-4 sm:p-5 space-y-3">
          <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Plus className="w-4 h-4 text-[#673ab7]" /> เพิ่มรายการ
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">ประเภท</label>
            <div className="flex gap-3 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" checked={type === 'OVERTIME'} onChange={() => setType('OVERTIME')} className="accent-[#673ab7]" />
                ทำงานล่วงเวลา (เกิน 8 ชั่วโมง)
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" checked={type === 'HOLIDAY'} onChange={() => setType('HOLIDAY')} className="accent-[#673ab7]" />
                วันหยุด (เสาร์-อาทิตย์ / วันหยุดประกาศ)
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">วันที่</label>
              <input type="date" className="gf-input" value={date}
                onChange={e => setDate(e.target.value)}
                min={`${month}-01`} max={`${month}-31`} required />
            </div>
            {type === 'OVERTIME' && (
              <div>
                <label className="text-xs text-gray-500 mb-1 block">จำนวนชั่วโมง OT</label>
                <input type="number" step="0.5" min="0.5" max="24" className="gf-input" value={hours}
                  onChange={e => setHours(e.target.value)} placeholder="เช่น 3.5" required />
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">รายละเอียด (optional)</label>
            <input type="text" className="gf-input" value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="ทำงานอะไร / โปรเจกต์ไหน" />
          </div>

          <button type="submit" disabled={submitting}
            className="gf-submit text-sm">
            {submitting ? '…' : '+ เพิ่ม'}
          </button>
        </form>
      )}

      {/* Records list */}
      <div className="gf-card p-4 sm:p-5">
        <div className="text-sm font-medium text-gray-700 mb-3">รายการเดือน {monthLabel(month)} ({records.length})</div>
        {loading ? (
          <div className="py-8 text-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400 mx-auto" /></div>
        ) : records.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-400">ยังไม่มีรายการในเดือนนี้</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {records.map(r => (
              <div key={r.id} className="py-2.5 flex items-center gap-3 flex-wrap">
                <div className="text-xs text-gray-500 w-20 flex-shrink-0">
                  {format(parseISO(r.date), 'dd/MM/yyyy')}
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${
                  r.type === 'HOLIDAY' ? 'bg-orange-50 text-orange-700 border-orange-200' : 'bg-blue-50 text-blue-700 border-blue-200'
                }`}>
                  {r.type === 'HOLIDAY' ? 'วันหยุด' : 'OT'}
                </span>
                <span className="text-sm text-gray-800 font-medium tabular-nums">
                  {r.type === 'OVERTIME' ? `${r.hours} ชม.` : '1 วัน'}
                </span>
                <span className="text-xs text-gray-500 flex-1 min-w-[100px] truncate">{r.description || '—'}</span>
                {editable && (
                  <button onClick={() => handleDelete(r.id)}
                    className="text-gray-400 hover:text-red-500 p-1">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info banner */}
      <div className="gf-card p-3 text-xs text-gray-500 flex items-start gap-2 border-l-4 border-blue-200">
        <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="mb-0.5"><span className="font-medium text-gray-700">เดือนนี้แก้ไขได้</span> · เดือนก่อนหน้าเก็บไว้ 10 วันแล้วลบอัตโนมัติ</p>
          <p>ผู้ใช้ทั่วไปแก้ไขเฉพาะของตัวเองได้ · Admin export CSV รวมทุกคนได้</p>
        </div>
      </div>
    </div>
  )
}
