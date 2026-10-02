'use client'

/**
 * v1.244 — การ์ดงานมิกซ์ 1 ใบ ใช้ทั้งหน้า /mix และแท็บ "คิว Mixing" ในหน้าแอดมิน
 *
 * ปุ่มทุกปุ่มถามสิทธิ์จาก @/lib/mix-jobs ที่เดียว (ชุดเดียวกับที่ route ใช้ตรวจ) — ห้ามตัดสิน
 * สิทธิ์เองในไฟล์นี้ ไม่งั้นปุ่มจะโผล่ให้กดแล้วโดนปฏิเสธ หรือกลับกันคือทำได้แต่ไม่มีปุ่ม
 * (bug-classes #10)
 *
 * ปุ่มที่ส่งเมล (แจกงาน · ส่งงาน) ต้องเป็นการกดยืนยันเสมอ ไม่ยิงตอน onChange — เลือกคนผิด
 * ใน dropdown แล้วเมลออกไปถึงคนผิดทันทีคือสิ่งที่ถอนคืนไม่ได้
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Clock, ExternalLink, Loader2, Pencil, RotateCcw, Send, Trash2, UserPlus } from 'lucide-react'
import {
  MIX_STATUS_LABEL, MIX_STATUS_HINT, MIX_FLAG_LABEL, bangkokDateKey, canAssignMixJob, canClaimMixJob,
  canEditMixJob, canDeleteMixJob, canSetMixStatus, normalizeHttpLink, type MixActor, type MixFlag, type MixStatus,
} from '@/lib/mix-jobs'

/** แถวจาก GET /api/mix (วันที่เป็นสตริง ISO หลังผ่าน JSON) */
export interface MixJobView {
  id: string
  number: number
  code: string
  title: string
  bookingId: string | null
  bookingCode: string | null
  episodeRowId: string | null
  episodeCode: string | null
  requesterEmail: string
  assigneeEmail: string | null
  assignedByEmail: string | null
  claimedAt: string | null
  dueDate: string | null
  status: string
  deliveredAt: string | null
  sourceLink: string | null
  deliveryLink: string | null
  notes: string | null
  createdAt: string
  flag: MixFlag
  /** v1.245 — ซิงก์ปฏิทินมิกซ์ครั้งล่าสุดล้มเพราะอะไร (null = ผ่าน / ปิดอยู่) */
  calendarSyncError?: string | null
  /** v1.256 — Producer ของใบจองที่ผูกไว้ (GET เติมให้) · ใช้ตัดสินปุ่ม "แก้ไข" ด้วยกฎเดียวกับ PATCH */
  bookingProducerEmail?: string | null
}

export interface MixNotified { sent: boolean; to: string[]; reason?: string }

/**
 * notified: object = มีการแจ้งเตือน (ดู sent) · null = การกระทำนี้ไม่ส่งเมล ·
 * undefined = บันทึกสำเร็จแต่อ่านผลการแจ้งเตือนไม่ได้ — ห้ามเดาว่าส่งแล้ว
 */
export interface MixActResult { ok: boolean; error?: string; notified?: MixNotified | null }

export interface SoundMember { email: string; name: string | null }

export interface MixJobCardProps {
  job: MixJobView
  actor: MixActor
  soundTeam: SoundMember[]
  busy: boolean
  onAct: (body: Record<string, unknown>) => Promise<MixActResult>
  onRemove: () => void
}

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

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const short = (email: string) => email.split('@')[0]

/** dueDate เป็น @db.Date = เที่ยงคืน UTC ของวันนั้น → อ่านเป็น UTC ไม่งั้นวันเลื่อนได้ */
function dueLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString('th-TH-u-ca-gregory', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

function whenLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('th-TH-u-ca-gregory', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })
}

type Notice = { tone: 'ok' | 'warn' | 'err'; text: string }

type EditDraft = { title: string; dueDate: string; sourceLink: string; notes: string }
const EDIT_INPUT = 'w-full min-w-0 px-2.5 py-1.5 text-sm border border-gray-300 rounded-md bg-white'

const NOTICE_STYLE: Record<Notice['tone'], string> = {
  ok: 'bg-green-50 border-green-200 text-green-800',
  warn: 'bg-amber-50 border-amber-300 text-amber-800',
  err: 'bg-red-50 border-red-200 text-red-700',
}

