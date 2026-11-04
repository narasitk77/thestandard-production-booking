'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import { Loader2 } from 'lucide-react'
import { SURVEY, type ScaleStat, type Summary } from '@/lib/survey'

/* =============================================================================
   /admin/survey — ผลแบบสำรวจการใช้งาน + เปิด/ปิดรับคำตอบ (v1.279 ชุดคำถามใหม่)
   ผลโชว์หลังปิดรับเท่านั้น · แยกทีมเฉพาะทีมที่มีคนตอบ ≥ teamMin
   ============================================================================= */

type Payload = {
  key: string; open: boolean; participants: number; eligible: number
  /** null ระหว่างเปิดรับ — ผลรวมโชว์หลังปิดรับเท่านั้น (กันเทียบก่อน/หลังว่าใครตอบอะไร) */
  summary: Summary | null
  teamMin: number
}

const fmt = (n: number | null, d = 1) => (n === null ? '–' : n.toLocaleString('th-TH', { maximumFractionDigits: d }))
const SCALES = SURVEY.questions.filter(q => q.kind === 'scale')

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
    if (!confirm(open ? 'เปิดรับคำตอบ? การ์ดชวนตอบจะโผล่บนหน้าแรกของคนจองคิวทันที' : 'ปิดรับคำตอบ? การ์ดชวนตอบจะหายไป')) return
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
  const responded = <Kpi label="ตอบแล้ว" value={`${data.participants}`} sub={`จาก ${data.eligible} คนที่มีสิทธิ์${rate !== null ? ` · ${fmt(rate, 0)}%` : ''}`} />

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4">
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
        {data.open ? '🟢 เปิดรับคำตอบอยู่ — คนจองคิวที่ยังไม่ตอบเห็นการ์ดชวนบนหน้าแรก'
          : '⚪ ปิดรับคำตอบ — ไม่มีใครเห็นการ์ดชวน · หน้าแบบสำรวจเป็นโหมดดูตัวอย่าง (ไม่บันทึก)'}
      </div>

      {!s ? (
        <>
          <div className="grid grid-cols-2 gap-3">{responded}</div>
          <div className="gf-card p-4 text-sm text-gray-700">
            🙈 ผลรวมจะแสดงเมื่อ <b>ปิดรับคำตอบ</b> แล้ว และมีคนตอบตั้งแต่ {data.teamMin} คน — ระหว่างเปิดรับ ถ้ารีเฟรชดูก่อน/หลังคนหนึ่งตอบ
            จะเห็นคำตอบทั้งชุดของเขา ซึ่งขัดกับที่บอกคนตอบไว้ว่าไม่ผูกชื่อกับคำตอบ
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {responded}
            {SCALES.map(q => {
              const st = s.scales[q.id]
              return <Kpi key={q.id} label={q.id === 'efficiency' ? 'เป็นระบบ/มีประสิทธิภาพ' : 'ความพึงพอใจ'}
                value={st.avg === null ? '–' : `${fmt(st.avg)} / 5`}
                sub={`4–5: ${fmt(st.topPct, 0)}% · 1–2: ${fmt(st.bottomPct, 0)}% · n=${st.n}${st.na ? ` · ตอบไม่ได้ ${st.na}` : ''}`} />
            })}
          </div>

          <div className="gf-card p-4 space-y-5">
            {SCALES.map(q => <ScaleBars key={q.id} title={q.title} labels={q.scale!} st={s.scales[q.id]} naLabel={q.na} />)}
          </div>

          <div className="gf-card p-4">
            <div className="text-sm font-medium text-gray-800">แยกตามทีม</div>
            {s.teams.length === 0 ? <div className="text-xs text-gray-500 mt-1">ยังแยกตามทีมไม่ได้ — คนตอบยังน้อย ถ้าแยกจะเทียบกับภาพรวมแล้วรู้ได้ว่าใครตอบอะไร</div> : (
              <table className="mt-2 w-full text-xs">
                <thead><tr className="text-gray-500 text-left"><th className="py-1 font-normal">ทีม</th><th className="font-normal text-right">คน</th>
                  {SCALES.map(q => <th key={q.id} className="font-normal text-right">{q.id === 'efficiency' ? 'ประสิทธิภาพ' : 'พึงพอใจ'}</th>)}</tr></thead>
                <tbody>
                  {s.teams.map(t => (
                    <tr key={t.id} className="border-t border-gray-100">
                      <td className="py-1.5 text-gray-800">{t.label}</td>
                      <td className="text-right tabular-nums">{t.n}</td>
                      {SCALES.map(q => <td key={q.id} className="text-right tabular-nums">{fmt(t.scales[q.id].avg)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {s.smallTeams > 0 && <p className="mt-2 text-[11px] text-gray-500">อีก {s.smallTeams} คนไม่แยกตามทีม (ทีมที่คนตอบไม่ถึง {data.teamMin} คน หรือทีมที่ต้องรวมไว้ด้วย เพื่อไม่ให้เอาภาพรวมมาลบแล้วรู้คำตอบของใครได้) แต่นับรวมในภาพรวมด้านบน</p>}
          </div>

          <div className="gf-card p-4">
            {SURVEY.questions.filter(q => q.kind === 'multi').map(q => {
              const c = s.counts[q.id] || {}
              const max = Math.max(1, ...Object.values(c))
              return (
                <div key={q.id}>
                  <div className="text-sm font-medium text-gray-800">{q.title} <span className="text-xs font-normal text-gray-500">({s.answered[q.id] || 0} จาก {s.total} คนที่ตอบข้อนี้)</span></div>
                  <div className="mt-2 space-y-1">
                    {q.options!.map(o => <Bar key={o.id} label={o.label} n={c[o.id] || 0} max={max} />)}
                  </div>
                </div>
              )
            })}
          </div>

          <Texts title="สิ่งที่อยากให้ปรับปรุงหรือพัฒนาเพิ่มเติม" items={s.texts.improve} />
          <Texts title={'ช่อง "อื่น ๆ"'} items={s.texts.other} />
          <p className="text-[11px] text-gray-400">คำตอบไม่มีชื่อ/อีเมล/เวลา และถูกสลับลำดับทุกครั้งที่มีคนตอบ · ข้อความเรียงตามตัวอักษร ไม่แยกตามทีม · ข้อความที่พิมพ์เองอาจบอกตัวคนเขียนได้ — อย่าเอาไปไล่ถามรายคน</p>
        </>
      )}
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

function ScaleBars({ title, labels, st, naLabel }: { title: string; labels: string[]; st: ScaleStat; naLabel?: string }) {
  const max = Math.max(1, ...Object.values(st.dist), st.na)
  return (
    <div>
      <div className="text-sm font-medium text-gray-800">{title}</div>
      <div className="mt-2 space-y-1">
        {labels.map((l, i) => <Bar key={l} label={`${i + 1} · ${l}`} n={st.dist[String(i + 1)] || 0} max={max} />)}
        {naLabel && <Bar label={naLabel} n={st.na} max={max} muted />}
      </div>
    </div>
  )
}

function Bar({ label, n, max, muted }: { label: string; n: number; max: number; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-56 sm:w-72 shrink-0 text-gray-700 truncate" title={label}>{label}</span>
      <span className="flex-1 h-3 bg-gray-100 rounded overflow-hidden"><span className={`block h-full ${muted ? 'bg-gray-300' : 'bg-[#0b8043]/70'}`} style={{ width: `${(n / max) * 100}%` }} /></span>
      <span className="w-6 text-right tabular-nums text-gray-600">{n}</span>
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
