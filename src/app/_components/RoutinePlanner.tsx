'use client'

/* =============================================================================
   RoutinePlanner — v1.56.0 (extracted to a shared component in v1.57.0)
   Bulk-generate recurring weekday bookings for daily shows (e.g. THE STANDARD
   NOW, Mon–Fri). Skips weekends, Thai holidays, and custom dates. Live preview
   before generating; manage existing routine groups. Used by /admin/routine
   and the "Routine" mode of /new (console only).
   ============================================================================= */

import { useEffect, useMemo, useState } from 'react'
import BackButton from '@/app/_components/BackButton'
import { Loader2, CalendarPlus, X, Trash2, Check, CheckCheck, ChevronRight, UserPlus, AlertTriangle } from 'lucide-react'
import { OUTLETS, OUTLET_MAP } from '@/lib/data'
import { LOCATIONS, LOCATION_GROUPS, findLocation } from '@/lib/locations'
import { generateRoutineDates } from '@/lib/routine'
import NumberStepper from './NumberStepper'

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
  approvable: { id: string; code: string }[]
}

/** v1.230 — ใบหนึ่งใบในชุด (จาก GET /api/admin/routine?groupId=) */
type GroupItem = {
  id: string; code: string; date: string; status: string
  callTime: string | null; estimatedWrap: string | null
  locationName: string | null; producer: string | null; producerEmail: string | null
  assignedEmails: string[]
  /** true = มี event · false = CONFIRMED แต่ไม่มี event (รูที่ reconciler ไม่เก็บ) · null = ยังไม่ถึงคิว */
  calendarOk: boolean | null
  calendarSyncStatus: string | null
}

/**
 * v1.228 — หน่วงระหว่างใบตอนอนุมัติทั้งชุด
 *
 * ตัวคุมคือ **โควตา Google Sheets** ไม่ใช่โควตาห้อง (room-booking-reconcile
 * หน่วงตัวเอง 1200ms/ใบ และ cap 20 ใบต่อรอบอยู่แล้ว — loop นี้ไม่เกี่ยวกับมัน)
 *
 * อนุมัติ 1 ใบเรียก updateBookingRow 2 ครั้ง (driveBoxId ครั้งหนึ่ง ·
 * status+eventId อีกครั้ง) และแต่ละครั้งเสีย 2 request คือ values.get ทั้งคอลัมน์ A
 * แล้ว values.batchUpdate = **4 request ต่อใบ** โควตา Sheets คือ 60 อ่าน + 60 เขียน
 * ต่อนาทีต่อ user และ service account ตัวนี้ใช้ร่วมกับ worker ทุกตัว
 * ที่ 1500ms → ~64/นาที เกินพอดี (ชีท 429 จริงเมื่อ 2026-09-22)
 * ที่ 3000ms → ~32/นาที เหลือที่ให้ worker อื่นหายใจ
 *
 * google-sheets.ts ยังไม่มี retry เหมือน withDriveRetry ของ Drive — 429 หายเงียบ
 * และ **ไม่มี reconciler ตัวไหนเขียน status/approvedAt/driveBoxId กลับลงชีท**
 * (calendar-reconcile เติมให้แค่ calendarEventId) หลุดแล้วหลุดเลย
 */
const BULK_APPROVE_GAP_MS = 3000

/** เดาเวลา round-trip ต่อใบ ใช้ประเมินเวลาในกล่องยืนยันให้ไม่ต่ำกว่าจริง */
const BULK_APPROVE_RTT_MS = 800

/**
 * v1.230 — หน่วงของ "เพิ่มทีมงานทั้งชุด" สั้นกว่า approve เพราะ assign แตะชีท
 * แค่ครั้งเดียว (updateBookingRow 1 ครั้ง = 2 request) ส่วน approve แตะ 2 ครั้ง
 * (= 4 request) โควตาเดียวกันจึงรับได้ถี่กว่า
 */
const BULK_ASSIGN_GAP_MS = 2000

/**
 * v1.232 — AGN ไม่อยู่ในรายการ outlet ของ Routine Planner
 *
 * create-booking บังคับ `selectedEpisodeIds` + `projectId` สำหรับ Content Agency
 * (create-booking.ts:122-127) ซึ่ง payload ของหน้านี้ไม่มีทั้งคู่ → ทุกวันจะ fail
 * เลือก AGN ได้จึงเป็นกับดัก: กรอกครบทั้งฟอร์มแล้วได้ created 0 / failed N
 * และตัวอย่างรหัสใต้ช่องก็จะโกหก (AGN มินต์ `AGN-YYMMDD-NN` ไม่มีช่องรายการ)
 */
