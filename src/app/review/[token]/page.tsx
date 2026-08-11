'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Send, Star } from 'lucide-react'

/* =============================================================================
   /review/<token> — v1.166. The post-shoot peer review form.
   Opens from an email link with NO login: half the crew are freelancers on a
   phone. The token is the whole credential, so this page can submit ratings and
   read nothing back — not even what the person just sent.
   ============================================================================= */

type Target = { key: string; th: string; answered: boolean }
type Criterion = { key: string; th: string }
type Payload = {
  /** v1.173.6 — set by /api/review/demo: nothing here is real and nothing is stored. */
  demo?: boolean
  booking: { code: string | null; shootDate: string; show: string | null; outlet: string | null; job: string | null }
  yourRole: string
  targets: Target[]
  /** v1.173 — the job-level satisfaction question, asked of everyone. */
  overall?: Target
  criteria: Criterion[]
  notice: string
  submittedAt: string | null
}

const ROLE_TH: Record<string, string> = { producer: 'ทีมโปรดิวเซอร์', camera: 'ทีมกล้อง', sound: 'ทีมเสียง', other: 'ทีมงาน' }

function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} type="button" onClick={() => onChange(n)} aria-label={`${n} ดาว`}
          className={`p-1 rounded ${n <= value ? 'text-amber-500' : 'text-gray-300 hover:text-gray-400'}`}>
          <Star className="w-6 h-6" fill={n <= value ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  )
}

