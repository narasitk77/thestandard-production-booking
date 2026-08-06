'use client'

import { useCallback, useEffect, useState } from 'react'
import BackButton from '@/app/_components/BackButton'
import { Loader2, Send, Check, RefreshCw, MessageCircleHeart } from 'lucide-react'

/* =============================================================================
   /admin/feedback — v1.166. The queue behind the floating ติชม/แจ้งปัญหา box.
   Before this, a report went to one inbox and died there: the reporter never
   heard back and nothing tracked what was still open. Here each report is a
   ticket you answer in-app; the reporter is emailed on every reply and again
   when you close it with a summary of what was fixed.
   ============================================================================= */

type Ticket = {
  id: string; number: number; reporterEmail: string; mood: string | null
  page: string | null; subject: string; status: string; resolution: string | null
  resolvedAt: string | null; createdAt: string; lastMessageAt: string
  _count?: { messages: number }
}
type Message = { id: string; authorEmail: string; fromAdmin: boolean; body: string; createdAt: string }

const STATUS_TH: Record<string, string> = { NEW: 'ใหม่', IN_PROGRESS: 'กำลังแก้', RESOLVED: 'แก้เสร็จ' }
const STATUS_CLS: Record<string, string> = {
  NEW: 'bg-red-50 text-red-700 border-red-200',
  IN_PROGRESS: 'bg-amber-50 text-amber-700 border-amber-200',
  RESOLVED: 'bg-green-50 text-green-700 border-green-200',
}
const MOOD_TH: Record<string, string> = { love: '😊', problem: '😖', idea: '💡' }
const ref = (n: number) => `FB-${String(n).padStart(3, '0')}`
const when = (s: string) => new Date(s).toLocaleString('th-TH-u-ca-gregory', { dateStyle: 'short', timeStyle: 'short' })

