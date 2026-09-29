'use client'

/**
 * v1.249 — ภาระงาน & ผลงานทีมเสียง (dashboard) · เฉพาะ Sound Admin + แอดมิน
 *
 * operator 29 ก.ย. 2569: "เก็บ data การทำงานมิกซ์ · performance ทีมงานทุกคน · export.csv · monitor ใคร load มาก น้อย"
 *
 * ตัวเลขทั้งหมดมาจาก /api/mix/stats (mix-stats.ts) ชุดเดียวกับ CSV — หน้านี้แค่วาด ไม่คิดเอง
 * โหลดไม่ได้ ≠ ศูนย์ (bug-classes #2): error แสดงเป็น error ไม่มีตัวเลขศูนย์หลอก ๆ · โหลดช่วงใหม่ = ภาพเดิมจางลง
 * ไม่กระพริบ · export ดึงผ่าน fetch แล้วเช็กผลก่อนบันทึกไฟล์ (ลิงก์ตรงจะบันทึก JSON error เป็น .csv)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react'
import { addDaysKey, bangkokDateKey, isValidISODate } from '@/lib/mix-jobs'
import { MIX_LOAD_BAND_LABEL, type MixLoadBand, type MixPersonStats, type MixTeamStats } from '@/lib/mix-stats'

interface StatsData {
  range: { from: string; to: string }
  today: string
  generatedAt: string
  team: MixTeamStats
  people: MixPersonStats[]
  legacyJobs: number
}

type Preset = 'thisMonth' | 'lastMonth' | 'last30' | 'last90'

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'thisMonth', label: 'เดือนนี้' },
  { key: 'lastMonth', label: 'เดือนก่อน' },
  { key: 'last30', label: '30 วันล่าสุด' },
  { key: 'last90', label: '90 วันล่าสุด' },
]

function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number)
  const end = new Date(0)
  end.setUTCFullYear(y, m, 0)
  return { from: `${ym}-01`, to: end.toISOString().slice(0, 10) }
}

function presetRange(p: Preset, today: string): { from: string; to: string } {
  if (p === 'thisMonth') return monthBounds(today.slice(0, 7))
  if (p === 'lastMonth') return monthBounds(addDaysKey(`${today.slice(0, 7)}-01`, -1).slice(0, 7))
  return { from: addDaysKey(today, p === 'last30' ? -29 : -89), to: today }
}

/** ชั่วโมง → ข้อความสั้น: นาที / ชม. / วัน */
function fmtHours(h: number | null): string {
  if (h === null) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} นาที`
  if (h < 48) return `${Math.round(h * 10) / 10} ชม.`
  return `${Math.round((h / 24) * 10) / 10} วัน`
}

const fmtPct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`)

