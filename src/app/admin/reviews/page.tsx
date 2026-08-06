'use client'

import { useCallback, useEffect, useState } from 'react'
import BackButton from '@/app/_components/BackButton'
import { Loader2, Download, Lock } from 'lucide-react'

/* =============================================================================
   /admin/reviews — v1.166. Post-shoot peer review results.
   Visible to three people only; the API enforces that, this page just renders
   whatever it is allowed to see (a 403 here is the gate working, not a bug).
   ============================================================================= */

type Review = {
  id: string; raterEmail: string; raterRole: string; targetRole: string
  score: number; scores: Record<string, number> | null; comment: string | null; createdAt: string
  booking: { bookingCode: string | null; shootDate: string; program: { name: string } | null; outlet: { name: string } | null } | null
}
type Payload = {
  days: number
  summary: Array<{ role: string; count: number; average: number }>
  reviews: Review[]
  responseRate: number | null
  invites: number
  answered: number
}

const ROLE_TH: Record<string, string> = { producer: 'ทีมโปรดิวเซอร์', camera: 'ทีมกล้อง', sound: 'ทีมเสียง', other: 'อื่นๆ' }
const when = (s: string) => new Date(s).toLocaleString('th-TH-u-ca-gregory', { dateStyle: 'short', timeStyle: 'short' })

export default function AdminReviewsPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [days, setDays] = useState(90)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const r = await fetch(`/api/admin/reviews?days=${days}`)
      const d = await r.json()
      if (r.status === 403) throw new Error('บัญชีนี้ไม่มีสิทธิ์ดูผลประเมิน (เห็นได้เฉพาะ นัท · ปุ๊ก · หวาน)')
      if (!r.ok) throw new Error(d.error || 'โหลดไม่สำเร็จ')
      setData(d)
    } catch (e: any) { setError(e.message); setData(null) }
  }, [days])
  useEffect(() => { load() }, [load])

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <BackButton fallback="/admin" />
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-medium text-gray-800 flex items-center gap-2">
          <Lock className="w-4 h-4 text-gray-400" /> ผลประเมินหลังจบงาน
        </h1>
        <div className="flex items-center gap-2">
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="border border-gray-300 rounded px-2 py-1 text-xs">
            <option value={7}>7 วัน</option>
            <option value={30}>30 วัน</option>
            <option value={90}>90 วัน</option>
            <option value={365}>1 ปี</option>
          </select>
          <a href="/api/admin/reviews/export?days=1"
            className="text-xs px-2.5 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
            <Download className="w-3 h-3" /> export วันนี้
          </a>
          <a href={`/api/admin/reviews/export?days=${days}`}
            className="text-xs px-2.5 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
            <Download className="w-3 h-3" /> export {days} วัน
          </a>
        </div>
      </div>
      <p className="text-[11px] text-gray-400 mb-4">
        คนให้คะแนนไม่ถูกเปิดเผยต่อผู้ถูกประเมินหรือเพื่อนร่วมงาน · หน้านี้เห็นได้ 3 คน · บันทึกลบไม่ได้
      </p>

      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{error}</div>}

      {!data && !error ? (
        <div className="text-sm text-gray-500 flex items-center gap-2 py-6"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด…</div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            {data.summary.map(s => (
              <div key={s.role} className="gf-card p-3">
                <div className="text-xs text-gray-500">{ROLE_TH[s.role] || s.role}</div>
                <div className="text-2xl font-medium">{s.average.toFixed(2)}<span className="text-sm text-gray-400"> / 5</span></div>
                <div className="text-[11px] text-gray-400">{s.count} รายการ</div>
              </div>
            ))}
            <div className="gf-card p-3">
              <div className="text-xs text-gray-500">อัตราตอบกลับ</div>
              <div className="text-2xl font-medium">{data.responseRate ?? '—'}<span className="text-sm text-gray-400">%</span></div>
              <div className="text-[11px] text-gray-400">{data.answered}/{data.invites} คน</div>
            </div>
          </div>

          {data.reviews.length === 0 ? (
            <p className="text-sm text-gray-500 py-6">ยังไม่มีผลประเมินในช่วงนี้</p>
          ) : (
            <div className="gf-card divide-y divide-gray-100">
              {data.reviews.map(r => (
                <div key={r.id} className="px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-amber-500">{'★'.repeat(r.score)}<span className="text-gray-300">{'★'.repeat(5 - r.score)}</span></span>
                    <span className="text-gray-700">{ROLE_TH[r.targetRole] || r.targetRole}</span>
                    <span className="text-[11px] text-gray-400">
                      โดย {ROLE_TH[r.raterRole] || r.raterRole} · {r.raterEmail.split('@')[0]}
                    </span>
                    <span className="text-[11px] text-gray-400 ml-auto font-mono">{r.booking?.bookingCode || '—'}</span>
                    <span className="text-[11px] text-gray-400">{when(r.createdAt)}</span>
                  </div>
                  {r.scores && Object.keys(r.scores).length > 0 && (
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {Object.entries(r.scores).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                    </div>
                  )}
                  {r.comment && <div className="text-gray-700 mt-1 whitespace-pre-wrap break-words">{r.comment}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