/** ผลที่บอกบนการ์ด — ตามที่เซิร์ฟเวอร์ตอบจริง ไม่ใช่ตามที่ตั้งใจ (bug-classes #1) */
function noticeFrom(r: MixActResult): Notice {
  if (!r.ok) return { tone: 'err', text: r.error || 'บันทึกไม่สำเร็จ' }
  if (r.notified === undefined) return { tone: 'warn', text: 'บันทึกแล้ว แต่อ่านผลการแจ้งเตือนไม่ได้ — รีเฟรชแล้วเช็กอีกครั้ง' }
  if (r.notified === null) return { tone: 'ok', text: 'บันทึกแล้ว' }
  if (r.notified.sent) return { tone: 'ok', text: `แจ้งอีเมลถึง ${r.notified.to.join(', ')} แล้ว` }
  return { tone: 'warn', text: `บันทึกแล้ว แต่อีเมลไม่ออก: ${r.notified.reason || 'ไม่ทราบสาเหตุ'} — ทักบอกเองด้วย` }
}

export default function MixJobCard({ job, actor, soundTeam, busy, onAct, onRemove }: MixJobCardProps) {
  const status = (job.status || 'QUEUED') as MixStatus
  const currentMember = soundTeam.find(m => same(m.email, job.assigneeEmail))?.email ?? ''
  const [pick, setPick] = useState(currentMember)
  const [link, setLink] = useState(job.deliveryLink || '')
  const [linkErr, setLinkErr] = useState<string | null>(null)
  const [deliverOpen, setDeliverOpen] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  // คนทำเปลี่ยนจากที่อื่น (แจกใหม่/รีโหลด) → dropdown ต้องตามของจริง ไม่ค้างค่าที่เลือกไว้
  useEffect(() => { setPick(currentMember) }, [currentMember])
  useEffect(() => { setLink(job.deliveryLink || '') }, [job.deliveryLink])

  const nameOf = (email: string) => soundTeam.find(m => same(m.email, email))?.name || short(email)
  const isAssignee = same(job.assigneeEmail, actor.email)
  const canAssign = canAssignMixJob(actor, job)
  const canClaim = canClaimMixJob(actor, job) && !canAssign
  const canDeliver = status === 'IN_PROGRESS' && canSetMixStatus(actor, job, 'DONE')
  const canReopen = status === 'DONE' && canSetMixStatus(actor, job, 'IN_PROGRESS')
  // canTransition ยอม X→X (บันทึกซ้ำไม่พัง) → ต้องกันสถานะปัจจุบันเอง ไม่งั้นการ์ดที่ยกเลิกแล้วมีปุ่มยกเลิก
  const canCancel = status !== 'CANCELLED' && canSetMixStatus(actor, job, 'CANCELLED')
  const canDelete = canDeleteMixJob(actor, job) // v1.250 — กฎเดียวกับ route DELETE
  const canEdit = canEditMixJob(actor, job) // v1.256 — กฎเดียวกับ route PATCH (แก้รายละเอียด)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [editErr, setEditErr] = useState<string | null>(null)
  const original: EditDraft = {
    title: job.title, dueDate: job.dueDate?.slice(0, 10) ?? '', sourceLink: job.sourceLink ?? '', notes: job.notes ?? '',
  }
  const today = bangkokDateKey()

  async function run(body: Record<string, unknown>) {
    setNotice(null)
    const r = await onAct(body)
    setNotice(noticeFrom(r))
    return r
  }

  async function assign() {
    if (!pick || same(pick, job.assigneeEmail)) return
    await run({ assigneeEmail: pick })
  }

  async function deliver(e: React.FormEvent) {
    e.preventDefault()
    // ตรวจก่อนส่งด้วยฟังก์ชันเดียวกับเซิร์ฟเวอร์ — เซิร์ฟเวอร์ยังตรวจซ้ำ ที่นี่คือความสุภาพ
    const clean = normalizeHttpLink(link)
    if (!clean) {
      setLinkErr(link.trim() ? 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://' : 'วางลิงก์ไฟล์ที่มิกซ์เสร็จก่อนส่งงาน')
      return
    }
    setLinkErr(null)
    const r = await run({ deliveryLink: clean, status: 'DONE' })
    if (r.ok) setDeliverOpen(false)
  }

  async function reopen() {
    if (!confirm(`เปิด ${job.code} กลับเป็น ${MIX_STATUS_LABEL.IN_PROGRESS}? (วันที่ส่งจะถูกล้าง ส่งใหม่ได้ภายหลัง)`)) return
    await run({ status: 'IN_PROGRESS' })
  }

  function startEdit() {
    setNotice(null)
    setEditErr(null)
    setDraft(original)
  }

  // v1.256 — ส่งเฉพาะช่องที่เปลี่ยน: ประวัติ (changes.edited) บอกได้ว่าแก้อะไรจริง
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!draft) return
    if (draft.sourceLink.trim() && !normalizeHttpLink(draft.sourceLink)) {
      setEditErr('ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://')
      return
    }
    const keys = (Object.keys(draft) as (keyof EditDraft)[]).filter(k => draft[k].trim() !== original[k].trim())
    if (keys.length === 0) { setDraft(null); return }
    setEditErr(null)
    const r = await run(Object.fromEntries(keys.map(k => [k, draft[k]])))
    if (r.ok) setDraft(null)
  }

  async function cancel() {
    if (!confirm(`ยกเลิกคำขอ ${job.code}?`)) return
    await run({ status: 'CANCELLED' })
  }

  const showDeliverForm = canDeliver && (isAssignee || deliverOpen)

  return (
    <div className={`border rounded-lg p-3 bg-white ${canDeliver && isAssignee ? 'border-green-300' : 'border-gray-200'}`}>
      {/* ── หัวการ์ด ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-gray-400">{job.code}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_STYLE[status] || ''}`}>
          {MIX_STATUS_LABEL[status] || job.status}
        </span>
        {MIX_STATUS_HINT[status] && <span className="text-xs text-gray-400">{MIX_STATUS_HINT[status]}</span>}
        {job.flag && (
          <span className={`text-xs px-1.5 py-0.5 rounded border ${FLAG_STYLE[job.flag]}`}>{MIX_FLAG_LABEL[job.flag]}</span>
        )}
        {busy && <Loader2 className="animate-spin text-gray-400 ml-auto" size={14} />}
      </div>

      <div className="mt-1 text-sm font-medium text-gray-800 break-words">{job.title}</div>

      {/* ── รายละเอียด ── */}
      <div className="mt-1 text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
        {job.bookingCode && (
          job.bookingId
            ? <Link href={`/dashboard/${job.bookingId}`} className="gf-link text-xs font-mono">{job.bookingCode}</Link>
            : <span className="font-mono">{job.bookingCode}</span>
        )}
        {job.episodeCode && <span>ตอน <span className="font-mono">{job.episodeCode}</span></span>}
        {job.dueDate && (
          <span className={`inline-flex items-center gap-1 ${job.flag === 'OVERDUE' ? 'text-red-600' : ''}`}>
            <Clock size={11} /> ต้องการไฟล์ {dueLabel(job.dueDate)}
          </span>
        )}
        <span>ขอโดย {short(job.requesterEmail)}</span>
        {job.assigneeEmail ? (
          <span>
            มิกซ์โดย <b className="font-medium text-gray-700">{nameOf(job.assigneeEmail)}</b>
            {job.assignedByEmail ? ` · แจกโดย ${short(job.assignedByEmail)}` : ' · หยิบเอง'}
          </span>
        ) : status === 'QUEUED' ? (
          <span>ยังไม่มีคนมิกซ์</span>
        ) : null}
      </div>

      {job.sourceLink && (
        <a href={job.sourceLink} target="_blank" rel="noreferrer" className="gf-link text-xs inline-flex items-center gap-1 mt-1">
          ไฟล์ต้นทาง <ExternalLink size={11} />
        </a>
      )}
      {job.notes && <p className="mt-1 text-xs text-gray-500 whitespace-pre-wrap break-words">{job.notes}</p>}
      {/* v1.245 — ซิงก์ปฏิทินมิกซ์ล้ม: โชว์ให้คนที่แก้ได้ (Sound Admin/แอดมิน) — ปฏิทินที่ผิดโดยไม่มีใครรู้
          คือปฏิทินที่คนเลิกเชื่อ · คำขอยังเดินต่อได้ปกติ ไม่ได้ติดที่ปฏิทิน */}
      {job.calendarSyncError && (actor.isCoordinator || actor.canEditAll) && (
        <p className="mt-1 text-[11px] text-amber-700 break-words">
          📅 ปฏิทินมิกซ์ซิงก์ไม่ได้: {job.calendarSyncError}
        </p>
      )}

      {/* ── ส่งแล้ว: ลิงก์ไฟล์คือสิ่งที่คนขอมาหา ── */}
      {status === 'DONE' && (
        <div className="mt-2 p-2 rounded-md bg-green-50 border border-green-200 text-xs text-green-800 flex items-center gap-2 flex-wrap">
          <Check size={13} className="shrink-0" />
          {job.deliveryLink ? (
            <a href={job.deliveryLink} target="_blank" rel="noreferrer" className="font-medium underline break-all">
              ไฟล์ที่มิกซ์แล้ว
            </a>
          ) : <span>ไม่มีลิงก์ไฟล์</span>}
          {job.deliveredAt && <span className="text-green-700">ส่งเมื่อ {whenLabel(job.deliveredAt)}</span>}
          {canReopen && (
            <button
              onClick={reopen} disabled={busy}
              className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-gray-600 hover:bg-green-100 disabled:opacity-50"
            >
              <RotateCcw size={11} /> เปิดแก้อีกครั้ง
            </button>
          )}
        </div>
      )}
      {status !== 'DONE' && job.deliveryLink && (
        <a href={job.deliveryLink} target="_blank" rel="noreferrer" className="gf-link text-xs inline-flex items-center gap-1 mt-1 ml-3">
          ไฟล์ที่มิกซ์ไว้ล่าสุด <ExternalLink size={11} />
        </a>
      )}

      {/* ── ส่งงาน: คนที่ถูกแจกเข้ามาเพื่อทำสิ่งนี้ จึงเปิดไว้ให้เลย ── */}
      {showDeliverForm && (
        <form
          onSubmit={deliver}
          className={`mt-2 p-2.5 rounded-md border ${isAssignee ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}
        >
          <label htmlFor={`mix-deliver-${job.id}`} className="block text-xs font-medium text-gray-700 mb-1">
            {isAssignee ? 'มิกซ์เสร็จแล้ว? วางลิงก์ไฟล์แล้วกดส่งงาน' : 'ส่งงานแทนคนที่ถูกแจก'}
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id={`mix-deliver-${job.id}`}
              value={link}
              onChange={e => { setLink(e.target.value); setLinkErr(null) }}
              placeholder="https://drive.google.com/…"
              inputMode="url"
              className="flex-1 min-w-0 px-2.5 py-1.5 text-sm border border-gray-300 rounded-md bg-white"
            />
            <button
              type="submit" disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              <Send size={13} /> ส่งงาน
            </button>
          </div>
          {linkErr && <p className="mt-1 text-xs text-red-600">{linkErr}</p>}
          <p className="mt-1 text-xs text-gray-500 break-all">
            คนขอ ({job.requesterEmail}) จะได้อีเมลพร้อมลิงก์นี้
            {!isAssignee && (
              <button type="button" onClick={() => setDeliverOpen(false)} className="ml-2 text-gray-400 hover:text-gray-600 underline">
                ปิด
              </button>
            )}
          </p>
        </form>
      )}

      {/* ── v1.256 แก้รายละเอียด (คนขอ/Producer ของใบ ก่อนมีคนรับ · คนถืองาน · แอดมิน) ── */}
      {/* canEdit ซ้ำตรงนี้: งานถูกแจกระหว่างเปิดฟอร์ม → โหลดใหม่แล้วฟอร์มต้องหาย ไม่ค้างให้กดแล้ว 403 วนไป */}
      {draft && canEdit && (
        <form onSubmit={saveEdit} className="mt-2 p-2.5 rounded-md border bg-gray-50 border-gray-200 space-y-2">
          <div>
            <label htmlFor={`mix-edit-title-${job.id}`} className="block text-xs text-gray-500 mb-1">ชื่องานที่จะมิกซ์ *</label>
            <input
              id={`mix-edit-title-${job.id}`} value={draft.title} required maxLength={200}
              onChange={e => setDraft({ ...draft, title: e.target.value })} className={EDIT_INPUT}
            />
          </div>
          <div>
            <label htmlFor={`mix-edit-due-${job.id}`} className="block text-xs text-gray-500 mb-1">
              วันที่ต้องการไฟล์{job.dueDate ? ' *' : ''}
            </label>
            {/* วันเดิมที่เลยมาแล้วต้องยังบันทึกได้ (แก้แค่โน้ต) — min จึงถอยไปที่วันเดิม */}
            <input
              id={`mix-edit-due-${job.id}`} type="date" value={draft.dueDate} required={!!job.dueDate}
              min={original.dueDate && original.dueDate < today ? original.dueDate : today}
              onChange={e => setDraft({ ...draft, dueDate: e.target.value })} className={EDIT_INPUT}
            />
          </div>
          <div>
            <label htmlFor={`mix-edit-src-${job.id}`} className="block text-xs text-gray-500 mb-1">
              ลิงก์ไฟล์ต้นทาง{job.bookingId ? '' : ' *'}
            </label>
            <input
              id={`mix-edit-src-${job.id}`} value={draft.sourceLink} required={!job.bookingId} inputMode="url"
              placeholder="https://drive.google.com/…"
              onChange={e => { setDraft({ ...draft, sourceLink: e.target.value }); setEditErr(null) }} className={EDIT_INPUT}
            />
          </div>
          <div>
            <label htmlFor={`mix-edit-notes-${job.id}`} className="block text-xs text-gray-500 mb-1">โน้ตถึงทีมเสียง</label>
            <textarea
              id={`mix-edit-notes-${job.id}`} value={draft.notes} rows={2} maxLength={4000}
              onChange={e => setDraft({ ...draft, notes: e.target.value })} className={EDIT_INPUT}
            />
          </div>
          {editErr && <p className="text-xs text-red-600">{editErr}</p>}
          <div className="flex gap-1.5">
            <button
              type="submit" disabled={busy}
              className="px-3 py-1.5 text-xs rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
            >
              บันทึก
            </button>
            <button
              type="button" onClick={() => setDraft(null)}
              className="px-3 py-1.5 text-xs rounded-md bg-white border border-gray-300 text-gray-600 hover:bg-gray-100"
            >
              ปิด
            </button>
          </div>
        </form>
      )}

      {/* ── ปุ่มตามสิทธิ์ ── */}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        {canAssign && soundTeam.length > 0 && (
          <>
            <select
              value={pick}
              disabled={busy}
              onChange={e => setPick(e.target.value)}
              className="max-w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white disabled:opacity-50"
              title="เลือกคนในทีมเสียง"
            >
              <option value="">— เลือกคนมิกซ์ —</option>
              {soundTeam.map(m => (
                <option key={m.email} value={m.email}>{m.name || short(m.email)}</option>
              ))}
            </select>
            <button
              onClick={assign}
              disabled={busy || !pick || same(pick, job.assigneeEmail)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40"
            >
              <UserPlus size={12} /> {job.assigneeEmail ? 'เปลี่ยนคน' : 'Assign'}
            </button>
          </>
        )}
        {canAssign && soundTeam.length === 0 && (
          <span className="text-xs text-amber-700">ยังไม่มีรายชื่อทีมเสียงให้แจก — เพิ่มที่ /admin/team</span>
        )}
        {canClaim && (
          <button
            onClick={() => run({ claim: true })} disabled={busy}
            className="px-2.5 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            รับงานเอง
          </button>
        )}
        {canDeliver && !isAssignee && !deliverOpen && (
          <button
            onClick={() => setDeliverOpen(true)} disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-50"
          >
            <Send size={11} /> ส่งงานแทน…
          </button>
        )}
        {canEdit && !draft && (
          <button
            onClick={startEdit} disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <Pencil size={11} /> แก้ไข
          </button>
        )}
        {canCancel && (
          <button
            onClick={cancel} disabled={busy}
            className="px-2.5 py-1 text-xs rounded bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
          >
            ยกเลิก
          </button>
        )}
        {canDelete && (
          <button
            onClick={onRemove} disabled={busy} title="ลบคำขอ"
            className="p-1 text-gray-300 hover:text-red-500 disabled:opacity-50 ml-auto"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {canAssign && pick && !same(pick, job.assigneeEmail) && (
        <p className="mt-1 text-xs text-gray-500">กด {job.assigneeEmail ? 'เปลี่ยนคน' : 'Assign'} แล้ว {nameOf(pick)} จะได้อีเมลแจ้งงาน</p>
      )}

      {notice && (
        <div className={`mt-2 px-2.5 py-1.5 rounded-md border text-xs break-words ${NOTICE_STYLE[notice.tone]}`}>
          {notice.text}
        </div>
      )}
    </div>
  )
}
