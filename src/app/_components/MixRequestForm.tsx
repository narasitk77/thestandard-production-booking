'use client'

/**
 * v1.218 — ฟอร์มขอมิกซ์เสียง ใช้ร่วมกันสองที่ (/mix และ /new?mode=mix)
 *
 * เดิมอยู่ในไฟล์ /mix ที่เดียว พอเพิ่มทางเข้าที่ /new ก็มีทางเลือกสองทาง: ก็อปฟอร์ม
 * ไปอีกที่ หรือแยกออกมา · เลือกแยก เพราะฟอร์มที่ถูกก็อปคือฟอร์มที่จะเพี้ยนออกจากกัน
 * ในอีกหกเดือน แล้วสองทางเข้าจะรับข้อมูลไม่เหมือนกันโดยไม่มีใครรู้
 *
 * v1.244 — เลือกงานได้ 3 แบบ: งานของฉัน (/api/mix/candidates) · ใส่ EP ID / Booking ID
 * (/api/mix/resolve ตรวจก่อนส่ง) · งานเดี่ยวที่ไม่มีใบจอง (บังคับลิงก์)
 *
 * v1.246 — ปุ่ม "ดูปฏิทินคิวทั้งเดือน" ข้างช่องวันที่ เปิดปฏิทินคิวมิกซ์เป็นป๊อปอัป (<dialog> ของ
 * เบราว์เซอร์: Esc ปิด · โฟกัสอยู่ในกล่อง · ไม่ต้องมีไลบรารี) แล้วเลือกวันกลับมาใส่ฟอร์มได้ · อยู่ใน
 * ฟอร์มนี้ที่เดียว จึงขึ้นทั้งหน้า /mix และ /new?mode=mix · วาง <dialog> นอก <form> ไม่งั้นปุ่มใน
 * ปฏิทินที่ลืมใส่ type="button" จะกลายเป็นปุ่มส่งคำขอ
 *
 * กฎที่ห้ามพัง: bookingId/episodeRowId ที่ส่งไปต้องมาจาก **การเลือกหรือผลตรวจล่าสุด** เท่านั้น
 * — แก้ช่องรหัสหลังตรวจ = ผลเดิมถูกล้างทันที จนกว่าจะตรวจใหม่ (เดิม v1.218 ค้นรหัสตอนกดส่ง
 * แล้วผูกใบแรกที่เจอ ซึ่งผูกผิดกองได้เมื่อ EP ID อยู่หลายใบ)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CalendarDays, Check, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react'
import StatusPill from '@/app/_components/StatusPill'
import { MixLoadCalendar, MixLoadStrip } from '@/app/_components/MixLoadCalendar'
import {
  MIX_STATUS_LABEL, MIX_STATUS_HINT, bangkokDateKey, findDuplicateMixJobs, normalizeHttpLink,
  type MixResolution, type MixStatus,
} from '@/lib/mix-jobs'
// type-only — ถูกลบทิ้งตอน compile จึงไม่ลาก prisma เข้า bundle ฝั่ง client แต่ถ้า backend
// เปลี่ยนรูปข้อมูล tsc จะฟ้องที่นี่ แทนที่จะเงียบแล้วหน้าเว็บโชว์ช่องว่าง
import type { MixTargetView, OpenMixJobView } from '@/lib/mix-targets'

type Mode = 'mine' | 'code' | 'solo'

/** undefined = ใบมีหลายตอนแต่ยังไม่ได้เลือก · null = ทั้งใบ · string = แถว Episode (id ภายใน) */
type EpisodeChoice = string | null | undefined

interface Pick { bookingId: string; episodeRowId: EpisodeChoice }

interface CandidatesData {
  bookings: MixTargetView[]
  openJobs: OpenMixJobView[]
  truncated: boolean
  window: { pastDays: number; futureDays: number }
}

interface ResolveData {
  resolution: MixResolution
  bookings: Record<string, MixTargetView>
  openJobs: OpenMixJobView[]
  suggestedTitle: string | null
}

type Load<T> = { s: 'idle' } | { s: 'loading' } | { s: 'error'; message: string } | { s: 'ok'; data: T }

const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'mine', label: 'งานของฉัน' },
  { key: 'code', label: 'ใส่ EP ID / Booking ID' },
  { key: 'solo', label: 'งานเดี่ยว (ไม่มีใบจอง)' },
]

const VIA_LABEL: Record<'bookingCode' | 'bookingId' | 'episodeId', string> = {
  bookingCode: 'จากรหัสใบจอง',
  bookingId: 'จากไอดีภายในของใบจอง',
  episodeId: 'จาก EP ID',
}