const ROUTINE_OUTLETS = OUTLETS.filter(o => o.code !== 'AGN')

type BulkItem = { id: string; code: string }
type BulkOutcome = { ok: number; skipped: number; failures: string[]; stoppedEarly: boolean }

/**
 * วน POST ทีละใบแบบหน่วงจังหวะ — ใช้ร่วมกันทั้งอนุมัติทั้งชุดและเพิ่มทีมงานทั้งชุด
 *
 * เขียนรวมเพราะกฎที่ยากคือกฎเดียวกันหมด: 409 ไม่ใช่ความล้มเหลว · ล้มรวด 5 ใบแรก
 * ต้องหยุด · สรุปต้องนับจากผลจริง ถ้าแยกสองก๊อปปี้ อีกอันจะลืมข้อใดข้อหนึ่งเสมอ
 */
async function runBulk(
  items: BulkItem[],
  gapMs: number,
  call: (item: BulkItem) => Promise<Response>,
  onProgress: (done: number, failed: number) => void,
): Promise<BulkOutcome> {
  const failures: string[] = []
  let skipped = 0
  let stoppedEarly = false
  for (let i = 0; i < items.length; i++) {
    try {
      const res = await call(items[i])
      // 409 = มีคนเปลี่ยนสถานะใบนี้ไปแล้วระหว่างนี้ ไม่ใช่ความผิดพลาดที่ต้องตามแก้
      if (res.status === 409) skipped++
      else if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        failures.push(`${items[i].code}: ${d.error || 'HTTP ' + res.status}`)
      }
    } catch (e: any) {
      failures.push(`${items[i].code}: ${e?.message || e}`)
    }
    onProgress(i + 1, failures.length)
    if (failures.length >= 5 && failures.length === i + 1) { stoppedEarly = true; break }
    if (i < items.length - 1) await new Promise(r => setTimeout(r, gapMs))
  }
  return { ok: items.length - failures.length - skipped, skipped, failures, stoppedEarly }
}

/** ข้อความสรุปที่พูดเฉพาะสิ่งที่รู้จริง */
function bulkSummary(verb: string, o: BulkOutcome, tail?: string): string {
  const parts = [`${verb} ${o.ok} ใบ`]
  if (o.skipped) parts.push(`ข้าม ${o.skipped} ใบ (มีคนเปลี่ยนสถานะไปก่อนแล้ว)`)
  if (o.failures.length) parts.push(`ไม่สำเร็จ ${o.failures.length} ใบ:\n${o.failures.slice(0, 10).join('\n')}`
    + (o.failures.length > 10 ? `\n…และอีก ${o.failures.length - 10} ใบ` : ''))
  if (o.stoppedEarly) parts.push('หยุดกลางคันเพราะล้มติดกัน 5 ใบแรก — ตรวจ Drive/ชีท/ปฏิทินก่อนกดใหม่')
  if (tail) parts.push(tail)
  return parts.join('\n\n')
}

