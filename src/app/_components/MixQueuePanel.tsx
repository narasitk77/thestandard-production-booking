'use client'

/**
 * v1.244 — คิวงานมิกซ์ ใช้สองที่: หน้า /mix (ทุกคน) และแท็บ "คิว Mixing" ในหน้าแอดมิน (Sound Admin)
 *
 * แยกเป็นแท็บของตัวเองในแอดมิน ไม่ปนกับคิวถ่ายทำ — ใบจองถ่ายกับคำขอมิกซ์คนละวงจร คนละคนแจก
 * ถ้ารวมลิสต์เดียว Sound Admin ต้องไล่ข้ามใบถ่ายทำเพื่อหางานของตัวเอง และแอดมินถ่ายทำก็เห็นของที่ไม่ใช่งานเขา
 *
 * หลังกดปุ่มบนการ์ด แถวถูกแทนที่ด้วยค่าที่เซิร์ฟเวอร์ตอบกลับ ไม่ใช่รีโหลดทั้งคิว: งานที่เพิ่ง
 * Completed จะหลุดจากแท็บ "คิวปัจจุบัน" ทันทีถ้ารีโหลด แล้วผลแจ้งเตือนบนการ์ด ("แจ้งอีเมลถึง … แล้ว"
 * หรือ "อีเมลไม่ออก") ก็หายไปกับการ์ดก่อนที่คนกดจะได้อ่าน
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CalendarDays, List, Loader2, Plus, X } from 'lucide-react'
import MixRequestForm from '@/app/_components/MixRequestForm'
import MixJobCard, { type MixJobView, type MixActResult, type SoundMember } from '@/app/_components/MixJobCard'
import { MixLoadCalendar } from '@/app/_components/MixLoadCalendar'
import { MIX_STATUS_LABEL, mixFlag, type MixActor } from '@/lib/mix-jobs'

export interface MixQueuePanelProps {
  /** 'page' = หน้า /mix (ทุกคน) · 'admin' = แท็บ "คิว Mixing" ในหน้าแอดมิน (Sound Admin) */
  variant: 'page' | 'admin'
  initialScope?: 'open' | 'mine' | 'all'
}

type Scope = 'open' | 'mine' | 'all'

interface Me { email: string; isSound: boolean; isCoordinator: boolean; canEditAll: boolean; canCreate: boolean }

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'open', label: 'คิวปัจจุบัน' },
  { key: 'mine', label: 'ของฉัน' },
  { key: 'all', label: 'ทั้งหมด' },
]

type Flash = { tone: 'ok' | 'warn' | 'err'; text: string }
const FLASH_STYLE: Record<Flash['tone'], string> = {
  ok: 'bg-green-50 border-green-200 text-green-800',
  warn: 'bg-amber-50 border-amber-300 text-amber-800',
  err: 'bg-red-50 border-red-200 text-red-700',
}

