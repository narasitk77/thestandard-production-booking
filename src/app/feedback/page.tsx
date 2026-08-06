'use client'

import { useCallback, useEffect, useState } from 'react'
import BackButton from '@/app/_components/BackButton'
import { Loader2, Send, MessageCircleHeart } from 'lucide-react'

/* =============================================================================
   /feedback — v1.166. "เรื่องที่ฉันแจ้งไว้", for everyone (no console access
   needed). The server scopes this to the signed-in reporter's own tickets, so
   nobody can read someone else's thread by changing a parameter.
   ============================================================================= */

type Ticket = {
  id: string; number: number; subject: string; status: string; mood: string | null
  resolution: string | null; resolvedAt: string | null; createdAt: string; lastMessageAt: string
}
type Message = { id: string; authorEmail: string; fromAdmin: boolean; body: string; createdAt: string }

const STATUS_TH: Record<string, string> = { NEW: 'รับเรื่องแล้ว', IN_PROGRESS: 'กำลังแก้', RESOLVED: 'แก้เสร็จแล้ว' }
const STATUS_CLS: Record<string, string> = {
  NEW: 'bg-gray-100 text-gray-700 border-gray-200',
  IN_PROGRESS: 'bg-amber-50 text-amber-700 border-amber-200',
  RESOLVED: 'bg-green-50 text-green-700 border-green-200',
}
const MOOD_TH: Record<string, string> = { love: '😊', problem: '😖', idea: '💡' }
const ref = (n: number) => `FB-${String(n).padStart(3, '0')}`
const when = (s: string) => new Date(s).toLocaleString('th-TH-u-ca-gregory', { dateStyle: 'short', timeStyle: 'short' })

export default function MyFeedbackPage() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [thread, setThread] = useState<Message[]>([])
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/feedback/tickets')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'โหลดไม่สำเร็จ')
      setTickets(d.tickets)
    } catch (e: any) { setError(e.message); setTickets([]) }
  }, [])
  useEffect(() => { load() }, [load])

  const open = async (id: string) => {
    setOpenId(id); setThread([]); setReply('')
    const r = await fetch(`/api/feedback/tickets/${id}`)
    const d = await r.json()
    if (r.ok) setThread(d.ticket.messages || [])
  }

  const send = async () => {
    if (!openId || !reply.trim() || busy) return
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/feedback/tickets/${openId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: reply.trim() }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'ส่งไม่สำเร็จ')
      setThread(d.ticket.messages || []); setReply(''); await load()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const current = tickets?.find(t => t.id === openId) || null

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <BackButton fallback="/" />
      <h1 className="text-lg font-medium text-gray-800 mb-1 flex items-center gap-2">
        <MessageCircleHeart className="w-5 h-5" /> เรื่องที่ฉันแจ้งไว้
      </h1>
      <p className="text-xs text-gray-500 mb-4">
        แจ้งเรื่องใหม่ได้จากปุ่มลอยมุมขวาล่างทุกหน้า · ตรงนี้ไว้ดูว่าเรื่องเดิมไปถึงไหนแล้ว
      </p>

      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

      {tickets === null ? (
        <div className="text-sm text-gray-500 flex items-center gap-2 py-6"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด…</div>
      ) : tickets.length === 0 ? (
        <p className="text-sm text-gray-500 py-6">ยังไม่เคยแจ้งอะไรไว้ — เจออะไรติดขัดกดปุ่มมุมขวาล่างได้เลยครับ</p>
      ) : (
        <div className="gf-card divide-y divide-gray-100">
          {tickets.map(t => (
            <button key={t.id} onClick={() => open(t.id)}
              className={`w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm ${openId === t.id ? 'bg-gray-50' : ''}`}>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${STATUS_CLS[t.status] || ''}`}>{STATUS_TH[t.status] || t.status}</span>
              <span className="font-mono text-[11px] text-gray-400 shrink-0">{ref(t.number)}</span>
              <span className="shrink-0">{t.mood ? MOOD_TH[t.mood] : '💬'}</span>
              <span className="flex-1 truncate text-gray-800">{t.subject}</span>
              <span className="text-[11px] text-gray-400 shrink-0">{when(t.lastMessageAt)}</span>
            </button>
          ))}
        </div>
      )}

      {current && (
        <div className="gf-card p-4 mt-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="font-mono text-xs text-gray-400">{ref(current.number)}</span>
            <span className="font-medium text-gray-800 flex-1">{current.subject}</span>
          </div>

          {current.status === 'RESOLVED' && (
            <div className="text-xs text-green-800 bg-green-50 border border-green-200 rounded p-2 mb-3">
              ✓ แก้เสร็จแล้ว{current.resolvedAt ? ` เมื่อ ${when(current.resolvedAt)}` : ''}
              {current.resolution ? <> — {current.resolution}</> : null}
              <div className="mt-1 opacity-80">ถ้ายังไม่หาย พิมพ์บอกได้เลย ระบบจะเปิดเรื่องนี้ใหม่ให้อัตโนมัติ</div>
            </div>
          )}

          <div className="space-y-2 mb-3 max-h-80 overflow-y-auto">
            {thread.map(m => (
              <div key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.fromAdmin ? 'bg-blue-50 text-blue-900' : 'ml-auto bg-gray-100 text-gray-800'}`}>
                <div className="text-[10px] opacity-70 mb-0.5">
                  {m.fromAdmin ? 'ทีมแอดมิน' : 'คุณ'} · {when(m.createdAt)}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <input value={reply} onChange={e => setReply(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') send() }}
              placeholder="พิมพ์ตอบกลับ…"
              className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm" />
            <button onClick={send} disabled={busy || !reply.trim()}
              className="px-3 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} ส่ง
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
