'use client'

import { useCallback, useEffect, useState } from 'react'
import BackButton from '@/app/_components/BackButton'
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'

/* =============================================================================
   /admin/monitor — v1.170. The system owner's morning glance.
   Answers four questions and nothing else: what is due today, did it go out,
   is anybody replying, is anything stuck. Every number comes from the API so
   the panel cannot drift from what the workers actually do.
   ============================================================================= */

type Health = 'ok' | 'warn' | 'bad'
type Payload = {
  now: string
  tickets: {
    new: number; inProgress: number; resolved30d: number
    medianResolveHours: number | null; oldestOpenDays: number | null; health: Health
    open: Array<{ id: string; number: number; subject: string; status: string; reporterEmail: string; createdAt: string; lastMessageAt: string }>
  }
  reviews: null | {
    enabled: boolean; delayDays: number; lookbackDays: number
    window: { from: string; to: string }
    today: Array<{ code: string | null; show: string | null; status: string; shootDate: string; expected: number; invited: number; mailed: number; answered: number }>
    rowsOmitted: number
    rate30: { sent: number; answered: number; pct: number | null; health: Health }
    undelivered: { count: number; health: Health }
    awaiting: { count: number; oldestDays: number | null }
    scores: Array<{ role: string; count: number; average: number }>
    lastRun: { at: string; changes: any } | null
  }
}

const ROLE_TH: Record<string, string> = { producer: 'ทีมโปรดิวเซอร์', camera: 'ทีมกล้อง', sound: 'ทีมเสียง', overall: 'ความพึงพอใจโดยรวม' }
const STATUS_TH: Record<string, string> = { NEW: 'ใหม่', IN_PROGRESS: 'กำลังแก้', RESOLVED: 'แก้เสร็จ' }
const ref = (n: number) => `FB-${String(n).padStart(3, '0')}`
const when = (s: string) => new Date(s).toLocaleString('th-TH-u-ca-gregory', { dateStyle: 'short', timeStyle: 'short' })

function Light({ h }: { h: Health }) {
  const map = { ok: 'bg-green-500', warn: 'bg-amber-500', bad: 'bg-red-500' }
  return <span className={`inline-block w-2 h-2 rounded-full ${map[h]}`} />
}

function Card({ label, value, sub, health }: { label: string; value: React.ReactNode; sub?: string; health?: Health }) {
  return (
    <div className="gf-card p-3">
      <div className="text-xs text-gray-500 flex items-center gap-1.5">
        {health && <Light h={health} />}{label}
      </div>
      <div className="text-2xl font-medium leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
    </div>
  )
}

