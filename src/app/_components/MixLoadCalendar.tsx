'use client'

/**
 * v1.244 — ปฏิทินภาระงานมิกซ์ (นับตาม "วันที่ต้องการไฟล์")
 *
 * สองคำถาม ตอบจากชุดข้อมูลเดียว (/api/mix/calendar → buildMixCalendar ใน mix-jobs.ts):
 *  - คนขอ: "ช่วงไหนคิวเบา" ก่อนเลือกวันที่ต้องการไฟล์ → MixLoadStrip ในฟอร์ม · ปฏิทินในหน้า /mix
 *  - Sound Admin: "ใครแน่นวันไหน" ก่อนแจกงาน → MixLoadCalendar showAssigneeLoad
 *
 * ระดับความแน่น (free/light/busy/heavy) คิดที่ server ด้วย mixLoadLevel — หน้านี้แค่ระบายสี
 * ช่วงตัวเลขใน legend ก็ถาม mixLoadLevel ตรง ๆ ไม่ลอกเกณฑ์มาเขียนซ้ำ (bug-classes #9)
 *
 * โหลดไม่ได้ ≠ คิวว่าง (bug-classes #2): ตัวเลข/สีโผล่เฉพาะเมื่อได้ข้อมูลของช่วงนั้นจริง ๆ
 * ระหว่างโหลดหรือโหลดล้ม ช่องวันมีแค่เลขวัน + ข้อความบอกว่ายังไม่รู้ ไม่มีช่องไหนดู "ว่าง"
 *
 * v1.246 — ปุ่ม "เปิดใน Google Calendar" (ลิงก์มาจาก server เพราะ id ปฏิทินอยู่ใน env) และใช้เป็น
 * ป๊อปอัปในฟอร์มขอมิกซ์ได้ (`initialDate` + `onPickDate`) — ผู้ใช้ทั่วไปเห็นเหมือนทีมเสียง
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarCheck, ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import {
  MIX_STATUS_LABEL, MIX_STATUS_HINT, MIX_LOAD_LABEL, MIX_FLAG_LABEL, MIX_JOBS_PER_ENGINEER_PER_DAY,
  MIX_CALENDAR_MAX_DAYS, mixLoadLevel, mixFlag, compareMixQueue, bangkokDateKey, addDaysKey, isValidISODate,
  type MixCalendarDay, type MixLoadLevel, type MixStatus,
} from '@/lib/mix-jobs'

interface CalendarJob {
  id: string
  code: string
  title: string
  status: string
  dueDate: string | null
  assigneeEmail: string | null
  bookingCode: string | null
  episodeCode: string | null
}

interface SoundMember { email: string; name: string | null }

interface CalendarData {
  from: string
  to: string
  today: string
  engineers: number
  soundTeam: SoundMember[]
  days: MixCalendarDay[]
  jobs: CalendarJob[]
  /** v1.246 — null = ปฏิทินมิกซ์บน Google ปิดอยู่ (ไม่มีปุ่ม) */
  googleCalendarUrl?: string | null
}

const LEVELS: MixLoadLevel[] = ['free', 'light', 'busy', 'heavy']

