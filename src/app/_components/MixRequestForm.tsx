'use client'

/**
 * v1.218 — ฟอร์มขอมิกซ์เสียง ใช้ร่วมกันสองที่
 *
 * เดิมอยู่ในไฟล์ /mix ที่เดียว พอเพิ่มทางเข้าที่ /new ก็มีทางเลือกสองทาง: ก็อปฟอร์ม
 * ไปอีกที่ หรือแยกออกมา · เลือกแยก เพราะฟอร์มที่ถูกก็อปคือฟอร์มที่จะเพี้ยนออกจากกัน
 * ในอีกหกเดือน แล้วสองทางเข้าจะรับข้อมูลไม่เหมือนกันโดยไม่มีใครรู้
 *
 * `onDone` ต่างกันตามที่ที่มันอยู่: ที่ /mix คือรีโหลดคิว · ที่ /new คือโชว์ว่าส่ง
 * แล้วพร้อมทางไปดูคิว เพราะคนที่นั่นยังไม่ได้เปิดคิวอยู่
 */

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

/** ฟอร์มตั้งคำขอ — สั้นที่สุดเท่าที่ยังบอกทีมเสียงได้ว่าไฟล์อยู่ไหน */
export default function MixRequestForm({ onDone, initialBookingCode }: {
  onDone: (created: { code: string; notifiedTo: string[] }) => void
  /** v1.219 — เติมรหัสมาให้เมื่อกดขอจากหน้าใบจอง คนจะได้ไม่ต้องจำเลขไปพิมพ์เอง */
  initialBookingCode?: string
}) {
  const [title, setTitle] = useState('')
  const [bookingCode, setBookingCode] = useState(initialBookingCode || '')
  const [dueDate, setDueDate] = useState('')
  const [sourceLink, setSourceLink] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      // หา booking จากรหัสที่พิมพ์ — ไม่บังคับ ปล่อยว่างได้ถ้าเป็นงานเดี่ยว
      let bookingId: string | null = null
      if (bookingCode.trim()) {
        const r = await fetch(`/api/bookings?scope=all&q=${encodeURIComponent(bookingCode.trim())}&limit=5`)
        if (r.ok) {
          const d = await r.json()
          const list = Array.isArray(d) ? d : (d.bookings || [])
          const hit = list.find((b: any) => (b.bookingCode || '').toLowerCase() === bookingCode.trim().toLowerCase())
          if (!hit) throw new Error(`ไม่พบใบจองรหัส ${bookingCode.trim()}`)
          bookingId = hit.id
        } else {
          throw new Error('ค้นหาใบจองไม่สำเร็จ — ใส่ลิงก์ไฟล์แทนได้')
        }
      }
      const res = await fetch('/api/mix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, bookingId, dueDate, sourceLink, notes }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'ตั้งคำขอไม่สำเร็จ')
      onDone({ code: data.job?.code || '', notifiedTo: data.notified?.to || [] })
    } catch (e: any) {
      setErr(e?.message || 'ตั้งคำขอไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">งานที่จะมิกซ์ *</label>
        <input
          value={title} onChange={e => setTitle(e.target.value)} required maxLength={200}
          placeholder="เช่น พอดแคสต์ EP.42 / มิกซ์เสียงสัมภาษณ์"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            รหัสใบจอง (ถ้ามี){initialBookingCode && <span className="text-green-600 ml-1">· เติมให้แล้ว</span>}
          </label>
          <input
            value={bookingCode} onChange={e => setBookingCode(e.target.value)}
            placeholder="AGN-260903-01"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md font-mono"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">อยากได้ภายใน</label>
          <input
            type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">ลิงก์ไฟล์ต้นทาง</label>
        <input
          value={sourceLink} onChange={e => setSourceLink(e.target.value)}
          placeholder="https://drive.google.com/…"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
        />
        <p className="text-xs text-gray-400 mt-1">
          ใส่รหัสใบจอง หรือลิงก์ อย่างน้อยหนึ่งอย่าง — ไม่งั้นทีมเสียงไม่รู้ว่าไฟล์อยู่ไหน
        </p>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">โน้ตถึงทีมเสียง</label>
        <textarea
          value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          placeholder="เช่น ตัดเสียงแอร์ออก, ต้องการไฟล์ WAV"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
        />
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button
        type="submit" disabled={saving}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {saving && <Loader2 className="animate-spin" size={14} />}
        ส่งคำขอ
      </button>
    </form>
  )
}
