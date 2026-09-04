'use client'

/**
 * v1.215 — /mix · คิวงานมิกซ์เสียง
 *
 * ที่มา: งานมิกซ์ถูกสั่งกันในแชท ไม่มีที่ไหนตอบได้ว่าคิวยาวแค่ไหน ใครกำลังทำอะไร
 * และงานไหนเลยกำหนดไปแล้ว
 *
 * **จงใจเป็นคิวจอง ไม่ใช่สมุดบันทึก** — /switcher เป็น log ให้คนทำงานมากรอกย้อนหลัง
 * และมี 0 แถวตั้งแต่ปล่อยมา ที่นี่กลับด้าน: คนที่กรอกคือคนที่อยากได้ของ ไม่กรอก
 * แล้วไม่ได้งาน ส่วนบันทึกว่าใครทำอะไรเกิดขึ้นเองเป็นผลพลอยได้
 *
 * สองอย่างที่ตั้งใจออกแบบ:
 *  - **ทุกคนเห็นคิวทั้งหมด** ไม่ใช่เฉพาะของตัวเอง — คนขอต้องเห็นว่าคิวยาวแค่ไหน
 *    ก่อนไปรับปากลูกค้าว่าจะได้วันไหน (และกฎ "เห็นเฉพาะของตัวเอง" คือคลาสบั๊ก
 *    ที่ทำให้โปรดิวเซอร์ 59 คนมองไม่เห็นงานตัวเองใน v1.196)
 *  - **ไม่มีช่อง "ด่วน"** มีแต่กำหนดส่ง — ถ้ามีช่องด่วนทุกคนจะติ๊กเหมือนกันหมด
 *    แล้วมันก็ไม่ได้บอกอะไรอีกต่อไป
 */

import { useCallback, useEffect, useState } from 'react'
import MixRequestForm from '@/app/_components/MixRequestForm'
import { AlertTriangle, Check, Clock, Loader2, Plus, Trash2, X } from 'lucide-react'
import {
  MIX_STATUS_LABEL, MIX_FLAG_LABEL, canClaimMixJob, canAssignMixJob, canEditMixJob,
  canSetMixStatus, type MixActor, type MixStatus, type MixFlag,
} from '@/lib/mix-jobs'

interface SoundMember { email: string; name: string | null }

interface Job {
  id: string
  number: number
  code: string
  title: string
  bookingId: string | null
  bookingCode: string | null
  requesterEmail: string
  assigneeEmail: string | null
  dueDate: string | null
  status: string
  deliveredAt: string | null
  sourceLink: string | null
  notes: string | null
  assignedByEmail: string | null
  deliveryLink: string | null
  flag: MixFlag
}

interface Me { email: string; isSound: boolean; isCoordinator: boolean; canEditAll: boolean; canCreate: boolean }

const SCOPES = [
  { key: 'open', label: 'คิวปัจจุบัน' },
  { key: 'mine', label: 'ของฉัน' },
  { key: 'all', label: 'ทั้งหมด' },
] as const

const FLAG_STYLE: Record<Exclude<MixFlag, null>, string> = {
  OVERDUE: 'bg-red-50 text-red-700 border-red-200',
  DUE_SOON: 'bg-amber-50 text-amber-700 border-amber-200',
  UNCLAIMED: 'bg-slate-50 text-slate-600 border-slate-200',
}

const STATUS_STYLE: Record<string, string> = {
  QUEUED: 'bg-slate-100 text-slate-700',
  IN_PROGRESS: 'bg-blue-50 text-blue-700',
  DONE: 'bg-green-50 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-400 line-through',
}