const LEVEL_STYLE: Record<MixLoadLevel, { bg: string; border: string; badge: string; swatch: string; text: string }> = {
  free: { bg: 'bg-white', border: 'border-gray-200', badge: 'bg-gray-100 text-gray-600', swatch: 'bg-white border border-gray-300', text: 'text-gray-400' },
  light: { bg: 'bg-emerald-50', border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-800', swatch: 'bg-emerald-200', text: 'text-emerald-700' },
  busy: { bg: 'bg-amber-50', border: 'border-amber-300', badge: 'bg-amber-200 text-amber-900', swatch: 'bg-amber-300', text: 'text-amber-700' },
  heavy: { bg: 'bg-red-50', border: 'border-red-300', badge: 'bg-red-600 text-white', swatch: 'bg-red-600', text: 'text-red-700' },
}

const STATUS_STYLE: Record<string, string> = {
  QUEUED: 'bg-slate-100 text-slate-700',
  IN_PROGRESS: 'bg-blue-50 text-blue-700',
  DONE: 'bg-green-50 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-400',
}

const DOW = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา']

/** key 'YYYY-MM-DD' → ข้อความไทย · อ่านเป็นเที่ยงคืน UTC + timeZone UTC = ไม่มีวันเลื่อนตามเครื่องคนดู */
function fmt(key: string, opts: Intl.DateTimeFormatOptions): string {
  // th-TH-u-ca-gregory: ค.ศ. ตรงกับการ์ดและฟอร์ม · ทีมอ่าน "2569" บนหน้าคิวเป็นสัญญาณบั๊กข้อมูล (ops-log)
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('th-TH-u-ca-gregory', { ...opts, timeZone: 'UTC' })
}

function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number)
  // setUTCFullYear ไม่ใช่ Date.UTC — Date.UTC แปลงปี 0–99 เป็น 19xx: เดือน '0069-10' เลื่อนแล้วกลายเป็น
  // '1969-11' แล้ว monthGrid วาด ~694,000 วันจนแท็บค้าง (ผู้ตรวจเจอ: พิมพ์ปี "69" ในช่องวันที่แล้วเปิดป๊อปอัป)
  const d = new Date(0)
  d.setUTCFullYear(y, m - 1 + n, 1)
  return d.toISOString().slice(0, 7)
}