export default function MonitorPage() {
  const [d, setD] = useState<Payload | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const r = await fetch('/api/admin/monitor')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'โหลดไม่สำเร็จ')
      setD(j)
    } catch (e: any) { setError(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <BackButton fallback="/admin" />
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-medium text-gray-800">ศูนย์ติดตาม — Feedback &amp; ประเมิน</h1>
        <button onClick={load} className="text-xs px-2.5 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
          <RefreshCw className="w-3 h-3" /> รีเฟรช
        </button>
      </div>
      <p className="text-[11px] text-gray-400 mb-4">
        {d ? `ข้อมูล ณ ${when(d.now)}` : 'กำลังโหลด…'}
      </p>

      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{error}</div>}
      {!d && !error && <div className="text-sm text-gray-500 flex items-center gap-2 py-6"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด…</div>}

      {d && (
        <>
          {/* ── เรื่องที่ทีมแจ้งเข้ามา ─────────────────────────────── */}
          <h2 className="text-sm font-medium text-gray-700 mb-2">เรื่องที่ทีมแจ้งเข้ามา</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <Card label="ยังไม่มีใครรับเรื่อง" value={d.tickets.new} health={d.tickets.health}
              sub={d.tickets.oldestOpenDays !== null ? `ค้างนานสุด ${d.tickets.oldestOpenDays} วัน` : 'ไม่มีค้าง'} />
            <Card label="กำลังแก้" value={d.tickets.inProgress} />
            <Card label="ปิดไป (30 วัน)" value={d.tickets.resolved30d} />
            <Card label="เวลาปิดงาน (กลาง)" value={d.tickets.medianResolveHours !== null ? `${d.tickets.medianResolveHours} ชม.` : '—'} />
          </div>

          {d.tickets.open.length > 0 ? (
            <div className="gf-card divide-y divide-gray-100 mb-6 text-sm">
              {d.tickets.open.map(t => (
                <a key={t.id} href="/admin/feedback" className="px-3 py-2 flex items-center gap-2 hover:bg-gray-50">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${t.status === 'NEW' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                    {STATUS_TH[t.status] || t.status}
                  </span>
                  <span className="font-mono text-[11px] text-gray-400">{ref(t.number)}</span>
                  <span className="flex-1 truncate">{t.subject}</span>
                  <span className="text-[11px] text-gray-400">{t.reporterEmail.split('@')[0]} · {when(t.createdAt)}</span>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 mb-6 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-green-600" /> ไม่มีเรื่องค้าง
            </p>
          )}

          {/* ── แบบประเมินหลังงาน ──────────────────────────────────── */}
          <h2 className="text-sm font-medium text-gray-700 mb-2">แบบประเมินหลังงาน</h2>

          {!d.reviews ? (
            <p className="text-sm text-gray-500">บัญชีนี้ดูตัวเลขประเมินไม่ได้ (เห็นได้เฉพาะ นัท · ปุ๊ก · หวาน)</p>
          ) : (
            <>
              {!d.reviews.enabled && (
                <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2.5 mb-3 flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <div>
                    <strong>ระบบยังปิดอยู่</strong> — ตารางข้างล่างคือ “ถ้าเปิดวันนี้จะส่งหาใครบ้าง” ยังไม่มีเมลออกไปจริง
                    <div className="mt-0.5 opacity-80">เปิดโดยตั้ง <code className="font-mono">SHOOT_REVIEW_ENABLED=1</code> แล้ว redeploy</div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                <Card label="อัตราตอบกลับ (30 วัน)" health={d.reviews.rate30.health}
                  value={d.reviews.rate30.pct !== null ? `${d.reviews.rate30.pct}%` : '—'}
                  sub={`ตอบ ${d.reviews.rate30.answered} จากที่ส่ง ${d.reviews.rate30.sent}`} />
                <Card label="ส่งไม่ออก (ต้องแก้)" value={d.reviews.undelivered.count} health={d.reviews.undelivered.health}
                  sub={!d.reviews.undelivered.count ? 'ไม่มี'
                    : d.reviews.enabled ? 'ระบบจะส่งซ้ำรอบหน้า'
                    : 'ยังไม่ส่งเพราะระบบปิดอยู่ (เปิดแล้วส่งให้เอง)'} />
                <Card label="รอตอบอยู่" value={d.reviews.awaiting.count}
                  sub={d.reviews.awaiting.oldestDays !== null ? `นานสุด ${d.reviews.awaiting.oldestDays} วัน` : '—'} />
                <Card label="รอบล่าสุดที่ส่ง"
                  value={d.reviews.lastRun ? when(d.reviews.lastRun.at).split(' ')[0] : '—'}
                  sub={d.reviews.lastRun ? 'ดูรายละเอียดใน audit log' : 'ยังไม่เคยรัน'} />
              </div>

              <div className="text-xs text-gray-500 mb-1.5 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>
                  รอบถัดไปจะถามถึงงานที่ปิด (COMPLETED) และถ่ายจบระหว่างวันที่{' '}
                  <span className="font-mono">{d.reviews.window.from}</span> – <span className="font-mono">{d.reviews.window.to}</span>{' '}
                  (หลังจบงาน {d.reviews.delayDays} วัน · ตามเก็บย้อนหลัง {d.reviews.lookbackDays} วัน)
                </span>
              </div>

              {d.reviews.today.length === 0 ? (
                <p className="text-sm text-gray-500 mb-4">ไม่มีงานที่ถึงคิวส่งในรอบถัดไป</p>
              ) : (
                <div className="gf-card divide-y divide-gray-100 mb-4 text-sm">
                  {d.reviews.today.map(r => {
                    const done = r.expected > 0 && r.answered >= r.expected
                    const sent = r.mailed > 0
                    return (
                      <div key={r.code} className="px-3 py-2 flex items-center gap-2 flex-wrap">
                        <Light h={done ? 'ok' : sent ? 'warn' : 'bad'} />
                        <span className="font-mono text-[11px] text-gray-500">{r.code}</span>
                        <span className="flex-1 truncate text-gray-700">{r.show || '—'}</span>
                        <span className="font-mono text-[11px] text-gray-400">{r.shootDate}</span>
                        <span className="text-[11px] text-gray-400">
                          {sent ? `ส่งแล้ว ${r.mailed}` : `ยังไม่ส่ง (จะส่ง ${r.expected})`} · ตอบ {r.answered}/{r.invited || r.expected}
                        </span>
                      </div>
                    )
                  })}
                  {d.reviews.rowsOmitted > 0 && (
                    <div className="px-3 py-2 text-[11px] text-gray-400">
                      + อีก {d.reviews.rowsOmitted} งานในช่วงนี้ (ไม่ได้แสดง — เรียงงานที่ยังต้องส่งขึ้นก่อน)
                    </div>
                  )}
                </div>
              )}

              {d.reviews.scores.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {d.reviews.scores.map(s => (
                    <Card key={s.role} label={ROLE_TH[s.role] || s.role}
                      value={<>{s.average.toFixed(2)}<span className="text-sm text-gray-400"> / 5</span></>}
                      sub={`${s.count} รายการ (30 วัน)`} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