export default function MixQueuePage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [soundTeam, setSoundTeam] = useState<SoundMember[]>([])
  const [scope, setScope] = useState<'open' | 'mine' | 'all'>('open')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async (s: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/mix?scope=${s}`)
      // v1.210 บทเรียน: `res.ok ? json : []` ทำให้ error หน้าตาเหมือน "ไม่มีข้อมูล"
      // แล้วคนเชื่อว่าคิวว่าง ทั้งที่จริงคือโหลดไม่ได้ — แยกสองอย่างนี้ให้ขาด
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `โหลดไม่สำเร็จ (${res.status})`)
      }
      const data = await res.json()
      setJobs(data.jobs || [])
      setMe(data.me || null)
      setSoundTeam(data.soundTeam || [])
    } catch (e: any) {
      setError(e?.message || 'โหลดคิวไม่สำเร็จ')
      setJobs([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(scope) }, [scope, load])

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(id)
    setError(null)
    try {
      const res = await fetch(`/api/mix/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'บันทึกไม่สำเร็จ')
      await load(scope)
    } catch (e: any) {
      setError(e?.message || 'บันทึกไม่สำเร็จ')
    } finally {
      setBusy(null)
    }
  }

  /**
   * v1.217 — ปิดงานต้องมาพร้อมลิงก์ไฟล์เสมอ
   *
   * ถามที่นี่แทนที่จะปล่อยให้เซิร์ฟเวอร์ปฏิเสธแล้วค่อยบอก: คนกดปุ่มนี้กำลังจะจบงาน
   * การเจอ error หลังกดคือการทำให้เขารู้สึกว่าทำผิด ทั้งที่แค่ยังไม่ได้บอกที่อยู่ไฟล์
   * (เซิร์ฟเวอร์ยังบังคับซ้ำอยู่ — ที่นี่คือความสุภาพ ไม่ใช่ด่านความปลอดภัย)
   */
  async function finish(job: Job) {
    const existing = job.deliveryLink || ''
    const link = window.prompt(
      'วางลิงก์ไฟล์ที่มิกซ์เสร็จ (โฟลเดอร์ไดรฟ์ก็ได้)\nคนขอจะได้เมลพร้อมลิงก์นี้ทันที',
      existing,
    )
    if (link === null) return          // กด Cancel = ไม่ทำอะไร
    if (!link.trim()) {
      setError('ต้องมีลิงก์ไฟล์ก่อนปิดงาน — ไม่งั้นคนขอไม่รู้ว่าไปหยิบที่ไหน')
      return
    }
    await act(job.id, { deliveryLink: link.trim(), status: 'DONE' })
  }

  async function remove(id: string, code: string) {
    if (!confirm(`ลบคำขอ ${code}?`)) return
    setBusy(id)
    try {
      const res = await fetch(`/api/mix/${id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'ลบไม่สำเร็จ')
      await load(scope)
    } catch (e: any) {
      setError(e?.message || 'ลบไม่สำเร็จ')
    } finally {
      setBusy(null)
    }
  }

  const actor: MixActor | null = me
    ? { email: me.email, isSound: me.isSound, isCoordinator: me.isCoordinator, canEditAll: me.canEditAll }
    : null

  const open = jobs.filter(j => j.status === 'QUEUED' || j.status === 'IN_PROGRESS')
  const unclaimed = open.filter(j => !j.assigneeEmail).length
  const overdue = jobs.filter(j => j.flag === 'OVERDUE').length

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <header className="mb-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-medium text-gray-800">🎚 คิวงานมิกซ์เสียง</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              ขอมิกซ์ที่นี่แทนการทักในแชท — ทีมเสียงจะเห็นคิวทั้งหมดในที่เดียว
            </p>
          </div>
          <button
            onClick={() => setShowForm(v => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-gray-900 text-white hover:bg-gray-800"
          >
            {showForm ? <X size={15} /> : <Plus size={15} />}
            {showForm ? 'ปิด' : 'ขอมิกซ์'}
          </button>
        </div>

        {open.length > 0 && (
          <div className="mt-3 flex gap-4 text-sm text-gray-600">
            <span>กำลังอยู่ในคิว <b className="text-gray-900">{open.length}</b> งาน</span>
            {unclaimed > 0 && <span>ยังไม่มีคนรับ <b className="text-slate-700">{unclaimed}</b></span>}
            {overdue > 0 && <span className="text-red-600">เลยกำหนด <b>{overdue}</b></span>}
          </div>
        )}
      </header>

      {showForm && <MixRequestForm onDone={() => { setShowForm(false); load(scope) }} />}

      <div className="flex gap-1 mb-3">
        {SCOPES.map(s => (
          <button
            key={s.key}
            onClick={() => setScope(s.key)}
            className={`px-3 py-1.5 text-sm rounded-md ${
              scope === s.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-gray-400">
          <Loader2 className="animate-spin mx-auto mb-2" size={22} />
          กำลังโหลดคิว…
        </div>
      ) : error ? (
        /* โหลดไม่สำเร็จ = ไม่รู้ว่ามีอะไรอยู่ ไม่ใช่รู้ว่าไม่มีอะไร — ห้ามขึ้น empty
         * state คู่กับ error เด็ดขาด เพราะคนอ่านจะสรุปว่าคิวว่างแล้วเดินจากไป
         * (เคสจริง PP-26-039: งานมี 15 ตอน แต่หน้าขึ้นว่าไม่มี episode เพราะ
         *  error ถูกกลืนเป็นลิสต์ว่าง) · เจอซ้ำตอนเปิดหน้านี้ครั้งแรกใน dev
         * ที่ไม่มี DB: แบนเนอร์ error กับ "ยังไม่มีคำขอ" ขึ้นพร้อมกัน */
        <div className="py-10 text-center text-sm text-gray-500">
          ยังไม่รู้ว่าคิวมีอะไรบ้าง เพราะโหลดไม่สำเร็จ
          <button onClick={() => load(scope)} className="gf-link ml-2">ลองใหม่</button>
        </div>
      ) : jobs.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">
          {/* ข้อความต่างกันตาม scope — "ยังไม่มีใครขอ" กับ "คุณยังไม่มีงาน" คนละเรื่อง */}
          {scope === 'mine' ? 'คุณยังไม่มีงานมิกซ์ในระบบ' : 'ยังไม่มีคำขอมิกซ์ในคิว'}
        </div>
      ) : (
        <ul className="space-y-2">
          {jobs.map(job => (
            <li key={job.id} className="border border-gray-200 rounded-lg p-3 bg-white">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs text-gray-400">{job.code}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_STYLE[job.status] || ''}`}>
                      {MIX_STATUS_LABEL[job.status as MixStatus] || job.status}
                    </span>
                    {job.flag && (
                      <span className={`text-xs px-1.5 py-0.5 rounded border ${FLAG_STYLE[job.flag]}`}>
                        {MIX_FLAG_LABEL[job.flag]}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-sm font-medium text-gray-800 break-words">{job.title}</div>
                  <div className="mt-1 text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
                    {job.bookingCode && <span>งาน {job.bookingCode}</span>}
                    {job.dueDate && (
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} /> ส่ง {job.dueDate.slice(0, 10)}
                      </span>
                    )}
                    <span>ขอโดย {job.requesterEmail.split('@')[0]}</span>
                    <span>
                      {job.assigneeEmail
                        ? `มิกซ์โดย ${job.assigneeEmail.split('@')[0]}${job.assignedByEmail ? ` (แจกโดย ${job.assignedByEmail.split('@')[0]})` : ' (หยิบเอง)'}`
                        : 'รอ coordinator แจกงาน'}
                    </span>
                  </div>
                  <div className="flex gap-3 mt-1">
                    {job.sourceLink && (
                      <a href={job.sourceLink} target="_blank" rel="noreferrer" className="gf-link text-xs">
                        ไฟล์ต้นทาง →
                      </a>
                    )}
                    {job.deliveryLink && (
                      <a href={job.deliveryLink} target="_blank" rel="noreferrer" className="gf-link text-xs font-medium text-green-700">
                        ไฟล์ที่มิกซ์แล้ว →
                      </a>
                    )}
                  </div>
                  {job.notes && <p className="mt-1 text-xs text-gray-500 whitespace-pre-wrap">{job.notes}</p>}
                </div>

                {actor && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {busy === job.id && <Loader2 className="animate-spin text-gray-400" size={15} />}
                    {/* v1.216 — coordinator แจกงาน: เส้นทางหลักที่ operator ออกแบบ
                      * รายชื่อมาจาก roster ชุดเดียวกับที่ route ใช้ตรวจ ไม่งั้น
                      * dropdown จะโชว์คนที่ฝั่งเซิร์ฟเวอร์ปฏิเสธ */}
                    {canAssignMixJob(actor, job) && soundTeam.length > 0 && (
                      <select
                        value={job.assigneeEmail || ''}
                        disabled={busy === job.id}
                        onChange={e => e.target.value && act(job.id, { assigneeEmail: e.target.value })}
                        className="px-2 py-1 text-xs border border-gray-300 rounded bg-white disabled:opacity-50"
                        title="มอบหมายให้ทีมงาน"
                      >
                        <option value="">— แจกงานให้ —</option>
                        {soundTeam.map(m => (
                          <option key={m.email} value={m.email}>
                            {m.name || m.email.split('@')[0]}
                          </option>
                        ))}
                      </select>
                    )}
                    {/* หยิบเอง — ทางสำรองตอน coordinator ไม่อยู่ ไม่ใช่เส้นทางหลัก */}
                    {canClaimMixJob(actor, job) && !canAssignMixJob(actor, job) && (
                      <button
                        onClick={() => act(job.id, { claim: true })}
                        disabled={busy === job.id}
                        className="px-2.5 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        รับงานเอง
                      </button>
                    )}
                    {canSetMixStatus(actor, job, 'DONE') && job.status === 'IN_PROGRESS' && (
                      <button
                        onClick={() => finish(job)}
                        disabled={busy === job.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        <Check size={12} /> ส่งแล้ว
                      </button>
                    )}
                    {canSetMixStatus(actor, job, 'CANCELLED') && (
                      <button
                        onClick={() => act(job.id, { status: 'CANCELLED' })}
                        disabled={busy === job.id}
                        className="px-2.5 py-1 text-xs rounded bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
                      >
                        ยกเลิก
                      </button>
                    )}
                    {canEditMixJob(actor, job) && (
                      <button
                        onClick={() => remove(job.id, job.code)}
                        disabled={busy === job.id}
                        title="ลบคำขอ"
                        className="p-1 text-gray-300 hover:text-red-500 disabled:opacity-50"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