/** ทุกวันในกริดของเดือน 'YYYY-MM' — จันทร์เป็นวันแรก เติมหัว/ท้ายให้ครบสัปดาห์ (28–42 วัน) */
function monthGrid(ym: string): string[] {
  const first = `${ym}-01`
  const last = addDaysKey(`${shiftMonth(ym, 1)}-01`, -1)
  const mondayIndex = (key: string) => (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7
  const end = addDaysKey(last, 6 - mondayIndex(last))
  const out: string[] = []
  for (let k = addDaysKey(first, -mondayIndex(first)); k <= end; k = addDaysKey(k, 1)) out.push(k)
  return out
}

/** ช่วงจำนวนงานของแต่ละระดับ ถามจาก mixLoadLevel เอง — เกณฑ์เปลี่ยนที่ mix-jobs.ts แล้ว legend ตามเอง */
function levelRanges(engineers: number): Partial<Record<MixLoadLevel, string>> {
  const cap = Math.max(1, engineers) * MIX_JOBS_PER_ENGINEER_PER_DAY
  const seen: Partial<Record<MixLoadLevel, [number, number]>> = {}
  for (let n = 0; n <= cap + 1; n++) {
    const l = mixLoadLevel(n, engineers)
    seen[l] = [seen[l]?.[0] ?? n, n]
  }
  const out: Partial<Record<MixLoadLevel, string>> = {}
  for (const l of LEVELS) {
    const r = seen[l]
    if (r) out[l] = l === 'heavy' ? `${r[0]}+` : r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`
  }
  return out
}

/**
 * ดึงปฏิทินช่วง [from, to] · คืน data เฉพาะเมื่อเป็นข้อมูลของช่วงนี้และไม่ error —
 * ข้อมูลเดือนก่อนที่ค้างอยู่ระหว่างโหลดเดือนใหม่จะไม่ถูกเอามาวาดในกริดใหม่
 */
function useMixCalendar(from: string, to: string) {
  const [data, setData] = useState<CalendarData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(true)
  // ลิงก์ไม่ขึ้นกับช่วงวันที่ — เก็บค่าล่าสุดไว้ ปุ่มจะได้ไม่หายวูบทุกครั้งที่เลื่อนเดือน
  const [googleCalendarUrl, setGoogleCalendarUrl] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const retry = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    let cancelled = false
    setPending(true)
    setError(null)
    fetch(`/api/mix/calendar?from=${from}&to=${to}`)
      .then(async res => {
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new Error(body?.error || `โหลดไม่สำเร็จ (${res.status})`)
        if (!body || !Array.isArray(body.days) || !Array.isArray(body.jobs)) throw new Error('ข้อมูลปฏิทินผิดรูปแบบ')
        if (!cancelled) {
          setData(body as CalendarData)
          setGoogleCalendarUrl(typeof body.googleCalendarUrl === 'string' ? body.googleCalendarUrl : null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'โหลดปฏิทินไม่สำเร็จ')
      })
      .finally(() => { if (!cancelled) setPending(false) })
    return () => { cancelled = true }
  }, [from, to, tick])

  const fresh = !error && data && data.from === from && data.to === to ? data : null
  return { data: fresh, error, pending, retry, googleCalendarUrl }
}

function LoadLegend({ engineers, compact }: { engineers: number; compact?: boolean }) {
  // ระดับที่ไม่มีทางเกิดกับทีมขนาดนี้ (เช่น "เบา" ตอนมีคนเดียว) ไม่ต้องโชว์ให้งง
  const ranges = levelRanges(engineers)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
      {LEVELS.filter(l => ranges[l]).map(l => (
        <span key={l} className="inline-flex items-center gap-1">
          <span className={`w-3 h-3 rounded-sm ${LEVEL_STYLE[l].swatch}`} aria-hidden />
          {MIX_LOAD_LABEL[l]}
          {!compact && <span className="text-gray-400">({ranges[l]} งาน)</span>}
        </span>
      ))}
      <span className="text-gray-400">
        เทียบกับทีมเสียง {engineers} คน ({MIX_JOBS_PER_ENGINEER_PER_DAY} งาน/คน/วัน)
        {engineers === 0 && ' — ยังไม่มีรายชื่อทีมเสียงในระบบ จึงคิดเหมือนมี 1 คน'}
      </span>
    </div>
  )
}

/* ───────────────────────────── ปฏิทินรายเดือน ───────────────────────────── */

export interface MixLoadCalendarProps {
  /** คลิกงานในปฏิทิน → ให้หน้าที่ครอบเลื่อนไปการ์ดนั้น (ไม่บังคับ) */
  onOpenJob?: (jobId: string) => void
  /** แสดงสรุปภาระงานต่อคน (Sound Admin) */
  showAssigneeLoad?: boolean
  /** เปิดมาที่เดือนของวันนี้และเลือกวันนี้ไว้ 'YYYY-MM-DD' (ป๊อปอัปในฟอร์ม: วันที่กรอกไว้แล้ว) */
  initialDate?: string
  /** มี = วันที่เลือกมีปุ่ม "ใช้ <วันที่> เป็นวันที่ต้องการไฟล์" ส่งวันกลับให้ฟอร์ม · เฉพาะวันนี้เป็นต้นไป */
  onPickDate?: (date: string) => void
}

/** initialDate มาจากช่องที่คนพิมพ์ — ปีสองหลัก ("69" = 2569) ได้ค่า '0069-10-05' ที่รูปถูกแต่ไม่มีใครหมายถึง
 *  · รับเฉพาะวันจริงในช่วง ค.ศ. 2000–2100 นอกนั้นเปิดที่เดือนนี้แบบไม่เลือกวัน */
const plausibleDate = (s: string | undefined): s is string =>
  isValidISODate(s) && s >= '2000-01-01' && s <= '2100-12-31'

export function MixLoadCalendar({ onOpenJob, showAssigneeLoad, initialDate, onPickDate }: MixLoadCalendarProps) {
  const [clientToday] = useState(() => bangkokDateKey())
  const start = plausibleDate(initialDate) ? initialDate : null
  const [ym, setYm] = useState(() => (start || clientToday).slice(0, 7))
  const [picked, setPicked] = useState<string | null>(start)
  const grid = useMemo(() => monthGrid(ym), [ym])
  const from = grid[0]
  const to = grid[grid.length - 1]
  const { data, error, pending, retry, googleCalendarUrl } = useMixCalendar(from, to)
  // แตะวันแล้วรายละเอียดอยู่ใต้กริด — ในป๊อปอัปมันตกขอบล่าง คนแตะแล้วเห็นแค่กรอบวันเปลี่ยน ·
  // เลื่อนให้เห็นเฉพาะตอนคนแตะ ไม่ใช่ตอนเปิดมาพร้อม initialDate (ไม่งั้นหัวเดือนหลุดจอตั้งแต่เปิด)
  const panelRef = useRef<HTMLDivElement>(null)
  const revealPanel = useRef(false)
  useEffect(() => {
    if (!revealPanel.current || !picked || !panelRef.current) return
    revealPanel.current = false
    panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [picked, data])
  const today = data?.today || clientToday

  const dayMap = useMemo(() => new Map((data?.days || []).map(d => [d.date, d])), [data])
  const jobsByDate = useMemo(() => {
    const m = new Map<string, CalendarJob[]>()
    for (const j of data?.jobs || []) {
      if (!j.dueDate) continue
      const list = m.get(j.dueDate)
      if (list) list.push(j)
      else m.set(j.dueDate, [j])
    }
    // งานที่ยังเปิดขึ้นก่อนงานที่ส่งแล้ว — สองงานแรกในช่องควรเป็นของที่ยังต้องทำ
    m.forEach(list => list.sort(compareMixQueue))
    return m
  }, [data])

  const nameOf = (email: string) => {
    const m = data?.soundTeam.find(t => t.email.toLowerCase() === email.toLowerCase())
    return m?.name?.trim() || email.split('@')[0]
  }
  const nick = (email: string) => nameOf(email).split(/\s+/)[0]

  const monthSum = useMemo(() => {
    const s = { total: 0, unassigned: 0, done: 0 }
    for (const d of data?.days || []) {
      if (!d.date.startsWith(ym)) continue
      s.total += d.total
      s.unassigned += d.unassigned
      s.done += d.done
    }
    return s
  }, [data, ym])

  const assigneeLoad = useMemo(() => {
    if (!data) return null
    const counts = new Map<string, number>()
    for (const m of data.soundTeam) counts.set(m.email.toLowerCase(), 0)
    let unassigned = 0
    for (const d of data.days) {
      unassigned += d.unassigned
      for (const [email, n] of Object.entries(d.byAssignee)) counts.set(email, (counts.get(email) || 0) + n)
    }
    const rows = Array.from(counts, ([email, n]) => ({ email, n }))
      .sort((a, b) => b.n - a.n || a.email.localeCompare(b.email))
    return { rows, unassigned }
  }, [data])

  const go = (n: number) => { setYm(m => shiftMonth(m, n)); setPicked(null) }
  const goToday = () => { setYm(today.slice(0, 7)); setPicked(today) }

  const pickedDay = picked && data ? dayMap.get(picked) : undefined
  const pickedJobs = picked ? jobsByDate.get(picked) || [] : []
  const todayAsDate = new Date(`${today}T00:00:00Z`)
  const navBtn = 'p-1.5 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-40'

  return (
    <section className="bg-white border border-gray-200 rounded-lg p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-gray-800">
            ปฏิทินคิวมิกซ์ · {fmt(`${ym}-01`, { month: 'long', year: 'numeric' })}
          </h2>
          <p className="text-xs text-gray-500">นับตามวันที่ต้องการไฟล์ — ดูว่าช่วงไหนคิวเบาหรือแน่น</p>
          {googleCalendarUrl && (
            <a
              href={googleCalendarUrl} target="_blank" rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
              title="เปิดปฏิทินคิวมิกซ์ใน Google Calendar — กดเพิ่มลงปฏิทินของฉันได้ เห็นทุกคนในบริษัท"
            >
              <ExternalLink size={12} aria-hidden /> เปิดใน Google Calendar
            </a>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => go(-1)} className={navBtn} aria-label="เดือนก่อน"><ChevronLeft size={16} /></button>
          <button type="button" onClick={goToday} className="px-2 py-1 text-xs rounded hover:bg-gray-100 text-gray-600">วันนี้</button>
          <button type="button" onClick={() => go(1)} className={navBtn} aria-label="เดือนถัดไป"><ChevronRight size={16} /></button>
          <button type="button" onClick={retry} disabled={pending} className={navBtn} aria-label="โหลดปฏิทินใหม่" title="โหลดใหม่">
            <RefreshCw size={14} className={pending ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="mb-2 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">
            ยังไม่รู้ว่าวันไหนมีงาน เพราะโหลดปฏิทินไม่สำเร็จ ({error})
            <button type="button" onClick={retry} className="gf-link text-xs ml-2">ลองใหม่</button>
          </span>
        </div>
      ) : !data ? (
        <p className="mb-2 text-xs text-gray-400 inline-flex items-center gap-1">
          <Loader2 size={12} className="animate-spin" /> กำลังโหลดปฏิทิน…
        </p>
      ) : (
        <p className="mb-2 text-xs text-gray-600">
          ทั้งเดือนมี <b className="text-gray-900">{monthSum.total}</b> งาน
          {monthSum.unassigned > 0 && <> · รอแจก <b className="text-amber-700">{monthSum.unassigned}</b></>}
          {monthSum.done > 0 && <> · ส่งแล้ว <b className="text-green-700">{monthSum.done}</b></>}
        </p>
      )}

      <div className="grid grid-cols-7 gap-0.5 sm:gap-1 mb-1">
        {DOW.map(d => <div key={d} className="text-center text-[11px] text-gray-400">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5 sm:gap-1">
        {grid.map(key => {
          const d = data ? dayMap.get(key) : undefined
          const has = !!d && d.total > 0
          const style = LEVEL_STYLE[has ? d!.level : 'free']
          const isToday = key === today
          const inMonth = key.startsWith(ym)
          const jobs = jobsByDate.get(key) || []
          const label = fmt(key, { weekday: 'long', day: 'numeric', month: 'long' })
            + (d ? `: ${d.total} งาน (${MIX_LOAD_LABEL[d.level]})${d.unassigned ? ` · รอแจก ${d.unassigned}` : ''}` : '')
          return (
            <button
              key={key}
              type="button"
              disabled={!data}
              onClick={() => { revealPanel.current = picked !== key; setPicked(p => (p === key ? null : key)) }}
              aria-label={label}
              aria-pressed={picked === key}
              title={label}
              className={`min-w-0 min-h-[50px] sm:min-h-[92px] rounded-md border p-1 sm:p-1.5 text-left flex flex-col items-start gap-0.5 transition-colors hover:brightness-95 disabled:cursor-default
                ${style.bg} ${isToday ? 'border-[#673ab7] border-2' : style.border}
                ${picked === key ? 'ring-2 ring-gray-900' : ''}
                ${key < today ? 'opacity-50' : ''}`}
            >
              <span className={`text-xs leading-none ${isToday ? 'font-semibold text-[#673ab7]' : inMonth ? 'text-gray-700' : 'text-gray-300'}`}>
                {Number(key.slice(8))}
              </span>
              {has && (
                <span className={`max-w-full text-[10px] sm:text-[11px] leading-tight px-1 rounded font-medium ${style.badge}`}>
                  {d!.total}<span className="hidden sm:inline"> · {MIX_LOAD_LABEL[d!.level]}</span>
                </span>
              )}
              {jobs.slice(0, 2).map(j => (
                <span key={j.id} className="hidden sm:block w-full truncate text-[10px] leading-tight text-gray-600">
                  {j.status === 'DONE' ? '✓ ' : ''}{j.code} · {j.assigneeEmail ? nick(j.assigneeEmail) : 'รอแจก'}
                </span>
              ))}
              {jobs.length > 2 && (
                <span className="hidden sm:block text-[10px] leading-tight text-gray-400">+{jobs.length - 2}</span>
              )}
            </button>
          )
        })}
      </div>

      {data && <div className="mt-2"><LoadLegend engineers={data.engineers} /></div>}

      {picked && data && (
        <div ref={panelRef} className="mt-3 border-t border-gray-100 pt-3 scroll-mb-3">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-gray-800">
              {fmt(picked, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </h3>
            {pickedDay && (
              <span className="text-xs text-gray-500">
                {pickedDay.total} งาน · {MIX_LOAD_LABEL[pickedDay.level]}
                {pickedDay.unassigned > 0 && ` · รอแจก ${pickedDay.unassigned}`}
              </span>
            )}
          </div>
          {onPickDate && (picked >= today ? (
            <button
              type="button" onClick={() => onPickDate(picked)}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-gray-900 text-white hover:bg-gray-800"
            >
              <CalendarCheck size={14} aria-hidden /> ใช้ {fmt(picked, { day: 'numeric', month: 'short' })} เป็นวันที่ต้องการไฟล์
            </button>
          ) : (
            <p className="mt-2 text-xs text-gray-400">วันที่ผ่านมาแล้ว เลือกเป็นวันที่ต้องการไฟล์ไม่ได้</p>
          ))}
          {pickedJobs.length === 0 ? (
            <p className="mt-2 text-xs text-gray-400">ว่าง — ยังไม่มีงานที่ต้องส่งวันดังกล่าว</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-100">
              {pickedJobs.map(j => {
                const overdue = mixFlag(j, todayAsDate) === 'OVERDUE'
                const inner = (
                  <>
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono text-xs text-gray-400">{j.code}</span>
                      <span
                        className={`text-[11px] px-1.5 py-0.5 rounded ${STATUS_STYLE[j.status] || ''}`}
                        title={MIX_STATUS_HINT[j.status as MixStatus]}
                      >
                        {MIX_STATUS_LABEL[j.status as MixStatus] || j.status}
                      </span>
                      {overdue && <span className="text-[11px] text-red-600">{MIX_FLAG_LABEL.OVERDUE}</span>}
                    </span>
                    <span className="block text-sm text-gray-800 break-words">{j.title}</span>
                    <span className="block text-xs text-gray-500">
                      {j.assigneeEmail ? `มิกซ์โดย ${nameOf(j.assigneeEmail)}` : 'รอแจกงาน'}
                      {j.bookingCode && ` · งาน ${j.bookingCode}`}
                      {j.episodeCode && ` · ตอน ${j.episodeCode}`}
                    </span>
                  </>
                )
                return (
                  <li key={j.id}>
                    {onOpenJob ? (
                      <button type="button" onClick={() => onOpenJob(j.id)} className="w-full text-left px-2 py-2 rounded hover:bg-gray-50">
                        {inner}
                      </button>
                    ) : (
                      <div className="px-2 py-2">{inner}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {showAssigneeLoad && assigneeLoad && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <h3 className="text-sm font-medium text-gray-800">งานที่ยังเปิดต่อคน</h3>
          <p className="text-xs text-gray-500">
            {MIX_STATUS_LABEL.QUEUED}/{MIX_STATUS_LABEL.IN_PROGRESS} ที่กำหนดส่งอยู่ในช่วง{' '}
            {fmt(from, { day: 'numeric', month: 'short' })} – {fmt(to, { day: 'numeric', month: 'short' })}{' '}
            เท่านั้น — งานที่กำหนดส่งนอกช่วงนี้ไม่นับ
          </p>
          <table className="mt-2 w-full max-w-sm text-sm">
            <tbody>
              {assigneeLoad.rows.map(r => (
                <tr key={r.email} className="border-b border-gray-50">
                  <td className="py-1 pr-3 text-gray-700 break-words">{nameOf(r.email)}</td>
                  <td className={`py-1 text-right tabular-nums ${r.n ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>{r.n}</td>
                </tr>
              ))}
              <tr>
                <td className="py-1 pr-3 text-amber-700">ยังไม่แจก</td>
                <td className={`py-1 text-right tabular-nums ${assigneeLoad.unassigned ? 'text-amber-700 font-medium' : 'text-gray-400'}`}>
                  {assigneeLoad.unassigned}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/* ─────────────────────────── แถบเลือกวันในฟอร์ม ─────────────────────────── */

export interface MixLoadStripProps {
  /** วันที่เลือกอยู่ 'YYYY-MM-DD' หรือ '' */
  value: string
  onPick: (date: string) => void
  /** จำนวนวันนับจากวันนี้ (ค่าเริ่มต้น 21) */
  days?: number
}

/**
 * แถบความแน่นของคิวใต้ช่อง "วันที่ต้องการไฟล์" — เป็นตัวช่วย ไม่ใช่ด่าน:
 * โหลดไม่ได้ก็แค่บอกสั้น ๆ แล้วให้กรอกวันที่เองต่อได้ ห้ามขวางการส่งฟอร์ม
 */
export function MixLoadStrip({ value, onPick, days = 21 }: MixLoadStripProps) {
  const n = Math.min(Math.max(1, Math.floor(days) || 21), MIX_CALENDAR_MAX_DAYS)
  const [today] = useState(() => bangkokDateKey())
  const { data, error, retry } = useMixCalendar(today, addDaysKey(today, n - 1))

  if (error) {
    return (
      <p className="text-[11px] text-gray-400">
        ดูความแน่นของคิวไม่ได้ตอนนี้
        <button type="button" onClick={retry} className="ml-1 underline hover:text-gray-600">ลองใหม่</button>
      </p>
    )
  }
  if (!data) {
    return (
      <p className="text-[11px] text-gray-400 inline-flex items-center gap-1">
        <Loader2 size={11} className="animate-spin" /> กำลังดูความแน่นของคิว…
      </p>
    )
  }
  return (
    <div className="min-w-0">
      <div className="flex gap-1 overflow-x-auto pb-1" role="group" aria-label="ความแน่นของคิวมิกซ์รายวัน">
        {data.days.map((d, i) => {
          const sel = d.date === value
          const style = LEVEL_STYLE[d.level]
          const dayNum = Number(d.date.slice(8))
          const label = `${fmt(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${d.total} งาน (${MIX_LOAD_LABEL[d.level]})`
          return (
            <button
              key={d.date}
              type="button"
              onClick={() => onPick(d.date)}
              aria-pressed={sel}
              aria-label={label}
              title={label}
              className={`shrink-0 w-11 rounded-md border px-0.5 py-1 text-center leading-tight ${style.bg}
                ${sel ? 'border-[#673ab7] ring-2 ring-[#673ab7]' : style.border}`}
            >
              <span className="block text-[10px] text-gray-500">{i === 0 ? 'วันนี้' : fmt(d.date, { weekday: 'short' })}</span>
              <span className={`block text-sm ${sel ? 'font-semibold text-[#673ab7]' : 'font-medium text-gray-800'}`}>{dayNum}</span>
              <span className="block text-[10px] text-gray-400">{i === 0 || dayNum === 1 ? fmt(d.date, { month: 'short' }) : ' '}</span>
              <span className={`block text-[11px] font-medium ${style.text}`}>{d.total || 'ว่าง'}</span>
            </button>
          )
        })}
      </div>
      <div className="mt-1"><LoadLegend engineers={data.engineers} compact /></div>
      <p className="text-xs text-gray-400 mt-1">สีบอกความแน่นของคิวแต่ละวัน — แตะวันเพื่อเลือกได้</p>
    </div>
  )
}
