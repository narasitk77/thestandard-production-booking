'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { MessageCircleHeart, X, Loader2, Send } from 'lucide-react'

/* FeedbackWidget — v1.133. กล่องติชม/แจ้งปัญหาแบบลอยมุมขวาล่าง มีทุกหน้า
   (mounted in the root layout, session-gated there). ตั้งใจให้เป็นมิตรทุกวัย:
   ปุ่มเดียว → เลือกอารมณ์ → พิมพ์ → ส่ง จบ. ส่งเข้าเมล FEEDBACK_EMAIL ผ่าน
   POST /api/feedback.

   Hidden on /new — the wizard's fixed bottom action bar owns that corner on
   mobile, and a floating button on top of "ยืนยันการจอง" is how mis-taps happen. */

const MOODS = [
  { key: 'love', emoji: '😊', label: 'ชอบเลย' },
  { key: 'problem', emoji: '😖', label: 'เจอปัญหา' },
  { key: 'idea', emoji: '💡', label: 'มีไอเดีย' },
] as const

export default function FeedbackWidget() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [mood, setMood] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  if (pathname?.startsWith('/new')) return null

  const submit = async () => {
    if (!message.trim() || state === 'sending') return
    setState('sending')
    setErrorMsg('')
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mood, message: message.trim(), page: pathname || '' }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 401) throw new Error('เซสชันหมดอายุ — รีเฟรชหน้าแล้วลองส่งใหม่นะครับ')
      if (!res.ok) throw new Error(d.error || 'ส่งไม่สำเร็จ ลองใหม่อีกครั้งนะครับ')
      setState('sent')
      setMessage('')
      setMood(null)
      // ปิดเองหลังโชว์คำขอบคุณสักครู่
      setTimeout(() => { setOpen(false); setState('idle') }, 2500)
    } catch (e: any) {
      setState('error')
      setErrorMsg(e?.message || 'ส่งไม่สำเร็จ ลองใหม่อีกครั้งนะครับ')
    }
  }

  return (
    <>
      {/* ปุ่มลอย */}
      {!open && (
        <button
          onClick={() => { setOpen(true); setState('idle') }}
          aria-label="ติชม / แจ้งปัญหา"
          className="fixed bottom-4 right-4 z-30 inline-flex items-center gap-2 rounded-full bg-[#673ab7] text-white
                     pl-3 pr-4 py-2.5 shadow-lg hover:bg-[#5e35b1] active:scale-95 transition
                     text-sm font-medium"
        >
          <MessageCircleHeart className="w-5 h-5" aria-hidden />
          <span className="hidden sm:inline">ติชม / แจ้งปัญหา</span>
        </button>
      )}

      {/* กล่องข้อความ */}
      {open && (
        <div
          role="dialog"
          aria-label="กล่องติชมและแจ้งปัญหา"
          className="fixed bottom-4 right-4 z-30 w-[calc(100vw-2rem)] max-w-sm rounded-2xl bg-white border border-gray-200 shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3 bg-[#673ab7] text-white">
            <div className="text-sm font-semibold">มีอะไรอยากบอกทีมระบบไหมครับ? 💜</div>
            <button onClick={() => setOpen(false)} aria-label="ปิด" className="p-1 rounded hover:bg-white/15">
              <X className="w-4 h-4" />
            </button>
          </div>

          {state === 'sent' ? (
            <div className="p-6 text-center space-y-1">
              <div className="text-3xl">🙏</div>
              <div className="text-sm font-medium text-gray-800">ส่งถึงทีมแล้ว ขอบคุณมากครับ!</div>
              <div className="text-xs text-gray-500">ทุกข้อความมีคนอ่านจริง ๆ</div>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              <div className="flex gap-2">
                {MOODS.map(m => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMood(mood === m.key ? null : m.key)}
                    aria-pressed={mood === m.key}
                    className={`flex-1 rounded-xl border px-2 py-2 text-center transition ${
                      mood === m.key
                        ? 'border-[#673ab7] bg-[#673ab7]/10'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="text-xl leading-none">{m.emoji}</div>
                    <div className="text-[11px] text-gray-700 mt-1">{m.label}</div>
                  </button>
                ))}
              </div>

              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                rows={4}
                maxLength={4000}
                placeholder="พิมพ์บอกได้เลยครับ เจออะไร ตรงไหน อยากได้อะไรเพิ่ม…"
                className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm text-gray-800
                           focus:outline-none focus:border-[#673ab7] resize-none"
              />

              {state === 'error' && (
                <div className="text-xs text-red-600">{errorMsg}</div>
              )}

              <button
                onClick={submit}
                disabled={!message.trim() || state === 'sending'}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#673ab7] text-white
                           py-2.5 text-sm font-medium hover:bg-[#5e35b1] disabled:opacity-40 transition"
              >
                {state === 'sending'
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> กำลังส่ง…</>
                  : <><Send className="w-4 h-4" /> ส่งข้อความ</>}
              </button>

              <div className="text-[10px] text-gray-400 text-center">
                ส่งตรงถึงผู้ดูแลระบบทางอีเมล พร้อมชื่อของคุณ เผื่อต้องตอบกลับ
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