export default function ReviewFormPage({ params }: { params: { token: string } }) {
  // /review/demo-client and /review/demo-crew render the real form against a
  // booking that does not exist. They are the ONLY safe way to look at it: an
  // invite minted on a real job writes a permanent rating the moment it is sent.
  const isDemo = params.token === 'demo' || params.token.startsWith('demo-')
  // /review/demo-<seat>: producer | camera | sound (client/crew still work).
  const demoSeat = params.token.replace(/^demo-?/, '') || 'producer'

  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [receiptSent, setReceiptSent] = useState(false)
  const [form, setForm] = useState<Record<string, { score: number; scores: Record<string, number>; comment: string }>>({})

  const load = useCallback(async () => {
    try {
      const r = await fetch(isDemo ? `/api/review/demo?role=${encodeURIComponent(demoSeat)}` : `/api/review/${params.token}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'เปิดแบบประเมินไม่ได้')
      setData(d)
      const init: typeof form = {}
      for (const t of d.targets) if (!t.answered) init[t.key] = { score: 0, scores: {}, comment: '' }
      // Same shape as a team answer so `submit` needs no special case — the
      // overall row simply carries no per-criterion scores.
      if (d.overall && !d.overall.answered) init[d.overall.key] = { score: 0, scores: {}, comment: '' }
      setForm(init)
    } catch (e: any) { setError(e.message) }
  }, [params.token, isDemo, demoSeat])
  useEffect(() => { load() }, [load])

  const submit = async () => {
    const overallKey = data?.overall?.key
    const ratings = Object.entries(form)
      .map(([targetRole, v]) => {
        // The job-level question is one star row; a team is its criteria.
        if (targetRole === overallKey) {
          return v.score > 0 ? { targetRole, score: v.score, comment: v.comment } : null
        }
        const given = Object.values(v.scores).filter(n => n > 0)
        return given.length > 0 ? { targetRole, scores: v.scores, comment: v.comment } : null
      })
      .filter(Boolean) as Array<Record<string, unknown>>
    if (ratings.length === 0) { setError('ให้ดาวอย่างน้อย 1 ข้อก่อนส่งนะครับ'); return }
    // The whole point of demo mode: the request is never made.
    if (isDemo) { setReceiptSent(false); setDone(true); return }
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/review/${params.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratings }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'ส่งไม่สำเร็จ')
      setReceiptSent(!!d.receiptSent)
      setDone(true)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  if (error && !data) {
    return <div className="max-w-md mx-auto px-4 py-20 text-center text-sm text-gray-600">{error}</div>
  }
  if (!data) {
    return <div className="max-w-md mx-auto px-4 py-20 text-center text-sm text-gray-500 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด…</div>
  }
  if (done) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center space-y-2">
        <div className="text-4xl">🙏</div>
        <div className="text-base font-medium text-gray-800">
          {data.demo ? 'นี่คือหน้าจอที่ทีมจะเห็นหลังกดส่ง' : 'ส่งแล้ว ขอบคุณมากครับ'}
        </div>
        {/* v1.173.3 — say where the proof is. Without this the only way to find
            out whether an answer arrived is to go and ask the admin. */}
        <p className="text-sm text-gray-600">
          {data.demo
            ? '🧪 โหมดจำลอง — ไม่มีอะไรถูกบันทึก และไม่มีอีเมลออกไป'
            : receiptSent
              ? 'ระบบส่งอีเมลยืนยันไปที่เมลของคุณแล้ว ใช้เป็นหลักฐานได้ ไม่ต้องตามถามครับ'
              : 'คำตอบถูกบันทึกแล้วเรียบร้อย'}
        </p>
        <p className="text-xs text-gray-500">{data.notice}</p>
      </div>
    )
  }

  const pending = data.targets.filter(t => !t.answered)
  const overall = data.overall && !data.overall.answered ? data.overall : null
  const nothingLeft = pending.length === 0 && !overall

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-4">
      <div>
        <h1 className="text-lg font-medium text-gray-800">ประเมินการทำงานร่วมกัน</h1>
        <p className="text-sm text-gray-600 mt-0.5">
          {data.booking.show || data.booking.outlet || 'งานถ่าย'}
          {data.booking.job ? ` · ${data.booking.job}` : ''}
        </p>
        <p className="text-xs text-gray-400 font-mono">
          {data.booking.code} · ถ่ายวันที่ {new Date(data.booking.shootDate).toLocaleDateString('th-TH-u-ca-gregory', { dateStyle: 'medium' })}
        </p>
      </div>

      {data.demo && (
        <div className="text-xs text-gray-800 bg-blue-50 border border-blue-200 rounded p-2.5">
          🧪 <strong>โหมดจำลอง</strong> — งานนี้ไม่มีอยู่จริง กดส่งได้เต็มที่ ไม่มีอะไรถูกบันทึก และไม่มีใครได้รับอีเมล
        </div>
      )}

      <div className="text-xs text-gray-600 bg-amber-50 border border-amber-200 rounded p-2.5">
        🔒 {data.notice}
      </div>

      {nothingLeft ? (
        <div className="gf-card p-4 text-sm text-gray-700 space-y-1">
          <div>คุณส่งแบบประเมินของงานนี้ครบแล้ว ขอบคุณครับ 🙏</div>
          {/* The timestamp IS the proof here. Whether the receipt mail went out is
              only known at submit time — claiming it on a later visit would be a
              promise this page cannot check. */}
          {data.submittedAt && (
            <div className="text-xs text-gray-500">
              ส่งเมื่อ {new Date(data.submittedAt).toLocaleString('th-TH-u-ca-gregory', { dateStyle: 'medium', timeStyle: 'short' })}
            </div>
          )}
        </div>
      ) : pending.map(t => {
        const v = form[t.key] || { score: 0, scores: {}, comment: '' }
        return (
          <div key={t.key} className="gf-card p-4 space-y-3">
            <div className="font-medium text-gray-800">{t.th}</div>

            {/* No "ภาพรวม" row: it sat above the same three questions and asked
                people to summarise their own summary. The stored per-team score
                is derived from these three, server-side. */}
            {data.criteria.map(c => (
              <div key={c.key} className="flex items-center justify-between">
                <span className="text-sm text-gray-600">{c.th}</span>
                <Stars value={v.scores[c.key] || 0}
                  onChange={n => setForm({ ...form, [t.key]: { ...v, scores: { ...v.scores, [c.key]: n } } })} />
              </div>
            ))}

            <textarea value={v.comment} rows={2}
              onChange={e => setForm({ ...form, [t.key]: { ...v, comment: e.target.value } })}
              placeholder={`อยากบอกอะไร${t.th}เพิ่มไหม (ไม่บังคับ)`}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </div>
        )
      })}

      {/* The job as a whole, not a team — last, because it reads as the summing-up
          question and because a phone form is abandoned from the bottom. */}
      {overall && (() => {
        const v = form[overall.key] || { score: 0, scores: {}, comment: '' }
        return (
          <div className="gf-card p-4 space-y-3 border-[#0b8043]/30">
            <div className="font-medium text-gray-800">ภาพรวมงานนี้</div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-gray-600">{overall.th}</span>
              <Stars value={v.score} onChange={n => setForm({ ...form, [overall.key]: { ...v, score: n } })} />
            </div>
            <textarea value={v.comment} rows={3}
              onChange={e => setForm({ ...form, [overall.key]: { ...v, comment: e.target.value } })}
              placeholder="อะไรที่ควรทำต่อ / อะไรที่ควรแก้ บอกได้เลยครับ (ไม่บังคับ)"
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </div>
        )
      })()}

      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

      {!nothingLeft && (
        <button onClick={submit} disabled={busy}
          className="w-full py-2.5 border border-[#0b8043] text-[#0b8043] rounded hover:bg-[#0b8043] hover:text-white disabled:opacity-50 inline-flex items-center justify-center gap-2 text-sm">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} ส่งแบบประเมิน
        </button>
      )}
      <p className="text-[11px] text-gray-400 text-center">ส่งได้ครั้งเดียวต่องาน · แก้ไขภายหลังไม่ได้</p>
    </div>
  )
}