export default function AdminFeedbackPage() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<'' | 'NEW' | 'IN_PROGRESS' | 'RESOLVED'>('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [thread, setThread] = useState<Message[]>([])
  const [reply, setReply] = useState('')
  const [resolution, setResolution] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const r = await fetch(`/api/feedback/tickets${filter ? `?status=${filter}` : ''}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'โหลดไม่สำเร็จ')
      setTickets(d.tickets); setCounts(d.counts || {})
    } catch (e: any) { setError(e.message); setTickets([]) }
  }, [filter])
  useEffect(() => { load() }, [load])

  const openTicket = async (id: string) => {
    setOpenId(id); setThread([]); setReply(''); setResolution('')
    const r = await fetch(`/api/feedback/tickets/${id}`)
    const d = await r.json()
    if (r.ok) setThread(d.ticket.messages || [])
  }

  const post = async (body: Record<string, unknown>) => {
    if (!openId || busy) return
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/feedback/tickets/${openId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'ส่งไม่สำเร็จ')
      setThread(d.ticket.messages || []); setReply(''); setResolution('')
      await load()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const current = tickets?.find(t => t.id === openId) || null

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <BackButton fallback="/admin" />
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-medium text-gray-800 flex items-center gap-2">
          <MessageCircleHeart className="w-5 h-5" /> Feedback จากทีม
        </h1>
        <button onClick={load} className="text-xs px-2.5 py-1 border border-gray-300 rounded hover:bg-gray-50 inline-flex items-center gap-1">
          <RefreshCw className="w-3 h-3" /> รีเฟรช
        </button>
      </div>

      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

      <div className="grid grid-cols-3 gap-2 mb-4">
        {(['NEW', 'IN_PROGRESS', 'RESOLVED'] as const).map(s => (
          <button key={s} onClick={() => setFilter(filter === s ? '' : s)}
            className={`gf-card p-3 text-left ${filter === s ? 'ring-2 ring-gray-400' : ''}`}>
            <div className="text-xs text-gray-500">{STATUS_TH[s]}</div>
            <div className="text-2xl font-medium">{counts[s] ?? 0}</div>
          </button>
        ))}
      </div>

      {tickets === null ? (
        <div className="text-sm text-gray-500 flex items-center gap-2 py-6"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด…</div>
      ) : tickets.length === 0 ? (
        <p className="text-sm text-gray-500 py-6">ยังไม่มีเรื่องเข้ามา{filter ? `ในสถานะ "${STATUS_TH[filter]}"` : ''}</p>
      ) : (
        <div className="gf-card divide-y divide-gray-100">
          {tickets.map(t => (
            <button key={t.id} onClick={() => openTicket(t.id)}
              className={`w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm ${openId === t.id ? 'bg-gray-50' : ''}`}>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${STATUS_CLS[t.status] || ''}`}>{STATUS_TH[t.status] || t.status}</span>
              <span className="font-mono text-[11px] text-gray-400 shrink-0">{ref(t.number)}</span>
              <span className="shrink-0">{t.mood ? MOOD_TH[t.mood] : '💬'}</span>
              <span className="flex-1 truncate text-gray-800">{t.subject}</span>
              <span className="text-[11px] text-gray-400 shrink-0">{t.reporterEmail.split('@')[0]} · {when(t.lastMessageAt)}</span>
            </button>
          ))}
        </div>
      )}

      {current && (
        <div className="gf-card p-4 mt-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-xs text-gray-400">{ref(current.number)}</span>
            <span className="font-medium text-gray-800 flex-1">{current.subject}</span>
            {current.page && <span className="text-[11px] text-gray-400">หน้า: {current.page}</span>}
          </div>
          <div className="text-[11px] text-gray-400 mb-3">
            {current.reporterEmail} · แจ้งเมื่อ {when(current.createdAt)}
          </div>

          <div className="space-y-2 mb-3 max-h-80 overflow-y-auto">
            {thread.map(m => (
              <div key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.fromAdmin ? 'ml-auto bg-blue-50 text-blue-900' : 'bg-gray-100 text-gray-800'}`}>
                <div className="text-[10px] opacity-70 mb-0.5">
                  {m.fromAdmin ? 'ทีมแอดมิน' : 'ผู้แจ้ง'} · {m.authorEmail.split('@')[0]} · {when(m.createdAt)}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
              </div>
            ))}
          </div>

          <div className="flex gap-2 mb-2">
            <input value={reply} onChange={e => setReply(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && reply.trim()) post({ body: reply.trim() }) }}
              placeholder="พิมพ์ตอบกลับ… (ระบบส่งเมลแจ้งผู้แจ้งให้อัตโนมัติ)"
              className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm" />
            <button onClick={() => post({ body: reply.trim() })} disabled={busy || !reply.trim()}
              className="px-3 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} ตอบ
            </button>
          </div>

          {current.status !== 'RESOLVED' ? (
            <div className="flex flex-wrap gap-2 items-center">
              {current.status === 'NEW' && (
                <button onClick={() => post({ status: 'IN_PROGRESS' })} disabled={busy}
                  className="text-xs px-2.5 py-1 border border-amber-600 text-amber-700 rounded hover:bg-amber-50 disabled:opacity-50">
                  รับเรื่อง
                </button>
              )}
              <input value={resolution} onChange={e => setResolution(e.target.value)}
                placeholder="สรุปสั้นๆ ว่าแก้อะไรไป (ส่งไปกับเมลปิดงาน)"
                className="flex-1 min-w-[220px] border border-gray-300 rounded px-2 py-1 text-xs" />
              <button onClick={() => post({ status: 'RESOLVED', resolution: resolution.trim(), ...(reply.trim() ? { body: reply.trim() } : {}) })}
                disabled={busy}
                className="text-xs px-2.5 py-1 border border-[#0b8043] text-[#0b8043] rounded hover:bg-[#0b8043] hover:text-white disabled:opacity-50 inline-flex items-center gap-1">
                <Check className="w-3 h-3" /> แก้เสร็จ + แจ้งผู้แจ้ง
              </button>
            </div>
          ) : (
            <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded p-2">
              ✓ ปิดเรื่องแล้วเมื่อ {current.resolvedAt ? when(current.resolvedAt) : '—'}
              {current.resolution ? ` — ${current.resolution}` : ''}
              {' · '}ถ้าผู้แจ้งตอบกลับมาอีก ระบบจะเปิดเรื่องนี้ใหม่ให้เอง
            </div>
          )}
        </div>
      )}
    </div>
  )
}
