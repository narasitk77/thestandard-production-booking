'use client'

import { useState } from 'react'
import { Loader2, Link2 } from 'lucide-react'

/**
 * v1.157.1 — UI for POST /api/admin/drive-links/backfill (existed API-only since
 * v1.114, which is exactly why the backfill was never run). Resolves every
 * booking's Drive folders by TODAY's name logic one more time and stores the
 * folder IDs on Booking.driveFolders, so every later read takes the id-first
 * fast path. Dry-run first (read-only plan), then apply. Idempotent — bookings
 * already holding a link keep it; junk ids are dropped by mergeDriveLinks.
 */
export default function DriveLinksBackfillPanel() {
  const [days, setDays] = useState(365)
  const [running, setRunning] = useState<'dry' | 'apply' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [rows, setRows] = useState<Array<{ code: string; keys: string }>>([])

  const run = async (apply: boolean) => {
    if (apply && !confirm(`เขียน Drive link ลง DB จริง (${days} วันย้อนหลัง)?\n\nปลอดภัย: เติมเฉพาะงานที่ยังไม่มี link, ไม่แตะโฟลเดอร์บน Drive, รันซ้ำได้`)) return
    setRunning(apply ? 'apply' : 'dry'); setMsg(null); setRows([])
    try {
      const r = await fetch('/api/admin/drive-links/backfill', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, ...(apply ? { apply: true } : {}) }),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok || !d) {
        // The proxy cuts long requests at ~60s but the sweep keeps running
        // server-side — re-press dry-run in a minute to see what's left.
        setMsg(r.status === 504 || !d
          ? `หมดเวลาที่ proxy (HTTP ${r.status}) — งานยังวิ่งต่อบนเซิร์ฟเวอร์ รอสักครู่แล้วกด "ดูก่อน" ซ้ำเพื่อเช็คส่วนที่เหลือ`
          : (d as any)?.error || `ไม่สำเร็จ (HTTP ${r.status})`)
        return
      }
      const filled = (d.results || []).filter((x: any) => x.links)
      setRows(filled.slice(0, 40).map((x: any) => ({ code: x.code, keys: Object.keys(x.links).join(', ') })))
      setMsg(`${d.dryRun ? '(ดูก่อน — ยังไม่เขียน) ' : '✅ เขียนแล้ว '}สแกน ${d.bookings} งาน · ${d.dryRun ? 'จะเติม' : 'เติม'} link ได้ ${d.stored} งาน` +
        (filled.length > 40 ? ` (แสดง 40 จาก ${filled.length})` : ''))
    } catch (e: any) {
      setMsg(e?.message || 'ไม่สำเร็จ')
    } finally { setRunning(null) }
  }

  return (
    <div className="gf-card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-700 inline-flex items-center gap-1"><Link2 className="w-3.5 h-3.5" /> id-first Drive links</span>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          className="text-xs border border-gray-300 rounded px-1.5 py-1 text-gray-700">
          <option value={60}>60 วัน</option>
          <option value={180}>180 วัน</option>
          <option value={365}>365 วัน</option>
        </select>
        <button onClick={() => run(false)} disabled={!!running}
          title="ดูว่างานไหนยังไม่มี Drive link และจะเติมอะไรได้บ้าง — อ่านอย่างเดียว ไม่เขียน"
          className="text-xs px-3 py-1.5 border border-[#673ab7] text-[#673ab7] rounded hover:bg-purple-50 inline-flex items-center gap-1 disabled:opacity-50">
          {running === 'dry' ? <Loader2 className="w-3 h-3 animate-spin" /> : <span>🔍</span>} ดูก่อน (dry-run)
        </button>
        <button onClick={() => run(true)} disabled={!!running}
          title="เขียน link ลง DB จริง — เติมเฉพาะงานที่ยังขาด, ไม่แตะโฟลเดอร์บน Drive, รันซ้ำได้"
          className="text-xs px-3 py-1.5 border border-amber-600 text-amber-700 rounded hover:bg-amber-50 inline-flex items-center gap-1 disabled:opacity-50">
          {running === 'apply' ? <Loader2 className="w-3 h-3 animate-spin" /> : <span>💾</span>} เขียนจริง (apply)
        </button>
      </div>
      {msg && <div className="text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">{msg}</div>}
      {rows.length > 0 && (
        <div className="text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 max-h-48 overflow-y-auto">
          {rows.map(r => <div key={r.code}><b>{r.code}</b> → {r.keys}</div>)}
        </div>
      )}
      <p className="text-[11px] text-gray-500">
        เก็บ ID โฟลเดอร์ของแต่ละงานลง DB (กล่อง Video / Production Team / เสียง / รูป) —
        หลังจากนี้เปลี่ยนชื่อ/ย้ายโฟลเดอร์ก็ไม่ทำให้ระบบหาไม่เจอ. ตัวเลข fallback ในสรุป Discord
        รายวันควรลดลงจนใกล้ 0 หลังรัน.
      </p>
    </div>
  )
}
