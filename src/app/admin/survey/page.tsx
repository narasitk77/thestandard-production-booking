'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import { Loader2 } from 'lucide-react'
import { SURVEY, HOURS_PER_WEEK, type Summary } from '@/lib/survey'

/* =============================================================================
   /admin/survey — v1.278. ผล "probook ช่วยประหยัดเวลาแค่ไหน" + เปิด/ปิดรับคำตอบ
   ตัวเลขชั่วโมงเป็นค่าประมาณจากช่วงที่คนตอบเลือก (ค่ากลางของช่วง) ไม่ใช่การจับเวลา
   ============================================================================= */

type Payload = {
  key: string; open: boolean; participants: number; eligible: number
  volume30d: { booked: number; approved: number }
  /** null ระหว่างเปิดรับ — ผลรวมโชว์หลังปิดรับเท่านั้น (กันเทียบก่อน/หลังว่าใครตอบอะไร) */
  summary: Summary | null
  queueHidden?: boolean
  queueMin: number
}

const fmt = (n: number | null, d = 1) => (n === null ? '–' : n.toLocaleString('th-TH', { maximumFractionDigits: d }))

export default function AdminSurveyPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const r = await fetch('/api/admin/survey')
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setData(d)
    } catch (e: any) { setError(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  const toggle = async () => {
    if (!data) return
    const open = !data.open
    if (!confirm(open ? 'เปิดรับคำตอบ? การ์ดชวนตอบจะโผล่บนหน้าแรกของคนจองงานและทีมจัดคิวทันที' : 'ปิดรับคำตอบ? การ์ดชวนตอบจะหายไป')) return
    setBusy(true)
    try {
      const r = await fetch('/api/admin/survey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      await load()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  if (error && !data) return <div className="max-w-3xl mx-auto px-4 py-10 text-sm text-red-700">{error}</div>
  if (!data) return <div className="max-w-3xl mx-auto px-4 py-10 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด…</div>

  const s = data.summary
  const rate = data.eligible ? (data.participants / data.eligible) * 100 : null
  const header = (
    <>
      <BackButton fallback="/admin" />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1>ผลแบบสำรวจ</h1>
          <p className="text-xs text-gray-500 mt-0.5">{SURVEY.title} · รอบ <span className="font-mono">{data.key}</span></p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/survey" className="ops-btn-secondary text-sm">ดูหน้าแบบสำรวจ</Link>
          <button onClick={toggle} disabled={busy} className={data.open ? 'ops-btn-secondary text-sm' : 'ops-btn-primary text-sm'}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : data.open ? 'ปิดรับคำตอบ' : 'เปิดรับคำตอบ'}
          </button>
        </div>
      </div>
      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}
      <div className={`text-sm rounded-lg border p-3 ${data.open ? 'bg-green-50 border-green-200 text-green-900' : 'bg-gray-50 border-gray-200 text-gray-700'}`}>
        {data.open ? '🟢 เปิดรับคำตอบอยู่ — คนจองงาน/ทีมจัดคิวที่ยังไม่ตอบเห็นการ์ดชวนบนหน้าแรก'
          : '⚪ ปิดรับคำตอบ — ไม่มีใครเห็นการ์ดชวน · หน้าแบบสำรวจเป็นโหมดดูตัวอย่าง (ไม่บันทึก)'}
      </div>
    </>
  )

  if (!s) {
    return (
      <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4">
        {header}
        <div className="grid grid-cols-2 gap-3">
          <Kpi label="ตอบแล้ว" value={`${data.participants}`} sub={`จาก ${data.eligible} คนที่มีสิทธิ์${rate !== null ? ` · ${fmt(rate, 0)}%` : ''}`} />
          <Kpi label="ฐานคำนวณ 30 วัน" value={`${data.volume30d.booked} / ${data.volume30d.approved}`} sub="ใบที่จอง / การอนุมัติ (ไม่นับ routine)" />
        </div>
        <div className="gf-card p-4 text-sm text-gray-700">
          🙈 ผลรวมจะแสดงเมื่อ <b>ปิดรับคำตอบ</b> แล้ว — ระหว่างเปิดรับ ถ้ารีเฟรชดูก่อน/หลังคนหนึ่งตอบ จะเห็นคำตอบทั้งชุดของเขา
          ซึ่งขัดกับที่บอกคนตอบไว้ว่าไม่ผูกชื่อกับคำตอบ
        </div>
      </div>
    )
  }
  const perMonth = (saved: number | null, n: number) => (saved === null ? null : (saved * n) / 60)

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4">
      {header}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="ตอบแล้ว" value={`${data.participants}`} sub={`จาก ${data.eligible} คนที่มีสิทธิ์${rate !== null ? ` · ${fmt(rate, 0)}%` : ''}`} />
        <Kpi label="ประหยัดต่อคน" value={s.hoursPerWeek.avg === null ? '–' : `${fmt(s.hoursPerWeek.avg)} ชม./สัปดาห์`} sub={`n=${s.hoursPerWeek.n} (ไม่นับ "ไม่แน่ใจ")`} />
        <Kpi label="ชอบ / ชอบมาก" value={s.feel.positivePct === null ? '–' : `${fmt(s.feel.positivePct, 0)}%`} sub={`เฉลี่ย ${fmt(s.feel.avg)} / 5`} />
        <Kpi label="แยกกลุ่ม" value={`${s.byGroup.booker} / ${s.byGroup.queue}`} sub="คนจองงาน / ทีมจัดคิว" />
      </div>

      <div className="gf-card p-4 space-y-3">
        <div className="font-medium text-gray-800">เวลาที่ประหยัดต่อใบ (ประมาณ)</div>
        <PerItem label="คนจองงาน — ตกลงคิว 1 งาน" p={s.perItem.booker} volume={data.volume30d.booked} volumeLabel="ใบที่จองใน 30 วัน (ไม่นับ routine)" perMonth={perMonth} />
        {data.queueHidden
          ? <div className="text-xs text-gray-500">ทีมจัดคิว — ซ่อนไว้จนมีคนตอบอย่างน้อย {data.queueMin} คน (ตอนนี้ {s.byGroup.queue} คน · กลุ่มเล็กจนรู้ตัวได้)</div>
          : <PerItem label="ทีมจัดคิว — จัดคิว 1 งาน" p={s.perItem.queue} volume={data.volume30d.approved} volumeLabel="การอนุมัติใน 30 วัน (ไม่นับ routine)" perMonth={perMonth} />}
        <p className="text-[11px] text-gray-500">ค่ากลางของช่วงที่เลือก · นับเฉพาะคนที่ทันวิธีเดิม · "มากกว่า X" ใช้ค่ากลาง ๆ ที่สมเหตุผล (ดู MINUTES ใน src/lib/survey.ts) · "ทำให้เสียเวลาเพิ่ม" นับ {HOURS_PER_WEEK.worse * 60} นาที/สัปดาห์</p>
      </div>

      <div className="gf-card p-4 space-y-5">
        {SURVEY.questions.filter(q => q.kind !== 'text' && !(q.group === 'queue' && data.queueHidden)).map(q => {
          const c = s.counts[q.id] || {}
          const max = Math.max(1, ...Object.values(c))
          const n = q.group ? s.byGroup[q.group] : s.total
          return (
            <div key={q.id}>
              <div className="text-sm font-medium text-gray-800">{q.title}{q.group && <span className="ml-2 text-xs font-normal text-gray-500">({q.group === 'booker' ? 'คนจองงาน' : 'ทีมจัดคิว'} · {n} คน)</span>}</div>
              <div className="mt-2 space-y-1">
                {q.options!.map(o => (
                  <div key={o.id} className="flex items-center gap-2 text-xs">
                    <span className="w-56 sm:w-72 shrink-0 text-gray-700 truncate" title={o.label}>{o.label}</span>
                    <span className="flex-1 h-3 bg-gray-100 rounded overflow-hidden"><span className="block h-full bg-[#0b8043]/70" style={{ width: `${((c[o.id] || 0) / max) * 100}%` }} /></span>
                    <span className="w-6 text-right tabular-nums text-gray-600">{c[o.id] || 0}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <Texts title="✨ ถ้าเสกได้ 1 อย่าง" items={s.texts.wish} />
      <Texts title="💬 อยากบอกนัท" items={s.texts.note} />
      <Texts title="✏️ ช่อง &quot;อื่น ๆ&quot;" items={s.texts.other} />
      <p className="text-[11px] text-gray-400">คำตอบไม่มีชื่อ/อีเมล/เวลา และถูกสลับลำดับทุกครั้งที่มีคนตอบ · ข้อความเรียงตามตัวอักษร · ข้อความที่พิมพ์เองอาจบอกตัวคนเขียนได้ — อย่าเอาไปไล่ถามรายคน</p>
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="gf-card p-3">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900 mt-0.5">{value}</div>
      <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>
    </div>
  )
}

function PerItem({ label, p, volume, volumeLabel, perMonth }: {
  label: string; p: Summary['perItem']['booker']; volume: number; volumeLabel: string
  perMonth: (saved: number | null, n: number) => number | null
}) {
  const h = perMonth(p.saved, volume)
  return (
    <div className="text-sm text-gray-700">
      <div className="font-medium">{label} <span className="text-xs font-normal text-gray-500">(n={p.n})</span></div>
      {p.n === 0 ? <div className="text-xs text-gray-500">ยังไม่มีคำตอบที่เทียบได้</div> : (
        <div className="text-xs mt-0.5">
          ก่อน ~{fmt(p.before, 0)} นาที → ตอนนี้ ~{fmt(p.now, 0)} นาที = ประหยัด ~<b>{fmt(p.saved, 0)} นาที/ใบ</b>
          {' '}× {volume} ({volumeLabel}) ≈ <b>{fmt(h)} ชม./เดือน</b>
        </div>
      )}
    </div>
  )
}

function Texts({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="gf-card p-4">
      <div className="text-sm font-medium text-gray-800">{title} <span className="text-xs font-normal text-gray-500">({items.length})</span></div>
      {items.length === 0 ? <div className="text-xs text-gray-500 mt-1">ยังไม่มี</div> : (
        <ul className="mt-2 space-y-2">{items.map((t, i) => <li key={i} className="text-sm text-gray-700 whitespace-pre-wrap border-l-2 border-gray-200 pl-3">{t}</li>)}</ul>
      )}
    </div>
  )
}
