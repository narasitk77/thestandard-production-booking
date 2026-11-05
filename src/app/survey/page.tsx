'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, Loader2 } from 'lucide-react'
import { SURVEY, OTHER_MAX, TEXT_MAX, type Question, type SurveyDef } from '@/lib/survey'

/* =============================================================================
   /survey — แบบสำรวจการใช้งาน (v1.279: ทุกข้อในหน้าเดียว · เดิม v1.278 ทีละคำถาม)
   ส่งครั้งเดียวตอนกด "ส่งคำตอบ" · ข้อบังคับที่ยังไม่ตอบขึ้นกรอบแดง แล้วเลื่อนไปข้อแรกที่ขาด
   โหมดดูตัวอย่าง = เฉพาะทีมจัดคิว/แอดมิน (canPreview) ตอนปิดรับหรือไม่มีสิทธิ์ตอบ — กรอกได้ครบ ไม่ยิง request
   คนจองคิวตอนปิดรับเห็นจอ "ไม่ได้เปิดรับ" (เดิมได้โหมดตัวอย่างแล้วขึ้น "ส่งแล้ว ขอบคุณ" ทั้งที่ไม่ได้บันทึก)
   ============================================================================= */

/** survey = ชุดคำถามที่ใช้จริง (โค้ด + คำที่แอดมินแก้ v1.279.3) — API เก่าไม่ส่งมาก็ใช้ของโค้ด */
type Status = { key: string; open: boolean; eligible: boolean; answered: boolean; canPreview?: boolean; survey?: SurveyDef }
type Answers = Record<string, string | string[]>

const BRAND = '#0b8043'

