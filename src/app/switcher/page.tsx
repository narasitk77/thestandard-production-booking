'use client'

/**
 * v1.211 — /switcher · สมุดบันทึกงานไลฟ์ของสวิตเชอร์
 *
 * ที่มา: หมายไลฟ์ลงโซเชียลถูกสั่งกันในกลุ่มไลน์ ไม่เคยผ่านระบบจอง จึงไม่มีที่ไหน
 * ตอบได้ว่าเดือนนี้ทีมสวิตเชอร์คุมไปกี่งาน กี่ชั่วโมง ลิงก์อยู่ที่ไหน หน้านี้ให้
 * เจ้าตัวมาลงเองหลังงานจบ แล้วระบบออก Production ID ให้ในช่องสุดท้าย
 *
 * สองอย่างที่ตั้งใจออกแบบ:
 *  - ลิงก์ **ไม่บังคับ** ตอนบันทึก เพราะมันมาช้ากว่าตัวงานเสมอ แต่มีกล่อง
 *    "ต้องตามต่อ" ค้างไว้จนกว่าจะใส่ — บังคับกรอกได้ลิงก์มั่ว ปล่อยเงียบได้ศูนย์
 *  - กล่องตามงาน **ไม่ผูกกับเดือนที่เลือก** ของค้างเดือนก่อนคือของที่ต้องตามที่สุด
 */

import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Calendar, Check, Copy, Download, Link2, Loader2,
  Pencil, Plus, Trash2, X,
} from 'lucide-react'
import { OUTLETS } from '@/lib/data'
import {
  FOLLOW_UP_LABEL, PLATFORM_LABEL, SWITCHER_PLATFORMS,
  followUpReason, formatDuration, jobDurationMinutes, readLinks,
  switcherIdPrefix,
  type SwitcherLink, type SwitcherPlatform,
} from '@/lib/switcher-jobs'

interface Job {
  id: string
  productionId: string | null
  outletCode: string
  jobName: string
  workDate: string
  startTime: string | null
  endTime: string | null
  endDayOffset: number
  links: unknown
  requestedBy: string | null
  notes: string | null
  switcherEmail: string | null
  source: string
  status: string
}

interface Me {
  email: string
  isSwitcher: boolean
  canEditAll: boolean
  canCreate: boolean
}

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']

