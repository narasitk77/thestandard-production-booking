'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronLeft, Loader2 } from 'lucide-react'
import { SURVEY, OTHER_MAX, TEXT_MAX, questionsFor, type Group, type Question } from '@/lib/survey'

/* =============================================================================
   /survey — v1.278. "probook ช่วยประหยัดเวลาคุณได้แค่ไหน?" ทีละคำถามบนมือถือ
   ข้อที่เลือกได้ข้อเดียวกดแล้วไปต่อเอง · ย้อนได้ทุกข้อ · ส่งครั้งเดียวตอนจบ
   ปิดรับคำตอบอยู่ = โหมดดูตัวอย่าง: ทำได้ครบทุกหน้าแต่ไม่ยิง request เลย
   ============================================================================= */

type Status = { key: string; open: boolean; eligible: boolean; answered: boolean }
type Answers = Record<string, string | string[]>

const BRAND = '#0b8043'

export default function SurveyPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loadError, setLoadError] = useState('')
  const [step, setStep] = useState(-1) // -1 = หน้าแรก
  const [answers, setAnswers] = useState<Answers>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

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

  const group = (answers.role as Group | undefined) ?? null
  const qs = useMemo(() => questionsFor(group), [group])
  const preview = !!status && !status.open

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
  if (!preview && status.answered) {
    return <Shell><Center emoji="🙏" title="คุณตอบแบบสำรวจนี้ไปแล้ว ขอบคุณมากครับ" body={SURVEY.thanks} /></Shell>
  }
  if (!preview && !status.eligible) {
    return <Shell><Center emoji="🙂" title="แบบสำรวจรอบนี้ถามเฉพาะคนจองงานและทีมจัดคิวครับ" body="ขอบคุณที่แวะมานะครับ" /></Shell>
  }
  if (done) {
    return (
      <Shell>
        <Center emoji="🙏" title="ส่งแล้ว ขอบคุณมากครับ" body={SURVEY.thanks} />
        {preview && <PreviewNote text="🧪 โหมดดูตัวอย่าง — ไม่มีอะไรถูกบันทึก" />}
      </Shell>
    )
  }

  if (step < 0) {
    return (
      <Shell>
        {preview && <PreviewNote text="🧪 ยังไม่เปิดรับคำตอบ — นี่คือหน้าตัวอย่าง กดตอบได้ครบทุกข้อ แต่ไม่มีอะไรถูกบันทึก" />}
        <h1 className="text-xl font-semibold text-gray-900 leading-snug">{SURVEY.title}</h1>
        <p className="mt-3 text-[15px] text-gray-700 leading-relaxed">{SURVEY.intro}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {SURVEY.facts.map(f => <span key={f} className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700">{f}</span>)}
        </div>
        <p className="mt-4 text-xs text-gray-500">🔒 {SURVEY.privacy}</p>
        <button onClick={() => setStep(0)}
          className="mt-6 w-full py-3.5 rounded-xl text-white text-[15px] font-medium active:scale-[0.99] transition" style={{ background: BRAND }}>
          เริ่มเลย →
        </button>
      </Shell>
    )
  }

  const q = qs[Math.min(step, qs.length - 1)]
  const isLast = step >= qs.length - 1

  const next = () => { setError(''); if (!isLast) setStep(step + 1) }
  const back = () => { setError(''); setStep(step - 1) }

  const submit = async () => {
    setError('')
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

  const pick = (id: string) => {
    let a: Answers = { ...answers, [q.id]: id }
    // เปลี่ยนบทบาท = คำตอบของอีกกลุ่มไม่เกี่ยวแล้ว ทิ้งเลย
    if (q.id === 'role' && answers.role !== id) a = Object.fromEntries(Object.entries(a).filter(([k]) => !/^[bq]_/.test(k)))
    setAnswers(a)
    // ไปต่อเฉพาะเมื่อยังอยู่ข้อที่แตะ: แตะรัวไม่ข้ามข้อ และกดย้อนภายใน 220ms ไม่โดนดีดไปข้างหน้า
    const target = step + 1
    if (!isLast) setTimeout(() => setStep(s => (s === target - 1 ? target : s)), 220)
  }

  const progress = Math.round(((step + 1) / qs.length) * 100)

  return (
    <Shell>
      {preview && <PreviewNote text="🧪 โหมดดูตัวอย่าง — ไม่บันทึก" />}
      <div className="flex items-center gap-3 mb-5">
        <button onClick={back} aria-label="ย้อนกลับ" className="p-1 -ml-1 text-gray-500 hover:text-gray-800">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${progress}%`, background: BRAND }} />
        </div>
        <span className="text-xs text-gray-400 tabular-nums">{step + 1}/{qs.length}</span>
      </div>

      <h2 className="text-lg font-semibold text-gray-900 leading-snug">{q.title}</h2>
      {q.help && <p className="mt-1 text-sm text-gray-500">{q.help}</p>}

      <div className="mt-5">
        {q.kind === 'single' && <Single q={q} value={answers[q.id] as string | undefined} onPick={pick} />}
        {q.kind === 'multi' && <Multi key={q.id} q={q} answers={answers} setAnswers={setAnswers} />}
        {q.kind === 'text' && (
          <textarea key={q.id} value={(answers[q.id] as string) || ''} rows={5} maxLength={TEXT_MAX} autoFocus
            onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}
            placeholder="พิมพ์ได้เลย สั้น ๆ ก็ได้ครับ"
            className="w-full rounded-xl border border-gray-200 px-3.5 py-3 text-[15px] focus:outline-none focus:border-gray-400" />
        )}
      </div>

      {error && <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">{error}</div>}

      {(q.kind !== 'single' || isLast) && (
        <button onClick={isLast ? submit : next} disabled={busy}
          className="mt-6 w-full py-3.5 rounded-xl text-white text-[15px] font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2 active:scale-[0.99] transition"
          style={{ background: BRAND }}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {isLast ? 'ส่งคำตอบ 🙏' : answered(q, answers) ? 'ถัดไป →' : 'ข้าม →'}
        </button>
      )}
      {q.kind === 'single' && !isLast && answers[q.id] && (
        <button onClick={next} className="mt-4 w-full text-sm text-gray-500 hover:text-gray-800">ถัดไป →</button>
      )}
    </Shell>
  )
}

function answered(q: Question, a: Answers): boolean {
  const v = a[q.id]
  if (q.kind === 'text') return typeof v === 'string' && v.trim() !== ''
  if (q.kind === 'multi') return (Array.isArray(v) && v.length > 0) || !!(a[`${q.id}_other`] as string | undefined)?.trim()
  return !!v
}

function Single({ q, value, onPick }: { q: Question; value?: string; onPick: (id: string) => void }) {
  return (
    <div className="space-y-2.5">
      {q.options!.map(o => {
        const on = value === o.id
        return (
          <button key={o.id} onClick={() => onPick(o.id)} aria-pressed={on}
            className={`w-full text-left px-4 py-3.5 rounded-xl border text-[15px] leading-snug transition ${on ? 'text-gray-900' : 'border-gray-200 bg-white text-gray-800 hover:border-gray-300'}`}
            style={on ? { borderColor: BRAND, background: `${BRAND}0f` } : undefined}>
            {o.label}
          </button>
        )
      })}
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
    <div className="space-y-2.5">
      {q.options!.map(o => {
        const on = chosen.includes(o.id)
        return (
          <button key={o.id} onClick={() => toggle(o.id)} aria-pressed={on}
            className="w-full text-left px-4 py-3 rounded-xl border text-[15px] leading-snug flex gap-3 transition bg-white"
            style={on ? { borderColor: BRAND, background: `${BRAND}0f` } : { borderColor: '#e5e7eb' }}>
            {box(on)}<span className="text-gray-800">{o.label}</span>
          </button>
        )
      })}
      {q.other && (
        <div className="rounded-xl border px-4 py-3 bg-white" style={{ borderColor: otherOn ? BRAND : '#e5e7eb' }}>
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
            <input value={other} maxLength={OTHER_MAX} autoFocus placeholder="บอกสั้น ๆ ได้เลย"
              onChange={e => setAnswers({ ...answers, [otherKey]: e.target.value })}
              className="mt-2.5 w-full border-b border-gray-200 py-1.5 text-[15px] focus:outline-none focus:border-gray-400" />
          )}
        </div>
      )}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  // pb-28: ปุ่มติชมลอยมุมขวาล่างทับปุ่ม "ถัดไป" บนมือถือ — เว้นที่ให้เลื่อนพ้น
  return <div className="max-w-md mx-auto px-4 pt-6 pb-28 sm:pt-10">{children}</div>
}

function Center({ emoji, title, body }: { emoji: string; title: string; body: string }) {
  return (
    <div className="text-center py-10 space-y-3">
      <div className="text-5xl">{emoji}</div>
      <div className="text-base font-medium text-gray-900">{title}</div>
      <p className="text-sm text-gray-600">{body}</p>
      <Link href="/" className="inline-block pt-2 text-sm underline" style={{ color: BRAND }}>กลับหน้าแรก</Link>
    </div>
  )
}

function PreviewNote({ text }: { text: string }) {
  return <div className="mb-5 text-xs text-gray-800 bg-blue-50 border border-blue-200 rounded-lg p-2.5">{text}</div>
}
