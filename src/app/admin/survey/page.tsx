'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import BackButton from '@/app/_components/BackButton'
import { Loader2 } from 'lucide-react'
import { SURVEY, type Overrides, type ScaleStat, type Summary, type SurveyDef } from '@/lib/survey'

/* =============================================================================
   /admin/survey — ผลแบบสำรวจการใช้งาน + เปิด/ปิดรับคำตอบ (v1.279 ชุดคำถามใหม่)
   ผลโชว์หลังปิดรับเท่านั้น · แยกทีมเฉพาะทีมที่มีคนตอบ ≥ teamMin
   v1.279.3 — แก้คำบนจอได้ (คำนำ / หัวข้อ / คำอธิบาย / บังคับตอบ / ป้ายสเกล / ป้ายตัวเลือก) ไม่ต้อง deploy
   โครง (เพิ่ม-ลดข้อ/ตัวเลือก, id) ยังอยู่ในโค้ด — เปลี่ยนแล้วผลที่เก็บไปแล้วจะอ่านไม่ออก
   ============================================================================= */

type Payload = {
  key: string; open: boolean; participants: number; eligible: number
  /** null ระหว่างเปิดรับ — ผลรวมโชว์หลังปิดรับเท่านั้น (กันเทียบก่อน/หลังว่าใครตอบอะไร) */
  summary: Summary | null
  teamMin: number
  overrides: Overrides | null
  /** ชุดคำถามที่ใช้จริง = โค้ด + overrides */
  survey: SurveyDef
}

/** สถานะฟอร์มแก้คำ — ทุกช่องเป็นข้อความ (ว่าง = ใช้ของโค้ด) · required เป็น boolean */
type Draft = { intro: string; questions: Record<string, { title: string; help: string; required: boolean; scale: string[]; options: Record<string, string> }> }
function toDraft(ov: Overrides | null): Draft {
  return {
    intro: ov?.intro ?? '',
    questions: Object.fromEntries(SURVEY.questions.map(q => {
      const o = ov?.questions?.[q.id]
      return [q.id, {
        title: o?.title ?? '', help: o?.help ?? '', required: o?.required ?? q.required,
        scale: q.scale ? q.scale.map((_, i) => o?.scale?.[i] ?? '') : [],
        options: Object.fromEntries((q.options || []).map(x => [x.id, o?.options?.[x.id] ?? ''])),
      }]
    })),
  }
}

const fmt = (n: number | null, d = 1) => (n === null ? '–' : n.toLocaleString('th-TH', { maximumFractionDigits: d }))