function fmtDay(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('th-TH-u-ca-gregory', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
}

/* ── สีของภาระตอนนี้ (ความใกล้กำหนด = สถานะ ไม่ใช่ตัวตน) · ตรวจด้วย validate_palette แล้ว — ป้ายกำกับทุกสี ── */
const SEGMENTS = [
  { key: 'openOverdue', label: 'เลยกำหนด', color: '#d03b3b', icon: '⚠' },
  { key: 'openDueSoon', label: 'ใกล้กำหนด (≤2 วัน)', color: '#fab219', icon: '' },
  { key: 'openLater', label: 'กำหนดหลังจากนั้น', color: '#2a78d6', icon: '' },
  { key: 'openNoDue', label: 'ไม่มีกำหนด', color: '#898781', icon: '' },
] as const

const BAND_STYLE: Record<MixLoadBand, string> = {
  high: 'bg-red-50 text-red-800 border-red-200',
  normal: 'bg-gray-50 text-gray-700 border-gray-200',
  low: 'bg-blue-50 text-blue-800 border-blue-200',
  idle: 'bg-white text-gray-500 border-gray-200',
}

const displayName = (p: MixPersonStats) => p.name || p.email.split('@')[0]

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-gray-200 bg-white px-3 py-2.5">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold text-gray-900 leading-tight">{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

interface Tip { x: number; y: number; value: string; label: string }

function LoadChart({ people, mean }: { people: MixPersonStats[]; mean: number }) {
  const max = Math.max(1, mean, ...people.map(p => p.open))
  const box = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const show = (e: React.MouseEvent | React.FocusEvent, value: string, label: string) => {
    const host = box.current?.getBoundingClientRect()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (!host) return
    setTip({ x: r.left - host.left + r.width / 2, y: r.top - host.top, value, label })
  }
  const meanPct = (mean / max) * 100
  return (
    <div ref={box} className="relative" onMouseLeave={() => setTip(null)}>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 mb-3" aria-label="คำอธิบายสี">
        {SEGMENTS.map(s => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.icon && <span aria-hidden>{s.icon}</span>}{s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-gray-500">
          <span className="inline-block w-px h-3 bg-gray-500" aria-hidden /> เฉลี่ยทีม {mean} งาน/คน
        </span>
      </div>
      <ul className="space-y-2.5">
        {people.map(p => (
          <li key={p.email} className="grid grid-cols-[minmax(0,7.5rem)_1fr] sm:grid-cols-[minmax(0,10rem)_1fr] items-center gap-2">
            <div className="min-w-0">
              <p className="text-sm text-gray-800 truncate" title={p.email}>{displayName(p)}</p>
              <span className={`inline-block text-[11px] px-1.5 rounded border ${BAND_STYLE[p.load]}`}>
                {MIX_LOAD_BAND_LABEL[p.load]}{!p.inRoster && ' · ไม่อยู่ในรายชื่อทีมเสียง'}
              </span>
            </div>
            <div className="flex items-center gap-2">
            {/* แถบกับเส้นเฉลี่ยวัดจากความกว้างเดียวกัน — ตัวเลขอยู่นอกแถบ ไม่ไปเบียดแถบที่ยาวสุดให้สั้นกว่าเส้นเฉลี่ย */}
            <div className="relative flex-1 h-6 flex items-center">
              {/* เส้นค่าเฉลี่ยทีม — hairline ทึบ ไม่ใช่เส้นประ */}
              <span className="absolute top-0 bottom-0 w-px bg-gray-400" style={{ left: `${meanPct}%` }} aria-hidden />
              <div className="flex h-4 gap-[2px]" style={{ width: `${(p.open / max) * 100}%` }}>
                {SEGMENTS.map((s, i) => {
                  const n = p[s.key]
                  if (!n) return null
                  const last = SEGMENTS.slice(i + 1).every(t => !p[t.key])
                  const text = `${s.label} ${n} งาน`
                  return (
                    <span
                      key={s.key}
                      tabIndex={0}
                      role="img"
                      aria-label={`${displayName(p)}: ${text}`}
                      onMouseEnter={e => show(e, `${n} งาน`, `${displayName(p)} · ${s.label}`)}
                      onFocus={e => show(e, `${n} งาน`, `${displayName(p)} · ${s.label}`)}
                      onBlur={() => setTip(null)}
                      className={`h-full outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-gray-900 ${last ? 'rounded-r' : ''}`}
                      style={{ flexGrow: n, flexBasis: 0, background: s.color, minWidth: 4 }}
                    />
                  )
                })}
              </div>
            </div>
            <span className="w-6 shrink-0 text-sm tabular-nums text-gray-800">{p.open}</span>
            </div>
          </li>
        ))}
      </ul>
      {tip && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 shadow-md"
          style={{ left: tip.x, top: tip.y - 6 }}
          role="status"
        >
          <p className="text-sm font-semibold text-gray-900">{tip.value}</p>
          <p className="text-[11px] text-gray-500 whitespace-nowrap">{tip.label}</p>
        </div>
      )}
    </div>
  )
}

export default function MixStatsDashboard() {
  const [today] = useState(() => bangkokDateKey())
  const [preset, setPreset] = useState<Preset | null>('thisMonth')
  const [range, setRange] = useState(() => presetRange('thisMonth', bangkokDateKey()))
  const [data, setData] = useState<StatsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(true)
  const [tick, setTick] = useState(0)
  const [exporting, setExporting] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    // ช่วงผิด = ไม่มีอะไรกำลังโหลด (ผู้ตรวจเจอ: คำขอเก่าถูกยกเลิกแล้ว วงหมุนเลยค้างตลอด)
    if (!isValidISODate(range.from) || !isValidISODate(range.to) || range.from > range.to) { setPending(false); return }
    let cancelled = false
    setPending(true)
    setError(null)
    fetch(`/api/mix/stats?from=${range.from}&to=${range.to}`, { cache: 'no-store' })
      .then(async res => {
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new Error(body?.error || `โหลดไม่สำเร็จ (${res.status})`)
        if (!body || !Array.isArray(body.people) || !body.team) throw new Error('ข้อมูลผิดรูปแบบ')
        if (!cancelled) setData(body as StatsData)
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ') })
      .finally(() => { if (!cancelled) setPending(false) })
    return () => { cancelled = true }
  }, [range, tick])

  const pick = (p: Preset) => { setPreset(p); setRange(presetRange(p, today)) }
  const setEdge = (edge: 'from' | 'to', v: string) => { setPreset(null); setRange(r => ({ ...r, [edge]: v })) }
  const rangeInvalid = !isValidISODate(range.from) || !isValidISODate(range.to) || range.from > range.to

  const download = useCallback(async (type: 'jobs' | 'people' | 'events') => {
    setExporting(type)
    setExportError(null)
    try {
      const res = await fetch(`/api/mix/export?type=${type}&from=${range.from}&to=${range.to}`, { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || `export ไม่สำเร็จ (${res.status})`)
      }
      const blob = await res.blob()
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `mix-${type}.csv`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'export ไม่สำเร็จ')
    } finally {
      setExporting(null)
    }
  }, [range])

  // ภาพของช่วงเดิมค้างไว้แบบจาง ระหว่างโหลดช่วงใหม่ — ไม่มีตัวเลขของช่วงหนึ่งใต้ชื่อของอีกช่วงแบบไม่รู้ตัว
  const stale = !!data && (data.range.from !== range.from || data.range.to !== range.to)
  const t = data?.team
  const people = useMemo(() => data?.people || [], [data])
  // คอลัมน์ "ลบระหว่างถือ" ขึ้นเฉพาะเมื่อมีคนลบงานที่ตัวเองถือ — ไม่ให้ตารางกว้างด้วยช่องศูนย์ทั้งแถว
  const anyDeleted = people.some(p => p.deletedWhileHolding > 0)
  const btn = (on: boolean) => `px-3 py-1.5 text-sm rounded-md ${on ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`

  return (
    <section className="space-y-4">
      {/* แถวตัวกรองแถวเดียว เหนือทุกอย่างที่มันกรอง */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map(p => (
          <button key={p.key} type="button" onClick={() => pick(p.key)} aria-pressed={preset === p.key} className={btn(preset === p.key)}>
            {p.label}
          </button>
        ))}
        <span className="inline-flex items-center gap-1 text-sm text-gray-600">
          <input type="date" value={range.from} onChange={e => setEdge('from', e.target.value)} aria-label="ตั้งแต่วันที่"
            className="px-2 py-1 border border-gray-300 rounded-md text-sm bg-white" />
          –
          <input type="date" value={range.to} onChange={e => setEdge('to', e.target.value)} aria-label="ถึงวันที่"
            className="px-2 py-1 border border-gray-300 rounded-md text-sm bg-white" />
        </span>
        <button type="button" onClick={() => setTick(n => n + 1)} disabled={pending} className="p-1.5 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-40" aria-label="โหลดใหม่" title="โหลดใหม่">
          <RefreshCw size={14} className={pending ? 'animate-spin' : ''} />
        </button>
        <span className="flex-1" />
        {/* ปุ่ม export เป็นกลุ่มเดียว — ขึ้นบรรทัดใหม่พร้อมกัน ไม่แตกครึ่งแถว */}
        <div className="flex flex-wrap gap-2">
        {(['jobs', 'people', 'events'] as const).map(type => (
          <button
            key={type} type="button" onClick={() => download(type)} disabled={!!exporting || rangeInvalid}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
            title={type === 'jobs' ? 'หนึ่งแถวต่องาน: รอแจก เวลาทำ ทันกำหนด' : type === 'people' ? 'สรุปรายคน ตัวเลขเดียวกับหน้านี้' : 'ประวัติทุกการเปลี่ยน: ขอ แจก ส่ง เปิดแก้ ยกเลิก'}
          >
            {exporting === type ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} aria-hidden />}
            CSV {type === 'jobs' ? 'รายงาน' : type === 'people' ? 'รายคน' : 'ประวัติ'}
          </button>
        ))}
        </div>
      </div>

      {rangeInvalid && <p className="text-xs text-red-600">ช่วงวันที่ไม่ถูกต้อง — วันเริ่มต้องไม่หลังวันสิ้นสุด</p>}
      {exportError && (
        <p className="text-sm text-red-700 flex items-start gap-1.5"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{exportError}</p>
      )}

      {error ? (
        <div className="p-4 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
          <p className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{error} — ยังไม่รู้ตัวเลขของช่วงนี้</p>
          <button type="button" onClick={() => setTick(n => n + 1)} className="mt-2 px-3 py-1.5 text-sm rounded-md bg-white border border-red-300 hover:bg-red-100">ลองใหม่</button>
        </div>
      ) : !data ? (
        <p className="py-12 text-center text-sm text-gray-400 inline-flex items-center gap-2 w-full justify-center">
          <Loader2 size={16} className="animate-spin" /> กำลังคำนวณ…
        </p>
      ) : (
        <div className={`space-y-4 transition-opacity ${stale || pending ? 'opacity-60' : ''}`} aria-busy={pending}>
          <p className="text-xs text-gray-500">
            ช่วง {fmtDay(data.range.from)} – {fmtDay(data.range.to)} · คำนวณเมื่อ {data.generatedAt} น.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <StatTile label="คำขอเข้า" value={String(t!.requested)} sub={t!.cancelled ? `ยกเลิก ${t!.cancelled}` : undefined} />
            <StatTile label="ส่งงานแล้ว" value={String(t!.delivered)} />
            <StatTile label="ส่งทันกำหนด" value={fmtPct(t!.onTimeRate)} sub={t!.onTime + t!.late ? `${t!.onTime} จาก ${t!.onTime + t!.late} งานที่มีกำหนด` : 'ยังไม่มีงานที่มีกำหนดส่งในช่วงนี้'} />
            <StatTile label="เวลาทำ (มัธยฐาน)" value={fmtHours(t!.medianHoursHeld)} sub="รับงาน → ส่งครั้งแรก" />
            <StatTile label="รอแจก (มัธยฐาน)" value={fmtHours(t!.medianQueueWaitHours)} sub="ขอ → แจกครั้งแรก" />
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3 sm:p-4">
            <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2">
              <h3 className="text-sm font-medium text-gray-800">ภาระตอนนี้รายคน</h3>
              <p className="text-xs text-gray-500">
                ตอนนี้ รอแจก <b className="text-gray-900">{t!.openQueued}</b> · กำลังทำ <b className="text-gray-900">{t!.openInProgress}</b>
                {t!.openOverdue > 0 && <> · <span className="text-red-700">⚠ เลยกำหนด <b>{t!.openOverdue}</b></span></>}
              </p>
            </div>
            {people.length === 0
              ? <p className="text-sm text-gray-400 py-4">ยังไม่มีรายชื่อทีมเสียงในระบบ — เพิ่มที่ /admin/team</p>
              : <LoadChart people={people} mean={t!.meanOpenPerPerson} />}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left text-sm font-medium text-gray-800 px-3 sm:px-4 pt-3">ผลงานในช่วงนี้รายคน</caption>
              <thead>
                <tr className="text-xs text-gray-500 text-right border-b border-gray-100 whitespace-nowrap">
                  <th className="text-left font-normal px-3 sm:px-4 py-2">ชื่อ</th>
                  <th className="font-normal px-2 py-2">ถืออยู่</th>
                  <th className="font-normal px-2 py-2">เลยกำหนด</th>
                  <th className="font-normal px-2 py-2">ได้รับงาน</th>
                  <th className="font-normal px-2 py-2">ส่งแล้ว</th>
                  <th className="font-normal px-2 py-2">ทันกำหนด</th>
                  <th className="font-normal px-2 py-2">เวลาทำ</th>
                  <th className="font-normal px-2 py-2">ส่งแก้</th>
                  <th className="font-normal px-3 sm:px-4 py-2">โอนต่อ</th>
                  {anyDeleted && <th className="font-normal px-3 sm:px-4 py-2">ลบระหว่างถือ</th>}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {people.map(p => (
                  <tr key={p.email} className="border-b border-gray-50 text-right">
                    <td className="text-left px-3 sm:px-4 py-2 text-gray-800 whitespace-nowrap" title={p.email}>
                      {displayName(p)}{!p.inRoster && <span className="text-xs text-gray-400"> (ไม่อยู่ในรายชื่อทีมเสียง)</span>}
                    </td>
                    <td className="px-2 py-2">{p.open}</td>
                    <td className={`px-2 py-2 ${p.openOverdue ? 'text-red-700 font-medium' : 'text-gray-400'}`}>{p.openOverdue}</td>
                    <td className="px-2 py-2">{p.assigned}</td>
                    <td className="px-2 py-2">{p.delivered}</td>
                    <td className="px-2 py-2" title={p.onTime + p.late ? `${p.onTime} ทัน · ${p.late} ไม่ทัน` : 'ยังไม่มีงานที่มีกำหนดส่ง'}>{fmtPct(p.onTimeRate)}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{fmtHours(p.medianHoursHeld)}</td>
                    <td className="px-2 py-2">{p.redelivered}</td>
                    <td className="px-3 sm:px-4 py-2">{p.handedOff}</td>
                    {anyDeleted && <td className={`px-3 sm:px-4 py-2 ${p.deletedWhileHolding ? 'text-amber-700 font-medium' : 'text-gray-400'}`}>{p.deletedWhileHolding}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="text-[11px] text-gray-500 space-y-0.5">
            <p>ได้รับงาน = เริ่มถืองานใหม่ในช่วงนี้ · ส่งแล้ว = ส่งครั้งแรกในช่วงนี้ (เครดิตคนที่ถืองานตอนส่ง) · ทันกำหนด = ส่งครั้งแรกไม่เกินวันที่ต้องการไฟล์ ณ ตอนส่ง (เวลาไทย)</p>
            <p>เวลาทำ = ตั้งแต่ได้รับงานถึงส่งครั้งแรก นับเวลาจริงรวมกลางคืน/วันหยุด · ส่งแก้ = ส่งซ้ำหลังเปิดงานกลับมาแก้ · โอนต่อ = งานที่ถูกแจกให้คนอื่นแทน · งานที่ถูกลบทีหลังยังนับผลงานที่เกิดไปแล้ว</p>
            {data.legacyJobs > 0 && (
              <p>งาน {data.legacyJobs} งานมีอยู่ก่อนเริ่มเก็บประวัติ (v1.249) — ช่วงต้นของงานเหล่านี้สร้างจากข้อมูลในงาน ใน CSV ประวัติติดป้ายไว้</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