export default function RoutinePlanner({ backHref }: { backHref?: string }) {
  // form state
  const [outletCode, setOutletCode] = useState('NWS')  // AGN ไม่อยู่ในลิสต์ ดู ROUTINE_OUTLETS
  /**
   * v1.232 — สองค่านี้ต้องแยกกัน ห้ามใช้ช่องเดียว
   *
   * create-booking ใส่ชื่อรายการลง Booking ID ก็ต่อเมื่อ programCode ของ episode
   * **ต่างจาก** ของใบจอง: ใบจองเก็บ *ประเภทตอน* (L/S/A/T) ส่วน episode เก็บ
   * *ชื่อรายการ* (TSN/MNW/…) หน้านี้เคยมีช่องเดียวแล้วส่งค่าเดียวกันไปทั้งสองที่
   * ค่าจึงหักล้างตัวเอง ได้รหัส `WLT-260923-01` ที่ไม่มีชื่อรายการ (เจอจริง 135 ใบ)
   *
   * แยกตามกติกาเดียวกับ /new: code ยาว 1 ตัว = ประเภทตอน · ยาวกว่านั้น = ชื่อรายการ
   */
  const [programCode, setProgramCode] = useState('TSN')      // ชื่อรายการ (ไป episode)
  const [episodeType, setEpisodeType] = useState('L')        // ประเภทตอน (ไปใบจอง)
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
  const [locationId, setLocationId] = useState('')
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
  const showPrograms = programs.filter(p => p.code.length > 1)
  const typePrograms = programs.filter(p => p.code.length === 1)

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
    if (!showPrograms.find(p => p.code === programCode)) {
      setProgramCode(showPrograms[0]?.code || '')
    }
    if (!typePrograms.find(p => p.code === episodeType)) {
      setEpisodeType(typePrograms[0]?.code || 'L')
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

  // v1.66 — camera + mic counts are required (0 allowed, blank not).
  const camOk = cameraCount.trim() !== '' && Number.isInteger(Number(cameraCount)) && Number(cameraCount) >= 0
  const micOk = micCount.trim() !== '' && Number.isInteger(Number(micCount)) && Number(micCount) >= 0
  const canGenerate = !!preview && !preview.error && preview.dates.length > 0 && !!producer.trim() && !!episodeTitle.trim() && camOk && micOk

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
          outletCode,
          programCode: episodeType,        // ใบจอง = ประเภทตอน
          episodeProgramCode: programCode, // episode = ชื่อรายการ (ตัวที่ไปอยู่ในรหัส)
          episodeTitle, category, shootType,
          callTime, estimatedWrap, locationId,
          locationName: findLocation(locationId)?.fullName || null, producer,
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

  // v1.228/v1.230 — งานเป็นก้อนที่กำลังวิ่งอยู่ (null = ว่าง) ใช้ร่วมกันทั้งอนุมัติและเพิ่มทีมงาน
  const [busy, setBusy] = useState<{ groupId: string; label: string; done: number; total: number; failed: number } | null>(null)
  // v1.230 — ชุดที่กางรายการอยู่ + ใบในแต่ละชุด (cache ไว้ต่อชุด)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [items, setItems] = useState<Record<string, GroupItem[]>>({})
  const [itemsLoading, setItemsLoading] = useState<string | null>(null)

  const loadItems = (groupId: string) => {
    setItemsLoading(groupId)
    fetch(`/api/admin/routine?groupId=${encodeURIComponent(groupId)}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { items: [] })
      .then(d => setItems(prev => ({ ...prev, [groupId]: d.items || [] })))
      .catch(() => {})
      .finally(() => setItemsLoading(null))
  }
  const toggleExpand = (groupId: string) => {
    if (expanded === groupId) { setExpanded(null); return }
    setExpanded(groupId)
    if (!items[groupId]) loadItems(groupId)
  }

  /**
   * อนุมัติทุกใบที่รออนุมัติในชุดนี้ — เรียก endpoint อนุมัติ "ใบเดียว" ตัวเดิม
   * ทีละใบ ไม่เขียน endpoint อนุมัติแบบกลุ่มขึ้นมาใหม่
   *
   * ทำแบบนี้เพราะ /api/admin/[id]/approve มีของที่ต้องถูกต้องอยู่ 400 บรรทัด
   * (กันอนุมัติซ้ำด้วย CAS ของ calendarEventId, กัน CANCELLED/deleted, กันสร้าง
   * event ซ้ำ, เมลยืนยัน, Drive, ชีท, OT) การก๊อปมาทำใหม่เป็นเวอร์ชันกลุ่ม
   * แปลว่าต้องดูแลสองทางให้ตรงกันตลอดไป และทางที่สองจะเป็นทางที่เพี้ยนก่อนเสมอ
   */
  /** อ่านรายการใบล่าสุดของชุด — ห้ามใช้ snapshot ตอนเปิดหน้า (อาจค้างมาหลายชั่วโมง) */
  const freshApprovable = async (g: Group): Promise<BulkItem[] | null> => {
    try {
      const d = await fetch('/api/admin/routine', { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      const found = d?.groups?.find((x: Group) => x.routineGroupId === g.routineGroupId)
      if (!found) { alert('ไม่พบชุดนี้แล้ว — รีเฟรชหน้า'); loadGroups(); return null }
      return found.approvable || []
    } catch (e: any) {
      alert('อ่านรายการล่าสุดไม่สำเร็จ ยังไม่ได้ทำอะไรทั้งนั้น: ' + (e?.message || e)); return null
    }
  }

  /**
   * อนุมัติทุกใบที่รออนุมัติในชุดนี้ — เรียก endpoint อนุมัติ "ใบเดียว" ตัวเดิมทีละใบ
   *
   * /api/admin/[id]/approve มีของที่ต้องถูกต้องอยู่ 400 บรรทัด (CAS กัน event ซ้ำ,
   * กัน CANCELLED/deleted, เมลยืนยัน, Drive, ชีท, OT) ก๊อปมาทำเวอร์ชันกลุ่ม
   * แปลว่าต้องดูแลสองทางให้ตรงกันตลอดไป และทางที่สองจะเป็นทางที่เพี้ยนก่อน
   */
  const approveGroup = async (g: Group) => {
    const items = await freshApprovable(g)
    if (!items) return
    if (items.length === 0) { alert('ชุดนี้ไม่มีใบที่รออนุมัติแล้ว'); loadGroups(); return }
    const mins = Math.ceil(items.length * (BULK_APPROVE_GAP_MS + BULK_APPROVE_RTT_MS) / 60000)
    if (!confirm(
      `อนุมัติ ${items.length} ใบในชุดนี้?\n${g.outlet} · ${g.program} · ${g.from} – ${g.to}\n\n`
      + `ทุกใบจะถูกสร้างโฟลเดอร์ Drive + event ปฏิทิน และรอบถัดไประบบจะจองห้องให้\n`
      + `ปล่อยทีละใบห่างกัน ${BULK_APPROVE_GAP_MS / 1000} วิ กันชนโควตา Google Sheets — ราว ${mins} นาที\n`
      + `อย่าปิดแท็บนี้จนกว่าจะเสร็จ`
    )) return

    setBusy({ groupId: g.routineGroupId, label: 'อนุมัติ', done: 0, total: items.length, failed: 0 })
    const out = await runBulk(items, BULK_APPROVE_GAP_MS,
      it => fetch(`/api/admin/${it.id}/approve`, { method: 'POST' }),
      (done, failed) => setBusy({ groupId: g.routineGroupId, label: 'อนุมัติ', done, total: items.length, failed }))
    setBusy(null); loadGroups(); if (expanded === g.routineGroupId) loadItems(g.routineGroupId)
    // endpoint ตอบ 200 ทันทีที่สถานะเป็น CONFIRMED ส่วน Drive/ปฏิทิน/ชีท/เมล/OT
    // วิ่งต่อเป็น background ที่อยู่นานกว่า response — พูดได้แค่ "ตั้งสถานะแล้ว"
    alert(bulkSummary('ตั้งเป็น CONFIRMED แล้ว', out, 'ปฏิทิน โฟลเดอร์ และแถวชีทตามมาเป็นเบื้องหลัง — กดดูรายการในชุดเพื่อตรวจ'))
  }

  /**
   * v1.230 — เพิ่มทีมงานให้ทุกใบในชุด
   *
   * **เพิ่ม ไม่ใช่แทนที่** — assign endpoint เขียนทับ assignedEmails ทั้งก้อน
   * ถ้าส่งไปตรง ๆ ใบที่เคยจัดคนไว้รายวันจะถูกล้าง ที่นี่จึงอ่านของเดิมของแต่ละใบ
   * มา merge ก่อนเสมอ ปุ่มนี้ลบใครออกไม่ได้โดยตั้งใจ (ถอนคนทำทีละใบในคิวงาน)
   *
   * sendEmail:false เสมอ — คนเดียวถูกใส่ 67 ใบ = เมล 67 ฉบับใน 2 นาที
   * ซึ่งเป็นทั้งรูปแบบที่สแปมฟิลเตอร์จับและเป็นการเผาโควตาส่งเปล่า ๆ
   */
  const assignGroup = async (g: Group) => {
    const rows = items[g.routineGroupId]
    if (!rows || rows.length === 0) { alert('กดดูรายการในชุดก่อน แล้วค่อยเพิ่มทีมงาน'); return }
    const live = rows.filter(r => r.status !== 'CANCELLED')
    if (live.length === 0) { alert('ชุดนี้ไม่มีใบที่ยังใช้งานอยู่'); return }

    const raw = prompt(
      `เพิ่มทีมงานให้ ${live.length} ใบในชุดนี้ (คั่นด้วยจุลภาค)\n`
      + `เป็นการ "เพิ่ม" ไม่ใช่แทนที่ — คนที่จัดไว้เดิมในแต่ละใบยังอยู่ครบ\n`
      + `ไม่ส่งอีเมลแจ้ง (ป้องกันเมล ${live.length} ฉบับถึงคนเดียว) — แจ้งเขาเองทีเดียว`,
      '')
    if (raw === null) return
    const add = raw.split(',').map(x => x.trim().toLowerCase()).filter(x => x.includes('@'))
    if (add.length === 0) { alert('ไม่พบอีเมลที่ใช้ได้'); return }

    const mins = Math.ceil(live.length * (BULK_ASSIGN_GAP_MS + BULK_APPROVE_RTT_MS) / 60000)
    if (!confirm(`เพิ่ม ${add.join(', ')}\nให้ ${live.length} ใบ · ใช้เวลาราว ${mins} นาที\nอย่าปิดแท็บนี้`)) return

    setBusy({ groupId: g.routineGroupId, label: 'เพิ่มทีมงาน', done: 0, total: live.length, failed: 0 })
    const byId = new Map(live.map(r => [r.id, r]))
    const out = await runBulk(
      live.map(r => ({ id: r.id, code: r.code })),
      BULK_ASSIGN_GAP_MS,
      it => {
        const cur = byId.get(it.id)?.assignedEmails || []
        const merged = Array.from(new Set([...cur.map(e => e.trim().toLowerCase()), ...add])).filter(Boolean)
        return fetch(`/api/admin/${it.id}/assign`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignedEmails: merged, sendEmail: false }),
        })
      },
      (done, failed) => setBusy({ groupId: g.routineGroupId, label: 'เพิ่มทีมงาน', done, total: live.length, failed }))
    setBusy(null); loadItems(g.routineGroupId); loadGroups()
    alert(bulkSummary('เพิ่มทีมงานแล้ว', out, 'ไม่ได้ส่งอีเมลแจ้ง — บอกเขาเองทีเดียว'))
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
      {backHref && (
        <BackButton fallback={backHref} label="Admin Console" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3" />
      )}

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
                  {ROUTINE_OUTLETS.map(o => <option key={o.code} value={o.code}>{o.code} · {o.name}</option>)}
                </select>
              </div>
              <div>
                <label className="ops-label">รายการ</label>
                <select className="ops-input" value={programCode} onChange={e => setProgramCode(e.target.value)}>
                  {showPrograms.map(p => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              {/* v1.232 — ประเภทตอนแยกจากรายการ ตรงกับ /new · ตัวที่โผล่ในรหัสใบจองคือ "รายการ" */}
              <label className="ops-label">Episode Type</label>
              <select className="ops-input" value={episodeType} onChange={e => setEpisodeType(e.target.value)}>
                {typePrograms.map(p => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                รหัสใบจองจะเป็น <span className="font-mono">{outletCode}-{programCode}-YYMMDD-NN</span>
              </p>
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
              {/* v1.195 — เดิมเป็นช่องพิมพ์อิสระ ผลคือมีคนพิมพ์ "สตูดิโอ 1" แล้วสร้าง
                  ไป 128 ใบ กลายเป็นค่าสถานที่ที่พบมากที่สุดในระบบ ซึ่งแมปกับห้องจริง
                  ไม่ได้เลย. ใช้ลิสต์เดียวกับฟอร์มจองปกติ (locations.ts) */}
              <select className="ops-input" value={locationId} onChange={e => setLocationId(e.target.value)}>
                <option value="">— เลือกห้อง / สถานที่ —</option>
                {LOCATION_GROUPS.map(g => (
                  <optgroup key={g.key} label={g.label}>
                    {LOCATIONS.filter(l => l.group === g.key).map(l => (
                      <option key={l.id} value={l.id}>{l.fullName}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
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
                <label className="ops-label">กล้อง <span className="ops-required">*</span></label>
                <NumberStepper min={0} max={50} ariaLabel="จำนวนกล้อง" placeholder="0" value={cameraCount} onChange={setCameraCount} />
              </div>
              <div>
                <label className="ops-label">ไมค์ <span className="ops-required">*</span></label>
                <NumberStepper min={0} max={50} ariaLabel="จำนวนไมค์" placeholder="0" value={micCount} onChange={setMicCount} />
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
                  <div key={g.routineGroupId} className="border border-gray-100 rounded">
                    <div className="flex items-center justify-between gap-2 p-2">
                      {/* v1.230 — กดที่ชื่อชุดเพื่อกางรายการใบข้างใน */}
                      <button onClick={() => toggleExpand(g.routineGroupId)}
                        className="min-w-0 text-left flex items-start gap-1.5 hover:opacity-70">
                        <ChevronRight className={`w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400 transition-transform ${expanded === g.routineGroupId ? 'rotate-90' : ''}`} />
                        <span className="min-w-0">
                          <span className="block text-sm text-gray-800 font-medium truncate">{g.outlet} · {g.program}</span>
                          <span className="block text-[11px] text-gray-500">
                            {g.count} ใบ · {g.from} – {g.to} ·{' '}
                            {Object.entries(g.statuses).map(([st, n]) => `${st} ${n}`).join(', ')}
                          </span>
                        </span>
                      </button>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {busy?.groupId === g.routineGroupId ? (
                          <span className="ops-btn ops-btn-sm inline-flex items-center gap-1 text-gray-600">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            {busy.label} {busy.done}/{busy.total}
                            {busy.failed > 0 && <span className="text-red-600">· ล้ม {busy.failed}</span>}
                          </span>
                        ) : (
                          <>
                            {expanded === g.routineGroupId && (
                              <button onClick={() => assignGroup(g)} disabled={!!busy}
                                className="ops-btn ops-btn-sm text-[#673ab7] border border-[#673ab7]/30 hover:bg-[#673ab7]/5 disabled:opacity-50 inline-flex items-center gap-1"
                                title="เพิ่มทีมงานให้ทุกใบในชุด (เพิ่ม ไม่ใช่แทนที่ · ไม่ส่งอีเมล)">
                                <UserPlus className="w-3.5 h-3.5" /> เพิ่มทีมงาน
                              </button>
                            )}
                            {g.approvable?.length > 0 && (
                              <button onClick={() => approveGroup(g)} disabled={!!busy}
                                className="ops-btn ops-btn-sm text-green-700 border border-green-200 hover:bg-green-50 disabled:opacity-50 inline-flex items-center gap-1"
                                title={`อนุมัติ ${g.approvable.length} ใบที่รออนุมัติในชุดนี้`}>
                                <CheckCheck className="w-3.5 h-3.5" /> อนุมัติทั้งชุด ({g.approvable.length})
                              </button>
                            )}
                            <button onClick={() => cancelGroup(g)} disabled={!!busy}
                              className="ops-btn ops-btn-sm text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50 inline-flex items-center gap-1">
                              <Trash2 className="w-3.5 h-3.5" /> ลบทั้งชุด
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {expanded === g.routineGroupId && (
                      <div className="border-t border-gray-100 px-2 py-1.5 bg-gray-50/60">
                        {itemsLoading === g.routineGroupId ? (
                          <p className="text-xs text-gray-400 py-2">กำลังโหลด…</p>
                        ) : (items[g.routineGroupId] || []).length === 0 ? (
                          <p className="text-xs text-gray-400 py-2">ไม่มีใบในชุดนี้</p>
                        ) : (
                          <div className="max-h-72 overflow-y-auto">
                            <table className="w-full text-[11px]">
                              <thead className="text-gray-400">
                                <tr className="text-left">
                                  <th className="py-1 pr-2 font-normal">วันถ่าย</th>
                                  <th className="py-1 pr-2 font-normal">รหัส</th>
                                  <th className="py-1 pr-2 font-normal">สถานะ</th>
                                  <th className="py-1 pr-2 font-normal">ปฏิทิน</th>
                                  <th className="py-1 font-normal">ทีมงาน</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(items[g.routineGroupId] || []).map(it => (
                                  <tr key={it.id} className="border-t border-gray-100">
                                    <td className="py-1 pr-2 whitespace-nowrap text-gray-600">{it.date}</td>
                                    <td className="py-1 pr-2 whitespace-nowrap">
                                      <a href={`/dashboard/${it.id}`} className="gf-link font-mono">{it.code}</a>
                                    </td>
                                    <td className="py-1 pr-2 whitespace-nowrap text-gray-600">{it.status}</td>
                                    <td className="py-1 pr-2 whitespace-nowrap">
                                      {it.calendarOk === true ? <span className="text-green-600">✓</span>
                                        : it.calendarOk === false ? <span className="text-red-600" title={it.calendarSyncStatus || 'ไม่มี event'}>ไม่มี event</span>
                                        : <span className="text-gray-300">–</span>}
                                    </td>
                                    <td className="py-1 text-gray-500 truncate max-w-[16rem]" title={it.assignedEmails.join(', ')}>
                                      {it.assignedEmails.length === 0
                                        ? <span className="text-gray-300">ยังไม่มี</span>
                                        : it.assignedEmails.map(e => e.split('@')[0]).join(', ')}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
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