export default function MixQueuePanel({ variant, initialScope = 'open' }: MixQueuePanelProps) {
  const isAdmin = variant === 'admin'
  const [scope, setScope] = useState<Scope>(initialScope)
  const [loadedScope, setLoadedScope] = useState<Scope | null>(null)
  const [jobs, setJobs] = useState<MixJobView[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [soundTeam, setSoundTeam] = useState<SoundMember[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [view, setView] = useState<'list' | 'calendar'>('list')
  // Sound Admin เปิดแท็บนี้มาเพื่อแจกงาน → งานที่ยังไม่แจกขึ้นก่อน
  const [queuedFirst, setQueuedFirst] = useState(isAdmin)
  const [focusId, setFocusId] = useState<string | null>(null)
  // เรียง "Requested ก่อน" ตามสถานะ **ตอนโหลด** ไม่ใช่สถานะปัจจุบัน: กด Assign แล้วการ์ดต้องอยู่ที่เดิม
  // ไม่งั้นมันกระโดดไปท้ายกลุ่ม แล้วผลแจ้งเตือนบนการ์ดก็หลุดจากจุดที่เพิ่งกด (ผู้ตรวจเจอ)
  const [queuedAtLoad, setQueuedAtLoad] = useState<Set<string>>(new Set())
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // สลับแท็บเร็ว ๆ แล้วคำตอบเก่ามาถึงทีหลัง = ลิสต์ของแท็บหนึ่งโชว์ใต้ชื่ออีกแท็บ
  const seq = useRef(0)

  const load = useCallback(async (s: Scope) => {
    const my = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/mix?scope=${s}`)
      // error ≠ ความว่างเปล่า (bug-classes #2): โหลดไม่ได้ต้องไม่หน้าตาเหมือน "คิวว่าง"
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `โหลดคิวไม่สำเร็จ (${res.status})`)
      }
      const data = await res.json()
      if (my !== seq.current) return
      if (!Array.isArray(data.jobs)) throw new Error('คำตอบจากเซิร์ฟเวอร์ไม่มีรายการงาน')
      setJobs(data.jobs)
      setQueuedAtLoad(new Set(data.jobs.filter((j: MixJobView) => j.status === 'QUEUED').map((j: MixJobView) => j.id)))
      setMe(data.me || null)
      setSoundTeam(Array.isArray(data.soundTeam) ? data.soundTeam : [])
      setTruncated(!!data.truncated)
      setLoadedScope(s)
    } catch (e: any) {
      if (my !== seq.current) return
      setError(e?.message || 'โหลดคิวไม่สำเร็จ')
      setJobs([])
      setLoadedScope(null)
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load(scope) }, [scope, load])

  const act = useCallback(async (id: string, body: Record<string, unknown>): Promise<MixActResult> => {
    setBusy(id)
    try {
      const res = await fetch(`/api/mix/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) return { ok: false, error: data?.error || `บันทึกไม่สำเร็จ (${res.status})` }
      if (data?.job) {
        setJobs(prev => prev.map(j => (j.id === id ? { ...j, ...data.job, flag: mixFlag(data.job) } : j)))
      } else {
        load(scope) // บันทึกแล้วแต่อ่านแถวใหม่ไม่ได้ → ดึงของจริงมาแทนการเดา
      }
      // ไม่มีคีย์ notified = อ่านผลไม่ได้ (undefined) · null = การกระทำนี้ไม่ส่งเมล
      return { ok: true, notified: data && 'notified' in data ? data.notified : undefined }
    } catch (e: any) {
      return { ok: false, error: e?.message ? `บันทึกไม่สำเร็จ: ${e.message}` : 'บันทึกไม่สำเร็จ — เช็กเน็ตแล้วลองใหม่' }
    } finally {
      setBusy(null)
    }
  }, [load, scope])

  async function remove(job: MixJobView) {
    if (!confirm(`ลบคำขอ ${job.code}?`)) return
    setBusy(job.id)
    setFlash(null)
    try {
      const res = await fetch(`/api/mix/${job.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `ลบไม่สำเร็จ (${res.status})`)
      setJobs(prev => prev.filter(j => j.id !== job.id))
      setFlash({ tone: 'ok', text: `ลบ ${job.code} แล้ว` })
    } catch (e: any) {
      setFlash({ tone: 'err', text: e?.message || 'ลบไม่สำเร็จ' })
    } finally {
      setBusy(null)
    }
  }

  // คลิกงานในปฏิทิน → กลับมามุมมองรายการแล้วเลื่อนไปการ์ดนั้น · ถ้าไม่อยู่ในแท็บนี้ (เช่นส่งแล้ว
  // แต่ดูคิวปัจจุบันอยู่) ขยับไปแท็บทั้งหมด · รอ loadedScope ให้ตรงก่อนตัดสินว่า "ไม่เจอ"
  // ไม่งั้นจะสรุปจากลิสต์ของแท็บเก่าที่ยังค้างอยู่
  useEffect(() => {
    if (!focusId || view !== 'list' || loading || error || loadedScope !== scope) return
    if (jobs.some(j => j.id === focusId)) {
      document.getElementById(`mix-job-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightId(focusId)
      setFocusId(null)
    } else if (scope !== 'all') {
      setScope('all')
    } else {
      setFlash({ tone: 'warn', text: 'หางานนี้ในรายการไม่เจอ — อาจถูกลบไปแล้ว หรือเกินจำนวนที่แสดง' })
      setFocusId(null)
    }
  }, [focusId, view, loading, error, loadedScope, scope, jobs])

  useEffect(() => {
    if (!highlightId) return
    const t = setTimeout(() => setHighlightId(null), 2500)
    return () => clearTimeout(t)
  }, [highlightId])

  const openJob = useCallback((id: string) => {
    setView('list')
    setFocusId(id)
  }, [])

  const actor: MixActor | null = me
    ? { email: me.email, isSound: me.isSound, isCoordinator: me.isCoordinator, canEditAll: me.canEditAll }
    : null

  const queued = jobs.filter(j => j.status === 'QUEUED').length
  const assigned = jobs.filter(j => j.status === 'IN_PROGRESS').length
  const overdue = jobs.filter(j => j.flag === 'OVERDUE').length
  // Array.sort เสถียร → ในแต่ละกลุ่มยังเรียงตามลำดับของเซิร์ฟเวอร์ (compareMixQueue: กำหนดส่งก่อน)
  const shown = queuedFirst
    ? [...jobs].sort((a, b) => Number(queuedAtLoad.has(b.id)) - Number(queuedAtLoad.has(a.id)))
    : jobs
  const listReady = !loading && !error && loadedScope === scope

  return (
    <div className={isAdmin ? '' : 'max-w-4xl mx-auto px-4 py-6'}>
      <header className="mb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            {isAdmin ? (
              <>
                <h2 className="text-lg font-medium text-gray-800">🎚 คิว Mixing</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  คำขอมิกซ์เสียง แยกจากคิวถ่ายทำ — เลือกคนในทีมเสียงแล้วกด Assign ระบบส่งอีเมลแจ้งคนทำและคนขอ
                </p>
              </>
            ) : (
              <>
                <h1 className="text-xl font-medium text-gray-800">🎚 คิวงานมิกซ์เสียง</h1>
                <p className="text-sm text-gray-500 mt-0.5">
                  ขอมิกซ์ที่นี่แทนการทักในแชท — ทีมเสียงจะเห็นคิวทั้งหมดในที่เดียว
                </p>
              </>
            )}
          </div>
          {/* ปุ่มขอมิกซ์ไม่ผูกกับการโหลดคิว — คิวโหลดไม่ขึ้นก็ยังต้องขอได้ (bug-classes #2: ปุ่มต้องไม่หายไปกับ error) */}
          {me?.canCreate !== false && (
            <button
              onClick={() => setShowForm(v => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md bg-gray-900 text-white hover:bg-gray-800"
            >
              {showForm ? <X size={15} /> : <Plus size={15} />}
              {showForm ? 'ปิด' : 'ขอมิกซ์'}
            </button>
          )}
        </div>

        {listReady && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
            {scope === 'mine' && <span className="text-gray-400">ของฉัน:</span>}
            <span>{MIX_STATUS_LABEL.QUEUED} รอแจก <b className="text-gray-900">{queued}</b></span>
            <span>{MIX_STATUS_LABEL.IN_PROGRESS} <b className="text-blue-700">{assigned}</b></span>
            <span className={overdue > 0 ? 'text-red-600' : ''}>เลยกำหนด <b>{overdue}</b></span>
          </div>
        )}
      </header>

      {showForm && (
        <MixRequestForm
          onDone={({ code, notifiedTo, notifyReason }) => {
            setShowForm(false)
            setFlash(notifiedTo.length > 0
              ? { tone: 'ok', text: `ส่งคำขอ ${code} แล้ว · แจ้งอีเมลถึง ${notifiedTo.join(', ')}` }
              : { tone: 'warn', text: `ส่งคำขอ ${code} เข้าคิวแล้ว แต่อีเมลแจ้ง Sound Admin ไม่ออก (${notifyReason || 'ไม่ทราบสาเหตุ'}) — ทักบอกทีมเสียงด้วย` })
            load(scope)
          }}
        />
      )}

      {flash && (
        <div className={`mb-3 px-3 py-2 rounded-md border text-sm flex items-start gap-2 ${FLASH_STYLE[flash.tone]}`}>
          <span className="flex-1 break-words">{flash.text}</span>
          <button onClick={() => setFlash(null)} className="shrink-0 opacity-60 hover:opacity-100" title="ปิด">
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── มุมมอง + แท็บ ── */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
          <button
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm ${view === 'list' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            <List size={14} /> รายการ
          </button>
          <button
            onClick={() => setView('calendar')}
            aria-pressed={view === 'calendar'}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm border-l border-gray-200 ${view === 'calendar' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            <CalendarDays size={14} /> ปฏิทิน
          </button>
        </div>

        {view === 'list' && (
          <div className="flex gap-1 flex-wrap">
            {SCOPES.map(s => (
              <button
                key={s.key}
                onClick={() => setScope(s.key)}
                aria-pressed={scope === s.key}
                className={`px-3 py-1.5 text-sm rounded-md ${
                  scope === s.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        {view === 'list' && isAdmin && (
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 ml-auto cursor-pointer">
            <input type="checkbox" checked={queuedFirst} onChange={e => setQueuedFirst(e.target.checked)} />
            {MIX_STATUS_LABEL.QUEUED} (ยังไม่แจก) ขึ้นก่อน
          </label>
        )}
      </div>

      {view === 'calendar' ? (
        <MixLoadCalendar showAssigneeLoad={isAdmin} onOpenJob={openJob} />
      ) : loading ? (
        <div className="py-16 text-center text-gray-400">
          <Loader2 className="animate-spin mx-auto mb-2" size={22} />
          กำลังโหลดคิว…
        </div>
      ) : error ? (
        /* โหลดไม่สำเร็จ = ไม่รู้ว่ามีอะไร ไม่ใช่รู้ว่าไม่มีอะไร — ห้ามขึ้น empty state คู่กับ error
         * (PP-26-039: งานมี 15 ตอน แต่หน้าขึ้นว่าไม่มี episode เพราะ error ถูกกลืนเป็นลิสต์ว่าง) */
        <div className="p-4 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{error} — ยังไม่รู้ว่าคิวมีอะไรบ้าง</span>
          </div>
          <button
            onClick={() => load(scope)}
            className="mt-2 px-3 py-1.5 text-sm rounded-md bg-white border border-red-300 text-red-700 hover:bg-red-100"
          >
            ลองใหม่
          </button>
        </div>
      ) : jobs.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">
          {/* "ยังไม่มีใครขอ" กับ "คุณยังไม่มีงาน" คนละเรื่อง */}
          {scope === 'mine' ? 'คุณยังไม่มีงานมิกซ์ในระบบ' : scope === 'open' ? 'ไม่มีงานมิกซ์ค้างในคิว' : 'ยังไม่มีคำขอมิกซ์'}
        </div>
      ) : (
        <>
          {truncated && (
            <div className="mb-2 px-3 py-2 rounded-md border bg-amber-50 border-amber-300 text-xs text-amber-800">
              แสดงเฉพาะรายการล่าสุดตามเพดานของระบบ — ตัวเลขด้านบนนับจากที่แสดงเท่านั้น อาจไม่ครบ
            </div>
          )}
          <ul className="space-y-2">
            {shown.map(job => (
              <li
                key={job.id}
                id={`mix-job-${job.id}`}
                className={`scroll-mt-24 rounded-lg transition-shadow ${highlightId === job.id ? 'ring-2 ring-blue-400' : ''}`}
              >
                {actor && (
                  <MixJobCard
                    job={job}
                    actor={actor}
                    soundTeam={soundTeam}
                    busy={busy === job.id}
                    onAct={body => act(job.id, body)}
                    onRemove={() => remove(job)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