export default function AdminSurveyPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState('')

  // keepDraft — maint 2026-11-08 (ui-18): toggling open/closed reloads the stats
  // but must not throw away wording the admin typed and hasn't saved yet.
  const load = useCallback(async (opts: { keepDraft?: boolean } = {}) => {
    setError('')
    try {
      const r = await fetch('/api/admin/survey')
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setData(d)
      setDraft(prev => (opts.keepDraft && prev ? prev : toDraft(d.overrides)))
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
      await load({ keepDraft: true })
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  /** บันทึกคำที่แก้ · null = กลับไปใช้คำในโค้ดทั้งหมด · server ตัดช่องว่าง/ช่องเปล่าให้ (validateOverrides) */
  const saveText = async (overrides: Draft | null) => {
    if (overrides === null && !confirm('ล้างคำที่แก้ไว้ทั้งหมด กลับไปใช้คำในโค้ด?')) return
    setBusy(true); setError(''); setSaved('')
    try {
      const r = await fetch('/api/admin/survey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      await load()
      setSaved(`บันทึกแล้ว ${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} — หน้า /survey ใช้คำใหม่ทันที`)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  if (error && !data) return <div className="max-w-3xl mx-auto px-4 py-10 text-sm text-red-700">{error}</div>
  if (!data) return <div className="max-w-3xl mx-auto px-4 py-10 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด…</div>

  const s = data.summary
  const S = data.survey ?? SURVEY
  const SCALES = S.questions.filter(q => q.kind === 'scale')
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
            {S.questions.filter(q => q.kind === 'multi').map(q => {
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

          <Texts title={S.questions.find(q => q.kind === 'text')?.title || 'ข้อความ'} items={s.texts.improve} />
          {(S.questions.some(q => q.other) || s.texts.other.length > 0) && <Texts title={'ช่อง "อื่น ๆ"'} items={s.texts.other} />}
          <p className="text-[11px] text-gray-400">คำตอบไม่มีชื่อ/อีเมล/เวลา และถูกสลับลำดับทุกครั้งที่มีคนตอบ · ข้อความเรียงตามตัวอักษร ไม่แยกตามทีม · ข้อความที่พิมพ์เองอาจบอกตัวคนเขียนได้ — อย่าเอาไปไล่ถามรายคน</p>
        </>
      )}

      {draft && (
        <div className="gf-card p-4 space-y-4">
          <div>
            <div className="text-sm font-medium text-gray-800">✏️ แก้คำบนจอ</div>
            <p className="text-xs text-gray-500 mt-0.5">ช่องว่าง = ใช้คำในโค้ด (เห็นเป็นตัวจาง) · บันทึกแล้วหน้า /survey เปลี่ยนทันที ไม่ต้อง deploy · เพิ่ม-ลดข้อหรือตัวเลือกต้องแก้โค้ด (ผลที่เก็บไปแล้วผูกกับ id)</p>
          </div>
          <Field label="คำนำใต้หัวข้อ" value={draft.intro} placeholder={SURVEY.intro} rows={2}
            onChange={v => setDraft({ ...draft, intro: v })} />
          {SURVEY.questions.map((q, i) => {
            const d = draft.questions[q.id]
            const setQ = (patch: Partial<Draft['questions'][string]>) => setDraft({ ...draft, questions: { ...draft.questions, [q.id]: { ...d, ...patch } } })
            return (
              <div key={q.id} className="border-t border-gray-100 pt-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-gray-700">ข้อ {i + 1} <span className="font-mono text-gray-400">{q.id}</span></div>
                  <label className={`text-xs flex items-center gap-1.5 ${q.id === 'team' ? 'text-gray-400' : 'text-gray-700'}`}>
                    <input type="checkbox" checked={d.required} disabled={q.id === 'team'} onChange={e => setQ({ required: e.target.checked })} /> บังคับตอบ
                  </label>
                </div>
                <Field label="หัวข้อ" value={d.title} placeholder={q.title} rows={2} onChange={v => setQ({ title: v })} />
                <Field label="คำอธิบายใต้หัวข้อ" value={d.help} placeholder={q.help || '(ไม่มี)'} onChange={v => setQ({ help: v })} />
                {q.kind === 'scale' && (
                  <div className="grid grid-cols-5 gap-1.5">
                    {q.scale!.map((l, k) => (
                      <input key={k} value={d.scale[k]} placeholder={l} aria-label={`ป้าย ${k + 1}`}
                        onChange={e => setQ({ scale: d.scale.map((x, j) => (j === k ? e.target.value : x)) })}
                        className="w-full rounded border border-gray-200 px-1.5 py-1 text-[11px] focus:outline-none focus:border-gray-400" />
                    ))}
                  </div>
                )}
                {q.options && (
                  <div className="space-y-1">
                    {q.options.map(o => (
                      <input key={o.id} value={d.options[o.id]} placeholder={o.label} aria-label={`ตัวเลือก ${o.id}`}
                        onChange={e => setQ({ options: { ...d.options, [o.id]: e.target.value } })}
                        className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:border-gray-400" />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {saved && <div className="text-xs text-green-700">{saved}</div>}
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => saveText(draft)} disabled={busy} className="ops-btn-primary text-sm">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'บันทึกคำที่แก้'}</button>
            <button onClick={() => saveText(null)} disabled={busy || !data.overrides} className="ops-btn-secondary text-sm">กลับไปใช้คำในโค้ด</button>
            <Link href="/survey" className="text-xs underline text-gray-500">ดูผลบนหน้าแบบสำรวจ</Link>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, placeholder, rows, onChange }: { label: string; value: string; placeholder: string; rows?: number; onChange: (v: string) => void }) {
  const cls = 'w-full rounded border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:border-gray-400'
  return (
    <label className="block">
      <span className="text-[11px] text-gray-500">{label}</span>
      {rows ? <textarea value={value} placeholder={placeholder} rows={rows} onChange={e => onChange(e.target.value)} className={cls} />
        : <input value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} className={cls} />}
    </label>
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