export default function SurveyPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loadError, setLoadError] = useState('')
  const [answers, setAnswers] = useState<Answers>({})
  const [missing, setMissing] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const refs = useRef<Record<string, HTMLDivElement | null>>({})

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const r = await fetch('/api/survey')
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'โหลดแบบสำรวจไม่ได้')
      setStatus(d)
    } catch (e: any) { setLoadError(e.message || 'โหลดแบบสำรวจไม่ได้') }
  }, [])
  useEffect(() => { load() }, [load])

  if (loadError) {
    return (
      <Shell>
        <p className="text-sm text-gray-700">{loadError}</p>
        <button onClick={load} className="mt-3 text-sm underline" style={{ color: BRAND }}>ลองใหม่</button>
      </Shell>
    )
  }
  if (!status) {
    return <Shell><div className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด…</div></Shell>
  }
  const S = status.survey ?? SURVEY
  const preview = !!status.canPreview && (!status.open || !status.eligible)
  if (!preview && !status.open) {
    return <Shell><Center emoji="🕒" title="ตอนนี้แบบสำรวจไม่ได้เปิดรับคำตอบ" /></Shell>
  }
  if (!preview && status.answered) {
    return <Shell><Center emoji="🙏" title="คุณตอบแบบสำรวจนี้ไปแล้ว ขอบคุณครับ" /></Shell>
  }
  if (!preview && !status.eligible) {
    return <Shell><Center emoji="🙂" title="แบบสำรวจรอบนี้ถามเฉพาะคนที่จองคิวถ่ายครับ" body="ขอบคุณที่แวะมานะครับ" /></Shell>
  }
  if (done) {
    return <Shell>{preview
      ? <Center emoji="🧪" title="หน้าตัวอย่าง — คำตอบนี้ไม่ได้ถูกบันทึก" />
      : <Center emoji="🙏" title="ส่งแล้ว ขอบคุณที่สละเวลาตอบครับ" />}</Shell>
  }

  const set = (a: Answers) => {
    setAnswers(a)
    if (missing.length) setMissing(missing.filter(id => !isAnswered(S.questions.find(q => q.id === id)!, a)))
  }

  const submit = async () => {
    setError('')
    const miss = S.questions.filter(q => q.required && !isAnswered(q, answers)).map(q => q.id)
    setMissing(miss)
    if (miss.length) {
      refs.current[miss[0]]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (preview) { setDone(true); return }
    setBusy(true)
    try {
      const r = await fetch('/api/survey', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: status.key, answers }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.status === 409 && d.answered) { setStatus({ ...status, answered: true }); return }
      if (!r.ok) throw new Error(d.error || 'ส่งไม่สำเร็จ ลองอีกครั้งนะครับ')
      setDone(true)
    } catch (e: any) { setError(e.message || 'ส่งไม่สำเร็จ ลองอีกครั้งนะครับ') } finally { setBusy(false) }
  }

  return (
    <Shell>
      {preview && <PreviewNote text={status.open
        ? '🧪 โหมดดูตัวอย่างสำหรับทีมจัดคิว — กรอกได้ แต่ไม่มีอะไรถูกบันทึก'
        : '🧪 ยังไม่เปิดรับคำตอบ — นี่คือหน้าตัวอย่าง กรอกได้ แต่ไม่มีอะไรถูกบันทึก'} />}
      <h1 className="text-xl font-semibold text-gray-900 leading-snug">{S.title}</h1>
      <p className="mt-2 text-[15px] text-gray-700 leading-relaxed">{S.intro}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {S.facts.map(f => <span key={f} className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700">{f}</span>)}
      </div>
      <p className="mt-3 text-xs text-gray-500">🔒 {S.privacy}</p>

      <div className="mt-6 space-y-4">
        {S.questions.map((q, i) => {
          const miss = missing.includes(q.id)
          return (
            <div key={q.id} ref={el => { refs.current[q.id] = el }}
              className={`rounded-xl border p-4 bg-white ${miss ? 'border-red-300' : 'border-gray-200'}`}>
              <div className="text-[15px] font-medium text-gray-900 leading-snug">
                {i + 1}. {q.title}{q.required && <span className="text-red-500"> *</span>}
              </div>
              {q.help && <p className="mt-0.5 text-xs text-gray-500">{q.help}</p>}
              <div className="mt-3">
                {q.kind === 'select' && (
                  <select value={(answers[q.id] as string) || ''} onChange={e => set({ ...answers, [q.id]: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-[15px] focus:outline-none focus:border-gray-400">
                    <option value="" disabled>— เลือก —</option>
                    {q.options!.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                )}
                {q.kind === 'scale' && <Scale q={q} value={answers[q.id] as string | undefined} onPick={v => set({ ...answers, [q.id]: v })} />}
                {q.kind === 'multi' && <Multi q={q} answers={answers} setAnswers={set} />}
                {q.kind === 'text' && (
                  <textarea value={(answers[q.id] as string) || ''} rows={4} maxLength={TEXT_MAX}
                    onChange={e => set({ ...answers, [q.id]: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-[15px] focus:outline-none focus:border-gray-400" />
                )}
              </div>
              {miss && <p className="mt-2 text-xs text-red-600">ยังไม่ได้ตอบข้อนี้</p>}
            </div>
          )
        })}
      </div>

      {error && <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">{error}</div>}
      {missing.length > 0 && <p className="mt-4 text-sm text-red-600">ยังขาด {missing.length} ข้อที่ต้องตอบ (มีเครื่องหมาย *)</p>}
      <button onClick={submit} disabled={busy}
        className="mt-5 w-full py-3.5 rounded-xl text-white text-[15px] font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2 active:scale-[0.99] transition"
        style={{ background: BRAND }}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {preview ? 'ลองกดส่ง (ตัวอย่าง ไม่บันทึก)' : 'ส่งคำตอบ'}
      </button>
    </Shell>
  )
}

function isAnswered(q: Question, a: Answers): boolean {
  const v = a[q.id]
  if (q.kind === 'text') return typeof v === 'string' && v.trim() !== ''
  if (q.kind === 'multi') return (Array.isArray(v) && v.length > 0) || !!(a[`${q.id}_other`] as string | undefined)?.trim()
  return typeof v === 'string' && v !== ''
}

/** สเกล 1–5 ป้ายครบทุกระดับ (ไม่ใช่แค่สองปลาย) · na = ทางออกสำหรับคนที่เทียบไม่ได้ */
function Scale({ q, value, onPick }: { q: Question; value?: string; onPick: (v: string) => void }) {
  const btn = (on: boolean) => (on
    ? { borderColor: BRAND, background: `${BRAND}14`, color: '#111827' }
    : { borderColor: '#e5e7eb', background: '#fff', color: '#374151' })
  return (
    <div>
      <div className="grid grid-cols-5 gap-1.5">
        {q.scale!.map((label, i) => {
          const v = String(i + 1)
          return (
            <button key={v} onClick={() => onPick(v)} aria-pressed={value === v} aria-label={`${v} — ${label}`}
              className="rounded-lg border px-1 py-2 flex flex-col items-center gap-1 transition" style={btn(value === v)}>
              <span className="text-base font-semibold tabular-nums">{v}</span>
              <span className="text-[11px] leading-tight text-center">{label}</span>
            </button>
          )
        })}
      </div>
      {q.na && (
        <button onClick={() => onPick('na')} aria-pressed={value === 'na'}
          className="mt-2 w-full rounded-lg border px-3 py-2 text-sm transition" style={btn(value === 'na')}>
          {q.na}
        </button>
      )}
    </div>
  )
}

function Multi({ q, answers, setAnswers }: { q: Question; answers: Answers; setAnswers: (a: Answers) => void }) {
  const chosen = (answers[q.id] as string[] | undefined) || []
  const otherKey = `${q.id}_other`
  const other = (answers[otherKey] as string | undefined) ?? ''
  const [otherOn, setOtherOn] = useState(other !== '')
  const toggle = (id: string) => {
    let list = chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id]
    const a: Answers = { ...answers }
    if (q.exclusive) {
      if (id === q.exclusive && list.includes(id)) { list = [id]; delete a[otherKey]; setOtherOn(false) }
      else list = list.filter(x => x !== q.exclusive)
    }
    a[q.id] = list
    setAnswers(a)
  }
  const box = (on: boolean) => (
    <span className="mt-0.5 w-5 h-5 shrink-0 rounded-md border flex items-center justify-center"
      style={on ? { background: BRAND, borderColor: BRAND } : { borderColor: '#d1d5db' }}>
      {on && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
    </span>
  )
  return (
    <div className="space-y-2">
      {q.options!.map(o => {
        const on = chosen.includes(o.id)
        return (
          <button key={o.id} onClick={() => toggle(o.id)} aria-pressed={on}
            className="w-full text-left px-3 py-2.5 rounded-lg border text-[15px] leading-snug flex gap-3 transition bg-white"
            style={on ? { borderColor: BRAND, background: `${BRAND}0f` } : { borderColor: '#e5e7eb' }}>
            {box(on)}<span className="text-gray-800">{o.label}</span>
          </button>
        )
      })}
      {q.other && (
        <div className="rounded-lg border px-3 py-2.5 bg-white" style={{ borderColor: otherOn ? BRAND : '#e5e7eb' }}>
          <button className="w-full text-left text-[15px] flex gap-3"
            onClick={() => {
              const on = !otherOn
              setOtherOn(on)
              const a: Answers = { ...answers }
              if (!on) delete a[otherKey]
              else if (q.exclusive) a[q.id] = chosen.filter(x => x !== q.exclusive)
              setAnswers(a)
            }}>
            {box(otherOn)}<span className="text-gray-800">อื่น ๆ</span>
          </button>
          {otherOn && (
            <input value={other} maxLength={OTHER_MAX} autoFocus placeholder="ระบุ"
              onChange={e => setAnswers({ ...answers, [otherKey]: e.target.value })}
              className="mt-2 w-full border-b border-gray-200 py-1.5 text-[15px] focus:outline-none focus:border-gray-400" />
          )}
        </div>
      )}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  // pb-28: ปุ่มติชมลอยมุมขวาล่างทับปุ่ม "ส่งคำตอบ" บนมือถือ — เว้นที่ให้เลื่อนพ้น
  return <div className="max-w-md mx-auto px-4 pt-6 pb-28 sm:pt-10">{children}</div>
}

function Center({ emoji, title, body }: { emoji: string; title: string; body?: string }) {
  return (
    <div className="text-center py-10 space-y-3">
      <div className="text-5xl">{emoji}</div>
      <div className="text-base font-medium text-gray-900">{title}</div>
      {body && <p className="text-sm text-gray-600">{body}</p>}
      <Link href="/" className="inline-block pt-2 text-sm underline" style={{ color: BRAND }}>กลับหน้าแรก</Link>
    </div>
  )
}

function PreviewNote({ text }: { text: string }) {
  return <div className="mb-5 text-xs text-gray-800 bg-blue-50 border border-blue-200 rounded-lg p-2.5">{text}</div>
}