/** 'YYYY-MM-DD' → "จ. 28 ก.ย. 2026" · คีย์เป็นวันล้วน (@db.Date) จึงแปลงที่ UTC ไม่เลื่อนวัน */
function fmtDay(key: string | null | undefined): string {
  if (!key) return ''
  const d = new Date(`${key}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return key
  return d.toLocaleDateString('th-TH-u-ca-gregory', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

const epTitle = (t: string | null | undefined) => (t && t.trim() && t.trim() !== '-' ? t.trim() : '')

/** สำเนาของ suggestMixTitle (mix-targets.ts) — ไฟล์นั้น import prisma เรียกจาก client ไม่ได้ */
function suggestTitle(b: MixTargetView, episodeRowId: string | null): string {
  const ep = episodeRowId ? b.episodes.find(e => e.id === episodeRowId) : null
  const t = ep?.title?.trim()
  const base = b.showName.trim()
  if (t && t !== '-' && t !== base) return `${base} · ${t}`.slice(0, 200)
  return base.slice(0, 200)
}

function statusText(s: string): string {
  const k = s as MixStatus
  return MIX_STATUS_LABEL[k] ? `${MIX_STATUS_LABEL[k]} · ${MIX_STATUS_HINT[k]}` : s
}

/** โหลด JSON แบบที่ error ไม่มีวันกลายเป็นความว่างเปล่า (docs/bug-classes.md) */
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  const d = await r.json().catch(() => null)
  if (!r.ok) throw new Error(d?.error || `เซิร์ฟเวอร์ตอบ ${r.status}`)
  if (!d) throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง')
  return d as T
}

function EpisodeName({ e }: { e: { episodeId: string; title: string } }) {
  const t = epTitle(e.title)
  return <><span className="font-mono">{e.episodeId}</span>{t && <> — {t}</>}</>
}

/** ชิปเลือกตอน — โชว์เมื่อใบมีมากกว่าหนึ่งตอน */
function EpisodeChips({ booking, value, onChange }: {
  booking: MixTargetView
  value: EpisodeChoice
  onChange: (v: string | null) => void
}) {
  if (booking.episodes.length < 2) return null
  const cls = (on: boolean) => `px-2.5 py-1 text-xs rounded-full border text-left ${
    on ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-300 hover:border-gray-500'
  }`
  return (
    <div className="mt-2">
      <p className="text-xs text-gray-500 mb-1">
        ใบนี้มี {booking.episodes.length} ตอน — มิกซ์ตอนไหน?
        {value === undefined && <span className="text-amber-700 ml-1">(ยังไม่ได้เลือก)</span>}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={cls(value === null)}>
          ทั้งใบ
        </button>
        {booking.episodes.map(e => (
          <button
            key={e.id} type="button" aria-pressed={value === e.id}
            onClick={() => onChange(e.id)} className={cls(value === e.id)}
          >
            <EpisodeName e={e} />
          </button>
        ))}
      </div>
    </div>
  )
}

/** ตอนที่จะผูก เป็นข้อความสั้น — ใช้ในการ์ดผลตรวจและบรรทัดสรุปก่อนส่ง */
function pickText(b: MixTargetView, ep: EpisodeChoice): string {
  if (ep === undefined) return 'ยังไม่ได้เลือกตอน'
  if (ep === null) return b.episodes.length > 1 ? 'ทั้งใบ' : 'ทั้งใบ (ใบนี้ไม่มีตอนแยก)'
  const e = b.episodes.find(x => x.id === ep)
  if (!e) return 'ตอนที่เลือกไม่อยู่ในใบนี้'
  const t = epTitle(e.title)
  return t ? `${e.episodeId} — ${t}` : e.episodeId
}

function BookingLines({ b }: { b: MixTargetView }) {
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-gray-600">{b.bookingCode || '(ไม่มีรหัส)'}</span>
        <StatusPill status={b.status} />
      </div>
      <div className="text-sm text-gray-800 break-words">{b.showName}</div>
      <div className="text-xs text-gray-500">
        ถ่าย {fmtDay(b.shootDate)}{b.producer && <> · Producer {b.producer}</>}
      </div>
    </>
  )
}

export default function MixRequestForm({ onDone, initialBookingCode }: {
  /** `notifyReason` เพิ่มใน v1.244 (ไม่บังคับอ่าน) — เหตุผลที่เมลไม่ออก ถ้าไม่ออก */
  onDone: (created: { code: string; notifiedTo: string[]; notifyReason?: string | null }) => void
  /** v1.219 — เติมรหัสมาให้เมื่อกดขอจากหน้าใบจอง คนจะได้ไม่ต้องจำเลขไปพิมพ์เอง */
  initialBookingCode?: string
}) {
  const [mode, setMode] = useState<Mode>(initialBookingCode ? 'code' : 'mine')

  // (ก) งานของฉัน
  const [cand, setCand] = useState<Load<CandidatesData>>({ s: 'idle' })
  const [filter, setFilter] = useState('')
  const [minePick, setMinePick] = useState<Pick | null>(null)

  // (ข) ใส่รหัส — ผลตรวจผูกกับข้อความในช่องเสมอ: แก้ช่อง = ล้างผล
  const [code, setCode] = useState(initialBookingCode || '')
  const [check, setCheck] = useState<Load<ResolveData>>({ s: 'idle' })
  const [codePick, setCodePick] = useState<Pick | null>(null)
  const seq = useRef(0)
  const ctl = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [title, setTitle] = useState('')
  const titleEdited = useRef(false)
  const [dueDate, setDueDate] = useState('')
  const [calOpen, setCalOpen] = useState(false)
  const calRef = useRef<HTMLDialogElement>(null)
  // ปิดเมื่อ "กดและปล่อย" บนฉากหลังเท่านั้น — ลากคลุมข้อความในกล่องแล้วปล่อยนอกกล่อง เบราว์เซอร์ส่ง click
  // ไปที่ตัว <dialog> (บรรพบุรุษร่วม) ซึ่งหน้าตาเหมือนคลิกฉากหลังทุกประการ
  const pressOnBackdrop = useRef(false)
  useEffect(() => {
    const d = calRef.current
    if (!d) return
    if (calOpen && !d.open) d.showModal()
    else if (!calOpen && d.open) d.close()
  }, [calOpen])
  const [sourceLink, setSourceLink] = useState('')
  const [notes, setNotes] = useState('')

  // ยืนยันขอซ้ำผูกกับ "งาน+ตอน" ที่ติ๊ก — เปลี่ยนงานแล้วต้องติ๊กใหม่ ไม่พาการยืนยันเก่าไปใช้กับงานอื่น
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [serverDupes, setServerDupes] = useState<{ key: string; codes: string[] } | null>(null)

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const loadCandidates = useCallback(async () => {
    setCand({ s: 'loading' })
    try {
      const d = await getJson<CandidatesData>('/api/mix/candidates')
      if (!Array.isArray(d.bookings) || !Array.isArray(d.openJobs)) throw new Error('ข้อมูลงานของคุณไม่ครบ')
      setCand({ s: 'ok', data: d })
    } catch (e: any) {
      setCand({ s: 'error', message: e?.message || 'โหลดงานของคุณไม่สำเร็จ' })
    }
  }, [])

  useEffect(() => {
    if (mode === 'mine' && cand.s === 'idle') loadCandidates()
  }, [mode, cand.s, loadCandidates])

  /** ยกเลิกการตรวจที่ค้างอยู่ — ผลของ request เก่าต้องไม่มาทับผลของข้อความปัจจุบัน */
  const invalidate = useCallback(() => {
    seq.current++
    ctl.current?.abort()
    ctl.current = null
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const runCheck = useCallback(async (raw: string) => {
    invalidate()
    setCodePick(null)
    const q = raw.trim()
    if (!q) { setCheck({ s: 'idle' }); return }
    const my = seq.current
    const c = new AbortController()
    ctl.current = c
    setCheck({ s: 'loading' })
    try {
      const d = await getJson<ResolveData>(`/api/mix/resolve?q=${encodeURIComponent(q)}`, { signal: c.signal })
      if (my !== seq.current) return
      if (!d.resolution || !d.bookings) throw new Error('ผลตรวจไม่ครบ')
      setCheck({ s: 'ok', data: d })
      const r = d.resolution
      if (r.kind === 'match') {
        setCodePick({ bookingId: r.pick.bookingId, episodeRowId: r.needsEpisodePick ? undefined : r.pick.episodeRowId })
      }
    } catch (e: any) {
      if (my !== seq.current || c.signal.aborted) return
      setCheck({ s: 'error', message: e?.message || 'ตรวจไม่สำเร็จ' })
    }
  }, [invalidate])

  useEffect(() => {
    if (!initialBookingCode) return
    setMode('code')
    setCode(initialBookingCode)
    runCheck(initialBookingCode)
  }, [initialBookingCode, runCheck])

  useEffect(() => () => invalidate(), [invalidate])

  function onCodeChange(v: string) {
    setCode(v)
    invalidate()
    setCheck({ s: 'idle' })
    setCodePick(null)
    if (v.trim()) timer.current = setTimeout(() => runCheck(v), 500)
  }

  // ─── งานที่เลือกอยู่ตอนนี้ — ได้จากโหมดที่เปิดอยู่เท่านั้น ───
  let target: { booking: MixTargetView; episodeRowId: EpisodeChoice; openJobs: OpenMixJobView[] } | null = null
  if (mode === 'mine' && cand.s === 'ok' && minePick) {
    const b = cand.data.bookings.find(x => x.id === minePick.bookingId)
    if (b) target = { booking: b, episodeRowId: minePick.episodeRowId, openJobs: cand.data.openJobs }
  } else if (mode === 'code' && check.s === 'ok' && codePick) {
    const b = check.data.bookings[codePick.bookingId]
    if (b) target = { booking: b, episodeRowId: codePick.episodeRowId, openJobs: check.data.openJobs }
  }

  const suggested = target ? suggestTitle(target.booking, target.episodeRowId ?? null) : null
  // เติมชื่อให้เฉพาะตอนที่ผู้ใช้ยังไม่ได้พิมพ์เอง — ถ้าพิมพ์แล้ว โชว์ปุ่ม "ใช้ชื่อที่แนะนำ" แทนการเขียนทับเงียบ ๆ
  useEffect(() => {
    if (suggested && !titleEdited.current) setTitle(suggested)
  }, [suggested])

  const pickKey = target && target.episodeRowId !== undefined
    ? `${target.booking.id}:${target.episodeRowId ?? ''}` : null
  const localDupes = target && pickKey
    ? findDuplicateMixJobs(target.openJobs, { bookingId: target.booking.id, episodeRowId: target.episodeRowId ?? null })
    : []
  const serverOnly = serverDupes && serverDupes.key === pickKey
    ? serverDupes.codes.filter(c => !localDupes.some(d => d.code === c)) : []
  const dupCount = localDupes.length + serverOnly.length
  const dupConfirmed = pickKey !== null && confirmKey === pickKey

  const today = bangkokDateKey()
  const linkInvalid = !!sourceLink.trim() && !normalizeHttpLink(sourceLink)

  const blocker =
    mode === 'mine' && !target ? 'เลือกงานจากรายการก่อน'
    : mode === 'code' && !target ? (
      check.s === 'ok' && check.data.resolution.kind === 'ambiguous' ? 'เลือกกองที่ต้องการก่อน'
      : check.s === 'loading' ? 'กำลังตรวจรหัส…'
      : 'ใส่ EP ID / Booking ID ให้จับคู่ได้ก่อน')
    : target && target.episodeRowId === undefined ? 'เลือกตอน หรือ "ทั้งใบ" ก่อน'
    : !title.trim() ? 'ใส่ชื่องานที่จะมิกซ์'
    : !dueDate ? 'เลือกวันที่ต้องการไฟล์'
    : dueDate < today ? 'วันที่ต้องการไฟล์ย้อนหลังไม่ได้'
    : linkInvalid ? 'ลิงก์ไฟล์ต้องขึ้นต้นด้วย http:// หรือ https://'
    : mode === 'solo' && !sourceLink.trim() ? 'งานเดี่ยวต้องใส่ลิงก์ไฟล์ต้นทาง'
    : dupCount > 0 && !dupConfirmed ? 'ติ๊กยืนยันว่าต้องการขออีกงานก่อน'
    : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (blocker || saving) return
    setSaving(true)
    setErr(null)
    const payload: Record<string, unknown> = {
      title: title.trim(),
      dueDate,
      sourceLink: sourceLink.trim() || undefined,
      notes: notes.trim() || undefined,
    }
    if (target) {
      payload.bookingId = target.booking.id
      if (target.episodeRowId) payload.episodeRowId = target.episodeRowId
      if (dupCount > 0 && dupConfirmed) payload.confirmDuplicate = true
    }
    try {
      const res = await fetch('/api/mix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409 && Array.isArray(data.duplicates) && pickKey) {
        // มีคนขอเข้ามาระหว่างที่ฟอร์มเปิดอยู่ — โชว์กล่องเดิมให้ตัดสินใจ ไม่ส่งซ้ำให้เอง
        setServerDupes({ key: pickKey, codes: data.duplicates })
        setConfirmKey(null)
        return
      }
      if (!res.ok) throw new Error(data.error || `ตั้งคำขอไม่สำเร็จ (${res.status})`)
      onDone({
        code: data.job?.code || '',
        // sent:false ยังคืน `to` ที่มีรายชื่อ (ยังไม่ตั้งค่าเมล / SMTP ล้ม) — ถ้าส่งต่อไปตรง ๆ ผู้เรียกทุกตัว
        // จะขึ้นว่า "แจ้งอีเมลถึง … แล้ว" ทั้งที่ไม่มีใครได้เมล (bug-class: a record is not delivery)
        notifiedTo: data.notified?.sent === true && Array.isArray(data.notified.to) ? data.notified.to : [],
        notifyReason: data.notified?.reason ?? null,
      })
    } catch (e: any) {
      setErr(e instanceof TypeError
        // request อาจถึงเซิร์ฟเวอร์แล้วก็ได้ — บอกตามจริง ไม่ใช่ "ไม่สำเร็จ" เฉย ๆ แล้วให้กดซ้ำ
        ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ไม่แน่ใจว่าคำขอถึงหรือยัง ดูที่คิว /mix?scope=mine ก่อนส่งซ้ำ'
        : (e?.message || 'ตั้งคำขอไม่สำเร็จ'))
    } finally {
      setSaving(false)
    }
  }

  const input = 'w-full px-3 py-2 text-sm border border-gray-300 rounded-md bg-white'

  function renderMine() {
    if (cand.s === 'idle' || cand.s === 'loading') {
      return <p className="text-sm text-gray-500 flex items-center gap-1.5"><Loader2 className="animate-spin" size={14} /> กำลังโหลดงานของคุณ…</p>
    }
    if (cand.s === 'error') {
      return (
        <div className="p-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700">
          <p className="flex items-start gap-1.5"><AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>โหลดงานของคุณไม่สำเร็จ — {cand.message}</span></p>
          <button type="button" onClick={loadCandidates} className="mt-2 inline-flex items-center gap-1 text-sm underline">
            <RefreshCw size={13} /> ลองใหม่
          </button>
          <span className="ml-2 text-xs text-red-600">หรือใช้แบบ &quot;ใส่ EP ID / Booking ID&quot;</span>
        </div>
      )
    }
    const { bookings, openJobs, truncated, window: win } = cand.data
    const windowText = `ใบจองที่คุณสร้าง / เป็น Producer หรือ Co-Producer / อยู่ในทีม ถ่ายไปแล้วไม่เกิน ${win.pastDays} วัน ถึงอีก ${win.futureDays} วันข้างหน้า`
    if (bookings.length === 0) {
      return (
        <div className="p-3 rounded-md border border-gray-200 bg-white text-sm text-gray-600">
          <p>ไม่มีงานของคุณในช่วงนี้ ({windowText})</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <button type="button" onClick={() => setMode('code')} className="underline text-gray-800">ใส่ EP ID / Booking ID</button>
            <button type="button" onClick={() => setMode('solo')} className="underline text-gray-800">งานเดี่ยว (ไม่มีใบจอง)</button>
          </div>
        </div>
      )
    }
    const f = filter.trim().toLowerCase()
    const rows = f
      ? bookings.filter(b => [b.bookingCode, b.showName, ...b.episodes.flatMap(e => [e.episodeId, e.title])]
        .some(s => (s || '').toLowerCase().includes(f)))
      : bookings
    return (
      <div>
        <input
          value={filter} onChange={e => setFilter(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
          placeholder="กรองด้วยรหัส / ชื่อรายการ / ชื่อตอน" aria-label="กรองงานของฉัน"
          className={input}
        />
        <p className="text-xs text-gray-400 mt-1">
          {windowText}
          {truncated && <span className="text-amber-700"> · แสดงแค่ {bookings.length} ใบ (เรียงวันถ่ายใหม่→เก่า) ถ้าไม่เจอ ใช้แบบใส่รหัส</span>}
        </p>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">ไม่มีงานที่ตรงกับ &quot;{filter.trim()}&quot;</p>
        ) : (
          <ul className="mt-2 max-h-80 overflow-y-auto border border-gray-200 rounded-md bg-white divide-y divide-gray-100">
            {rows.map(b => {
              const sel = minePick?.bookingId === b.id
              const openN = openJobs.filter(j => j.bookingId === b.id).length
              return (
                <li key={b.id} className={sel ? 'bg-green-50' : ''}>
                  <button
                    type="button" aria-pressed={sel}
                    onClick={() => {
                      if (sel) return
                      setMinePick({
                        bookingId: b.id,
                        episodeRowId: b.episodes.length > 1 ? undefined : (b.episodes[0]?.id ?? null),
                      })
                    }}
                    className={`w-full text-left px-3 py-2 ${sel ? '' : 'hover:bg-gray-50'}`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {sel && <Check size={14} className="text-green-600 shrink-0" />}
                      <span className="font-mono text-xs text-gray-600">{b.bookingCode || '(ไม่มีรหัส)'}</span>
                      <StatusPill status={b.status} />
                      {openN > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-800 whitespace-nowrap">
                          มีคำขอมิกซ์เปิดอยู่ {openN}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-800 truncate">{b.showName}</div>
                    <div className="text-xs text-gray-500">
                      ถ่าย {fmtDay(b.shootDate)}{b.episodes.length > 1 && <> · {b.episodes.length} ตอน</>}
                    </div>
                  </button>
                  {sel && (
                    <div className="px-3 pb-2">
                      <EpisodeChips
                        booking={b} value={minePick?.episodeRowId}
                        onChange={v => setMinePick({ bookingId: b.id, episodeRowId: v })}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  function renderCheck() {
    if (check.s === 'idle') return null
    if (check.s === 'loading') {
      return <p className="mt-2 text-sm text-gray-500 flex items-center gap-1.5"><Loader2 className="animate-spin" size={14} /> กำลังตรวจ…</p>
    }
    if (check.s === 'error') {
      return (
        <div className="mt-2 p-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700">
          <p className="flex items-start gap-1.5"><AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>ตรวจรหัสไม่ได้ — {check.message} · ยังไม่รู้ว่ามีใบนี้หรือไม่ (ไม่ได้แปลว่าไม่พบ)</span></p>
          <button type="button" onClick={() => runCheck(code)} className="mt-2 inline-flex items-center gap-1 underline">
            <RefreshCw size={13} /> ลองใหม่
          </button>
        </div>
      )
    }
    const { resolution: r, bookings } = check.data
    if (r.kind === 'none') {
      return <p className="mt-2 p-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700">{r.reason}</p>
    }
    if (r.kind === 'match') {
      const b = bookings[r.pick.bookingId]
      if (!b) {
        return <p className="mt-2 p-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700">ผลตรวจไม่ครบ (ไม่มีข้อมูลใบจอง) — กดตรวจอีกครั้ง</p>
      }
      return (
        <div className="mt-2 p-3 rounded-md border border-green-300 bg-green-50">
          <p className="flex items-center gap-1.5 text-sm font-medium text-green-800 mb-1">
            <CheckCircle2 size={16} className="shrink-0" /> จับคู่ได้
            <span className="text-xs font-normal text-green-700">· {VIA_LABEL[r.via]}</span>
          </p>
          <BookingLines b={b} />
          {b.episodes.length > 1 ? (
            <EpisodeChips
              booking={b} value={codePick?.episodeRowId}
              onChange={v => setCodePick({ bookingId: b.id, episodeRowId: v })}
            />
          ) : (
            <p className="text-xs text-gray-600 mt-1">ตอน: {pickText(b, codePick?.episodeRowId)}</p>
          )}
        </div>
      )
    }
    const opts = r.options.filter(o => bookings[o.bookingId])
    return (
      <div className="mt-2 p-3 rounded-md border border-amber-300 bg-amber-50">
        <p className="text-sm font-medium text-amber-800">EP ID นี้ถ่ายหลายวัน เลือกกองที่ต้องการ</p>
        <p className="text-xs text-amber-700 mt-0.5">
          พบ {opts.length} กอง — ระบบไม่เดาให้ เพราะผูกผิดกอง = ทีมเสียงไปหยิบไฟล์ผิด · ใบที่คุณอยู่ในทีมขึ้นก่อน แล้วเรียงวันถ่ายใกล้วันนี้
        </p>
        <div className="mt-2 space-y-1.5" role="radiogroup" aria-label="เลือกกอง">
          {opts.map(o => {
            const b = bookings[o.bookingId]
            const on = codePick?.bookingId === o.bookingId && codePick?.episodeRowId === o.episodeRowId
            return (
              <label
                key={`${o.bookingId}:${o.episodeRowId ?? ''}`}
                className={`flex items-start gap-2 p-2 rounded-md border cursor-pointer bg-white ${on ? 'border-gray-900' : 'border-gray-200'}`}
              >
                <input
                  type="radio" name="mix-ambiguous-pick" checked={on} className="mt-1 shrink-0"
                  onChange={() => setCodePick({ bookingId: o.bookingId, episodeRowId: o.episodeRowId })}
                />
                <div className="min-w-0">
                  <BookingLines b={b} />
                  <p className="text-xs text-gray-600">ตอน: {pickText(b, o.episodeRowId)}</p>
                </div>
              </label>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <>
    <form onSubmit={submit} className="mb-4 p-3 sm:p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-4">
      <div>
        <p className="block text-xs text-gray-500 mb-1">มิกซ์งานไหน *</p>
        <div className="grid grid-cols-3 gap-1 p-1 rounded-md bg-gray-200/70" role="group" aria-label="เลือกงานจาก">
          {MODES.map(m => (
            <button
              key={m.key} type="button" aria-pressed={mode === m.key}
              onClick={() => { setMode(m.key); setErr(null) }}
              className={`px-2 py-1.5 text-xs sm:text-sm leading-tight rounded ${
                mode === m.key ? 'bg-white text-gray-900 shadow-sm font-medium' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'mine' && renderMine()}

      {mode === 'code' && (
        <div>
          <div className="flex gap-2">
            <input
              value={code} onChange={e => onCodeChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); runCheck(code) } }}
              placeholder="เช่น PP-26-034-L01" aria-label="EP ID หรือ Booking ID"
              autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false}
              className="flex-1 min-w-0 px-3 py-2.5 text-lg font-mono border border-gray-300 rounded-md bg-white"
            />
            <button
              type="button" onClick={() => runCheck(code)} disabled={!code.trim() || check.s === 'loading'}
              className="shrink-0 px-4 text-sm rounded-md border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-50"
            >
              ตรวจ
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {initialBookingCode && code === initialBookingCode && <span className="text-green-600">เติมให้จากใบจองแล้ว · </span>}
            ตรวจเองเมื่อหยุดพิมพ์ · วางจากแชท/ชีทได้ ตัวเล็ก-ใหญ่หรือขีดแบบไหนก็ได้
          </p>
          {renderCheck()}
        </div>
      )}

      {mode === 'solo' && (
        <p className="text-sm text-gray-600">
          ไม่ผูกใบจอง — ต้องใส่ลิงก์ไฟล์ต้นทางด้านล่าง ทีมเสียงจะได้รู้ว่าไฟล์อยู่ไหน
        </p>
      )}

      {dupCount > 0 && (
        <div className="p-3 rounded-md border border-amber-300 bg-amber-50 text-sm text-amber-800">
          <p className="flex items-start gap-1.5 font-medium">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /> มีคำขอเปิดอยู่แล้ว:
          </p>
          <ul className="mt-1 space-y-0.5 pl-5 list-disc">
            {localDupes.map(d => (
              <li key={d.code}>
                <span className="font-mono">{d.code}</span>{' '}
                ({statusText(d.status)}, {d.assigneeEmail ? `คนทำ ${d.assigneeEmail.split('@')[0]}` : 'ยังไม่มีคนทำ'},
                {' '}{d.dueDate ? `ต้องการ ${fmtDay(d.dueDate)}` : 'ไม่ระบุวัน'})
                {' · '}{d.episodeCode || 'ทั้งใบ'}
              </li>
            ))}
            {serverOnly.map(c => (
              <li key={c}><span className="font-mono">{c}</span> <span className="text-xs">(เพิ่งมีคนขอเข้ามา — ดูรายละเอียดในคิว)</span></li>
            ))}
          </ul>
          <label className="mt-2 flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox" className="mt-1 shrink-0" checked={dupConfirmed}
              onChange={e => setConfirmKey(e.target.checked ? pickKey : null)}
            />
            <span>ยืนยันว่าต้องการขออีกงาน (เช่น ต้องการอีกเวอร์ชัน)</span>
          </label>
        </div>
      )}

      <div>
        <label htmlFor="mix-title" className="block text-xs text-gray-500 mb-1">ชื่องานที่จะมิกซ์ *</label>
        <input
          id="mix-title" value={title} required maxLength={200}
          onChange={e => { setTitle(e.target.value); titleEdited.current = e.target.value.trim() !== '' }}
          placeholder="เช่น พอดแคสต์ EP.42 / มิกซ์เสียงสัมภาษณ์"
          className={input}
        />
        {suggested && title.trim() !== suggested && (
          <button
            type="button"
            onClick={() => { setTitle(suggested); titleEdited.current = false }}
            className="mt-1 text-xs text-blue-700 hover:underline text-left"
          >
            ใช้ชื่อที่แนะนำจากงานที่เลือก: &quot;{suggested}&quot;
          </button>
        )}
      </div>

      <div>
        <label htmlFor="mix-due" className="block text-xs text-gray-500 mb-1">วันที่ต้องการไฟล์ *</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="mix-due" type="date" value={dueDate} min={today} required
            onChange={e => setDueDate(e.target.value)}
            className={`${input} sm:w-56`}
          />
          <button
            type="button" onClick={() => setCalOpen(true)} aria-haspopup="dialog"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-md border border-gray-300 bg-white hover:bg-gray-100"
          >
            <CalendarDays size={15} aria-hidden /> ดูปฏิทินคิวทั้งเดือน
          </button>
        </div>
        <MixLoadStrip value={dueDate} onPick={setDueDate} />
      </div>

      <div>
        <label htmlFor="mix-src" className="block text-xs text-gray-500 mb-1">
          ลิงก์ไฟล์ต้นทาง {mode === 'solo' ? '*' : '(ไม่บังคับ — ทีมเสียงหาไฟล์จากใบจองได้)'}
        </label>
        <input
          id="mix-src" type="url" inputMode="url" value={sourceLink} onChange={e => setSourceLink(e.target.value)}
          placeholder="https://drive.google.com/…" className={input}
        />
        {linkInvalid && <p className="text-xs text-red-600 mt-1">ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://</p>}
      </div>

      <div>
        <label htmlFor="mix-notes" className="block text-xs text-gray-500 mb-1">โน้ตถึงทีมเสียง</label>
        <textarea
          id="mix-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={4000}
          placeholder="เช่น ตัดเสียงแอร์ออก, ต้องการไฟล์ WAV"
          className={input}
        />
      </div>

      {err && (
        <p className="text-sm text-red-600 flex items-start gap-1.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{err}</span>
        </p>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <button
          type="submit" disabled={!!blocker || saving}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {saving && <Loader2 className="animate-spin" size={14} />}
          ส่งคำขอ
        </button>
        <p className={`text-xs ${blocker ? 'text-gray-500' : 'text-gray-600'}`}>
          {blocker
            ?? (target
              ? <>จะผูกกับ <span className="font-mono">{target.booking.bookingCode || target.booking.id}</span> · {pickText(target.booking, target.episodeRowId)} · Sound Admin จะได้รับแจ้งเพื่อแจกงาน</>
              : <>งานเดี่ยว ไม่ผูกใบจอง · Sound Admin จะได้รับแจ้งเพื่อแจกงาน</>)}
        </p>
      </div>
    </form>

    {/* ป๊อปอัปปฏิทินคิวมิกซ์ · คลิกนอกกล่อง (ตัว <dialog> เอง = ฉากหลัง) ก็ปิด · เมานต์ปฏิทินเฉพาะตอนเปิด
        = ได้ตัวเลขล่าสุดทุกครั้ง และเปิดมาที่เดือนของวันที่กรอกไว้ */}
    <dialog
      ref={calRef}
      aria-label="ปฏิทินคิวมิกซ์"
      onClose={() => setCalOpen(false)}
      onPointerDown={e => { pressOnBackdrop.current = e.target === e.currentTarget }}
      onClick={e => { if (pressOnBackdrop.current && e.target === e.currentTarget) setCalOpen(false) }}
      className="p-0 w-[calc(100vw-1rem)] max-w-4xl max-h-[92vh] overflow-y-auto rounded-lg border border-gray-200 shadow-xl backdrop:bg-black/40"
    >
      <div className="p-2 sm:p-3">
        <div className="flex items-start justify-between gap-2 mb-2 px-1">
          <p className="text-sm text-gray-600">
            ดูว่าวันไหนคิวเบา แล้วแตะวันเพื่อดูงานของวันนั้น หรือเลือกเป็นวันที่ต้องการไฟล์
          </p>
          <button
            type="button" onClick={() => setCalOpen(false)} aria-label="ปิดปฏิทิน"
            className="shrink-0 p-1.5 rounded hover:bg-gray-100 text-gray-500"
          >
            <X size={16} />
          </button>
        </div>
        {calOpen && (
          <MixLoadCalendar
            initialDate={dueDate || undefined}
            onPickDate={d => { setDueDate(d); setCalOpen(false) }}
          />
        )}
      </div>
    </dialog>
    </>
  )
}