function todayISO(): string {
  // ปฏิทินกรุงเทพ — เครื่องของผู้ใช้อยู่ไทยอยู่แล้ว แต่เขียนให้ชัดว่าตั้งใจ
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
}
function monthOf(iso: string): string { return iso.slice(0, 7) }
function shiftMonth(yyyymm: string, delta: number): string {
  const [y, m] = yyyymm.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return d.toISOString().slice(0, 7)
}
function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-')
  return `${THAI_MONTHS[parseInt(m, 10) - 1]} ${y}`
}
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const wd = ['อา','จ','อ','พ','พฤ','ศ','ส'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${d} ${THAI_MONTHS[m - 1].slice(0, 3)} · ${wd}`
}

type LinkRow = { platform: SwitcherPlatform; url: string }
const emptyLink = (): LinkRow => ({ platform: 'YOUTUBE', url: '' })

export default function SwitcherPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [followUps, setFollowUps] = useState<Job[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [month, setMonth] = useState(monthOf(todayISO()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  // ── ฟอร์ม ──────────────────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null)
  const [idLocked, setIdLocked] = useState(false)
  const [editingProductionId, setEditingProductionId] = useState<string | null>(null)
  const [outletCode, setOutletCode] = useState('TSS')
  const [jobName, setJobName] = useState('')
  const [workDate, setWorkDate] = useState(todayISO())
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [endDayOffset, setEndDayOffset] = useState(0)
  const [links, setLinks] = useState<LinkRow[]>([emptyLink()])
  const [requestedBy, setRequestedBy] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async (m: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/switcher?month=${m}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'โหลดข้อมูลไม่สำเร็จ')
      setJobs(data.jobs || [])
      setFollowUps(data.followUps || [])
      setMe(data.me || null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(month) }, [month])

  const resetForm = () => {
    setEditingId(null)
    setIdLocked(false)
    setEditingProductionId(null)
    setJobName('')
    setWorkDate(todayISO())
    setStartTime('')
    setEndTime('')
    setEndDayOffset(0)
    setLinks([emptyLink()])
    setRequestedBy('')
    setNotes('')
    setError('')
  }

  const startEdit = (job: Job) => {
    setEditingId(job.id)
    setIdLocked(!!job.productionId)
    setEditingProductionId(job.productionId)
    setOutletCode(job.outletCode)
    setJobName(job.jobName)
    setWorkDate(job.workDate.slice(0, 10))
    setStartTime(job.startTime || '')
    setEndTime(job.endTime || '')
    setEndDayOffset(job.endDayOffset === 1 ? 1 : 0)
    const existing = readLinks(job.links)
    setLinks(existing.length ? existing.map(l => ({ platform: l.platform, url: l.url })) : [emptyLink()])
    setRequestedBy(job.requestedBy || '')
    setNotes(job.notes || '')
    setError('')
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    const payload = {
      outletCode, jobName, workDate, startTime, endTime, endDayOffset,
      links: links.filter(l => l.url.trim()),
      requestedBy, notes,
    }
    try {
      const res = await fetch(editingId ? `/api/switcher/${editingId}` : '/api/switcher', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'บันทึกไม่สำเร็จ')
      // ถ้าบันทึกไปคนละเดือนกับที่กำลังดู ให้เด้งไปเดือนนั้นเลย ไม่งั้นคนกรอก
      // จะเห็นหน้าว่างแล้วนึกว่าบันทึกไม่ติด แล้วกดซ้ำ
      const savedMonth = monthOf(workDate)
      resetForm()
      if (savedMonth !== month) setMonth(savedMonth)
      else await load(month)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (job: Job) => {
    if (!confirm(`ลบ "${job.jobName}"${job.productionId ? ` (${job.productionId})` : ''}?\n\nเลขที่ออกไปแล้วจะไม่ถูกนำมาใช้ซ้ำ`)) return
    const res = await fetch(`/api/switcher/${job.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      alert(d.error || 'ลบไม่สำเร็จ')
      return
    }
    if (editingId === job.id) resetForm()
    await load(month)
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(c => (c === text ? null : c)), 1500)
    } catch {
      /* คลิปบอร์ดถูกบล็อก (in-app browser บางตัว) — ปล่อยให้คนเลือกข้อความเอง */
    }
  }

  const canEdit = (job: Job) =>
    !!me && (me.canEditAll || (job.switcherEmail
      ? job.switcherEmail.toLowerCase() === me.email.toLowerCase()
      : job.status === 'DRAFT' && me.isSwitcher))

  const totals = useMemo(() => {
    let mins = 0
    let timed = 0
    let noLink = 0
    for (const j of jobs) {
      const d = jobDurationMinutes(j)
      if (d !== null) { mins += d; timed++ }
      if (j.status !== 'DRAFT' && readLinks(j.links).length === 0) noLink++
    }
    return { count: jobs.length, mins, timed, noLink }
  }, [jobs])

  const mine = useMemo(
    () => (me ? jobs.filter(j => (j.switcherEmail || '').toLowerCase() === me.email.toLowerCase()).length : 0),
    [jobs, me],
  )

  // เลขจริงออกตอนบันทึก — ก่อนหน้านั้นโชว์คำนำหน้าที่แน่นอนแล้ว + ?? แทนลำดับ
  const idPreview = useMemo(() => {
    if (editingProductionId) return editingProductionId
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return '—'
    return `${switcherIdPrefix(outletCode, workDate)}??`
  }, [editingProductionId, outletCode, workDate])

  const currentMonth = monthOf(todayISO())

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-8 space-y-3">
      <div className="gf-header p-4 sm:p-6">
        <h1 className="text-2xl sm:text-3xl font-normal text-gray-800 mb-1">🎛 งานไลฟ์ของสวิตเชอร์</h1>
        <p className="text-xs sm:text-sm text-gray-500">
          หมายที่สั่งกันในกลุ่มไลน์ ลงไว้ที่นี่หลังงานจบ — ระบบออก Production ID ให้เอง
        </p>
      </div>

      {/* เดือน + สรุป */}
      <div className="gf-card p-4 flex items-center gap-2 flex-wrap">
        <Calendar className="w-4 h-4 text-gray-400" />
        <span className="text-sm text-gray-700 font-medium">{monthLabel(month)}</span>
        <div className="ml-auto flex gap-1 items-center">
          <button onClick={() => setMonth(shiftMonth(month, -1))}
            className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">← เดือนก่อน</button>
          <button onClick={() => setMonth(currentMonth)}
            className={`text-xs px-2 py-1 border rounded ${month === currentMonth ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 hover:bg-gray-50'}`}>
            เดือนนี้
          </button>
          <button onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= currentMonth}
            className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">
            เดือนถัดไป →
          </button>
          <a href={`/api/switcher/export?month=${month}`} download
            className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
            <Download className="w-3 h-3" /> CSV
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">งานเดือนนี้</div>
          <div className="text-2xl font-medium text-gray-800">{totals.count}<span className="text-sm text-gray-400 ml-1">หมาย</span></div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">รวมเวลาทำงาน</div>
          <div className="text-2xl font-medium text-gray-800">{Math.round((totals.mins / 60) * 10) / 10}<span className="text-sm text-gray-400 ml-1">ชม.</span></div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">ของฉัน</div>
          <div className="text-2xl font-medium text-gray-800">{mine}<span className="text-sm text-gray-400 ml-1">หมาย</span></div>
        </div>
        <div className="gf-card p-4">
          <div className="text-xs text-gray-500 mb-1">ยังไม่ใส่ลิงก์</div>
          <div className={`text-2xl font-medium ${totals.noLink > 0 ? 'text-amber-600' : 'text-gray-800'}`}>{totals.noLink}</div>
        </div>
      </div>

      {error && <div className="gf-card p-3 text-sm text-red-600 border-l-4 border-red-400">{error}</div>}

      {/* ต้องตามต่อ — ข้ามเดือน โดยตั้งใจ */}
      {followUps.length > 0 && (
        <div className="gf-card p-4 border-l-4 border-amber-400 bg-amber-50/40 space-y-2">
          <div className="text-sm font-medium text-amber-800 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> ต้องตามต่อ {followUps.length} รายการ
            <span className="text-[11px] font-normal text-amber-700">(ย้อนหลัง 60 วัน · ไม่ขึ้นกับเดือนที่เลือก)</span>
          </div>
          <ul className="space-y-1">
            {followUps.map(j => {
              const reason = followUpReason(j)
              return (
                <li key={j.id} className="text-xs flex items-center gap-2 flex-wrap">
                  <span className="text-gray-400 tabular-nums w-20 shrink-0">{dayLabel(j.workDate.slice(0, 10))}</span>
                  <span className="font-medium text-gray-800">{j.jobName}</span>
                  {reason && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                      {FOLLOW_UP_LABEL[reason]}
                    </span>
                  )}
                  {j.switcherEmail && <span className="text-gray-400">{j.switcherEmail.split('@')[0]}</span>}
                  {canEdit(j) && (
                    <button onClick={() => startEdit(j)} className="text-[#1a73e8] hover:underline ml-auto">
                      {j.status === 'DRAFT' ? 'รับงานนี้ →' : 'เติมข้อมูล →'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* ฟอร์ม */}
      {me?.canCreate && (
        <form onSubmit={submit} className="gf-card p-4 sm:p-5 space-y-3">
          <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
            {editingId ? <Pencil className="w-4 h-4 text-gray-500" /> : <Plus className="w-4 h-4 text-gray-500" />}
            {editingId ? (editingProductionId ? `แก้ไข ${editingProductionId}` : 'รับงานนี้ + กรอกข้อมูล') : 'บันทึกงานไลฟ์'}
            {editingId && (
              <button type="button" onClick={resetForm} className="ml-auto text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1">
                <X className="w-3 h-3" /> ยกเลิก
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">สังกัด *</label>
              <select className="gf-select" value={outletCode} disabled={idLocked}
                onChange={e => setOutletCode(e.target.value)}>
                {OUTLETS.map(o => <option key={o.code} value={o.code}>{o.code} — {o.name}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-gray-500 mb-1 block">ชื่อหมาย *</label>
              <input className="gf-input" value={jobName} onChange={e => setJobName(e.target.value)}
                placeholder="เช่น ไลฟ์แถลงข่าว ก.คลัง" maxLength={200} required />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">วันที่ทำงาน *</label>
              <input type="date" className="gf-input" value={workDate} disabled={idLocked}
                onChange={e => setWorkDate(e.target.value)} required />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">เริ่ม *</label>
              <input type="time" className="gf-input" value={startTime} onChange={e => setStartTime(e.target.value)} required />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">เลิก *</label>
              <input type="time" className="gf-input" value={endTime} onChange={e => setEndTime(e.target.value)} required />
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={endDayOffset === 1} onChange={e => setEndDayOffset(e.target.checked ? 1 : 0)} />
            ไลฟ์ข้ามเที่ยงคืน (เลิกวันถัดไป)
            {jobDurationMinutes({ startTime, endTime, endDayOffset }) !== null && (
              <span className="text-gray-400">· รวม {formatDuration(jobDurationMinutes({ startTime, endTime, endDayOffset }))}</span>
            )}
          </label>

          {idLocked && (
            <p className="text-[11px] text-gray-500">
              สังกัดและวันที่ล็อกแล้วเพราะเลขออกไปแล้ว — ถ้ากรอกผิด ให้ลบรายการนี้แล้วเพิ่มใหม่
            </p>
          )}

          {/* ลิงก์ */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">ลิงก์ที่ออกอากาศ (ใส่ทีหลังได้)</label>
            <div className="space-y-2">
              {links.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <select className="gf-select w-32 shrink-0" value={l.platform}
                    onChange={e => setLinks(ls => ls.map((x, j) => j === i ? { ...x, platform: e.target.value as SwitcherPlatform } : x))}>
                    {SWITCHER_PLATFORMS.map(p => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
                  </select>
                  <input className="gf-input flex-1" type="url" inputMode="url" placeholder="https://…" value={l.url}
                    onChange={e => setLinks(ls => ls.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
                  {links.length > 1 && (
                    <button type="button" onClick={() => setLinks(ls => ls.filter((_, j) => j !== i))}
                      className="px-2 text-gray-400 hover:text-red-600" aria-label="ลบลิงก์">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {links.length < 10 && (
              <button type="button" onClick={() => setLinks(ls => [...ls, emptyLink()])}
                className="mt-2 text-xs text-[#1a73e8] hover:underline inline-flex items-center gap-1">
                <Plus className="w-3 h-3" /> เพิ่มลิงก์
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">ผู้สั่งงาน / คนที่ทักมาในไลน์</label>
              <input className="gf-input" value={requestedBy} onChange={e => setRequestedBy(e.target.value)}
                placeholder="เช่น พี่ปุ๊ก" maxLength={120} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">หมายเหตุ</label>
              <input className="gf-input" value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="เช่น ไลฟ์ล่ม 5 นาที ต่อใหม่" maxLength={2000} />
            </div>
          </div>

          {/* ช่องสุดท้าย — Production ID ที่ระบบออกให้ */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Production ID (ระบบออกให้)</label>
            <div className="flex gap-2">
              <input className="gf-input flex-1 font-mono bg-gray-50 text-gray-700" value={idPreview} readOnly tabIndex={-1} />
              {editingProductionId && (
                <button type="button" onClick={() => copy(editingProductionId)}
                  className="px-3 border border-gray-300 rounded hover:bg-gray-50 text-gray-600" aria-label="คัดลอก">
                  {copied === editingProductionId ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </button>
              )}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              {editingProductionId
                ? 'เลขนี้แก้ไม่ได้ — ก็อปไปแปะในชีท/ชื่อโฟลเดอร์ได้เลย'
                : 'ลำดับ (สองหลักท้าย) ออกตอนกดบันทึก · รูปแบบเดียวกับ Production ID ของงานถ่าย'}
            </p>
          </div>

          <button type="submit" disabled={saving} className="ops-btn ops-btn-primary disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {editingId ? 'บันทึกการแก้ไข' : 'บันทึกงาน'}
          </button>
        </form>
      )}

      {me && !me.canCreate && (
        <div className="gf-card p-3 text-xs text-gray-500">
          คุณดูได้อย่างเดียว — การบันทึกงานเป็นของทีมสวิตเชอร์
        </div>
      )}

      {/* รายการของเดือน */}
      {loading ? (
        <div className="gf-card p-8 text-center text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="gf-card p-8 text-center text-sm text-gray-400">
          ยังไม่มีงานที่บันทึกไว้ในเดือนนี้
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => {
            const jobLinks: SwitcherLink[] = readLinks(job.links)
            const mins = jobDurationMinutes(job)
            const reason = followUpReason(job)
            return (
              <div key={job.id} className={`gf-card p-3 sm:p-4 ${job.status === 'DRAFT' ? 'border-l-4 border-amber-300' : ''}`}>
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {job.productionId ? (
                        <button onClick={() => copy(job.productionId!)}
                          className="font-mono text-xs bg-gray-100 hover:bg-gray-200 px-1.5 py-0.5 rounded text-gray-700 inline-flex items-center gap-1">
                          {job.productionId}
                          {copied === job.productionId ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3 text-gray-400" />}
                        </button>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                          รอสวิตเชอร์รับ · ยังไม่ออกเลข
                        </span>
                      )}
                      <span className="font-medium text-gray-800 text-sm">{job.jobName}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
                      <span>{dayLabel(job.workDate.slice(0, 10))}</span>
                      {job.startTime && job.endTime && (
                        <span className="tabular-nums">
                          {job.startTime}–{job.endTime}{job.endDayOffset === 1 ? ' (+1)' : ''} · {formatDuration(mins)}
                        </span>
                      )}
                      {job.switcherEmail && <span className="text-gray-400">🎛 {job.switcherEmail.split('@')[0]}</span>}
                      {job.requestedBy && <span className="text-gray-400">สั่งโดย {job.requestedBy}</span>}
                      {job.source === 'LINE' && <span className="text-[10px] bg-gray-100 px-1 rounded text-gray-500">จากไลน์</span>}
                    </div>
                    {jobLinks.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {jobLinks.map((l, i) => (
                          <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-[#1a73e8] hover:underline inline-flex items-center gap-1 max-w-full">
                            <Link2 className="w-3 h-3 shrink-0" />
                            <span className="truncate">{PLATFORM_LABEL[l.platform]}</span>
                          </a>
                        ))}
                      </div>
                    )}
                    {reason && (
                      <div className="mt-1.5 text-[11px] text-amber-700">⚠️ {FOLLOW_UP_LABEL[reason]}</div>
                    )}
                    {job.notes && <div className="mt-1.5 text-xs text-gray-500">📝 {job.notes}</div>}
                  </div>
                  {canEdit(job) && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => startEdit(job)}
                        className="p-1.5 text-gray-400 hover:text-gray-800 rounded hover:bg-gray-100" aria-label="แก้ไข">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => remove(job)}
                        className="p-1.5 text-gray-400 hover:text-red-600 rounded hover:bg-red-50" aria-label="ลบ">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
