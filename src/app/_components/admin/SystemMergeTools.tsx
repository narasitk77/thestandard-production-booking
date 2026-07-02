'use client'

import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'

/**
 * v1.111 — the system-wide footage sweeps, moved off the per-booking upload page
 * (where they timed out at the 60s proxy and confused ops) to the admin hub.
 * Each button gates ALL bookings in the last 45 days by Production ID; the hourly
 * workers do the same automatically — these are the on-demand triggers. For a
 * single job, use "รวมไฟล์เข้ากล่องนี้" on that booking's upload page instead.
 */
export default function SystemMergeTools() {
  const [scanning, setScanning] = useState(false)
  const [mergingSound, setMergingSound] = useState(false)
  const [mergingVideo, setMergingVideo] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const triggerScan = async () => {
    setScanning(true); setMsg(null)
    try {
      const r = await fetch('/api/internal/footage/sync', { credentials: 'include' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) setMsg(d.error || `สแกนไม่สำเร็จ (HTTP ${r.status})`)
      else if (d.skipped || d.ok === false) setMsg(`สแกนยังไม่ทำงาน: ${d.reason || 'ตั้งค่ายังไม่ครบ (DRIVE_FOOTAGE_ROOT / FOOTAGE_LOG_SHEET_ID)'}`)
      else setMsg(`สแกน ${d.scanned ?? 0} ไฟล์ · match ใหม่ ${d.matched ?? 0} · รอ booking ${d.parsedNoBooking ?? 0} · อ่าน ID ไม่ออก ${d.unparsed ?? 0}`)
    } catch (e: any) {
      setMsg(e?.message || 'สแกนไม่สำเร็จ')
    } finally { setScanning(false) }
  }

  const triggerSoundMerge = async () => {
    setMergingSound(true); setMsg(null)
    try {
      const r = await fetch('/api/internal/sound-merge/run', { credentials: 'include' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) setMsg(d.error || `รวมเสียงไม่สำเร็จ (HTTP ${r.status})`)
      else if (d.skipped) setMsg(`รวมเสียงยังไม่ทำงาน: ${d.reason || 'ตั้งค่ายังไม่ครบ'}`)
      else setMsg(`รวมเสียง: ${d.bookings ?? 0} งาน · staged ${d.staged ?? 0} ไฟล์ · ก๊อปเข้ากล่อง ${d.merged ?? 0} · error ${d.errors ?? 0}`)
    } catch (e: any) {
      setMsg(e?.message || 'รวมเสียงไม่สำเร็จ')
    } finally { setMergingSound(false) }
  }

  const triggerVideoMerge = async () => {
    if (!confirm('ย้ายไฟล์วิดีโอจาก Production Team (ที่ NAS ทิ้งไว้) เข้ากล่อง Video 2026 ตาม Production ID ทั้งระบบ?\n\nเป็นการ MOVE (ไฟล์จะหายจาก Production Team) — ทำเมื่อ NAS sync เสร็จแล้ว')) return
    setMergingVideo(true); setMsg(null)
    try {
      const r = await fetch('/api/internal/video-merge/run', { credentials: 'include' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) setMsg(d.error || `รวมไฟล์ไม่สำเร็จ (HTTP ${r.status})`)
      else if (d.skipped) setMsg(`รวมไฟล์ยังไม่ทำงาน: ${d.reason || 'ตั้งค่ายังไม่ครบ'}`)
      else setMsg(`รวมไฟล์วิดีโอ: ${d.bookings ?? 0} งาน · เจอ ${d.landed ?? 0} ไฟล์ · ย้ายเข้ากล่อง ${d.moved ?? 0} · error ${d.errors ?? 0}`)
    } catch (e: any) {
      setMsg(e?.message || 'รวมไฟล์ไม่สำเร็จ')
    } finally { setMergingVideo(false) }
  }

  return (
    <div className="gf-card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={triggerScan} disabled={scanning} title="สแกน Drive หา footage แล้ว match กับ booking ตาม Production ID (ทั้งระบบ)"
          className="text-xs px-3 py-1.5 border border-[#673ab7] text-[#673ab7] rounded hover:bg-purple-50 inline-flex items-center gap-1 disabled:opacity-50">
          {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} สแกนหา footage (ทั้งระบบ)
        </button>
        <button onClick={triggerVideoMerge} disabled={mergingVideo} title="ย้ายไฟล์วิดีโอจาก Production Team (NAS) เข้ากล่อง Video 2026 — MOVE, ทั้งระบบ"
          className="text-xs px-3 py-1.5 border border-[#673ab7] text-[#673ab7] rounded hover:bg-purple-50 inline-flex items-center gap-1 disabled:opacity-50">
          {mergingVideo ? <Loader2 className="w-3 h-3 animate-spin" /> : <span>🎬</span>} รวมไฟล์วิดีโอ (ทั้งระบบ)
        </button>
        <button onClick={triggerSoundMerge} disabled={mergingSound} title="รวมไฟล์เสียงจาก staging เข้าโฟลเดอร์ AUDIO ในกล่อง (ทั้งระบบ)"
          className="text-xs px-3 py-1.5 border border-green-600 text-green-700 rounded hover:bg-green-50 inline-flex items-center gap-1 disabled:opacity-50">
          {mergingSound ? <Loader2 className="w-3 h-3 animate-spin" /> : <span>🎙️</span>} รวมไฟล์เสียง (ทั้งระบบ)
        </button>
        {/* v1.111 — footage-sync worker stays off; export the footage log on demand as CSV instead. */}
        <a href="/api/admin/footage-export" download
          title="ดาวน์โหลด footage log ทั้งหมด (ทุกไฟล์ที่ detect ได้ รวม NAS) เป็น .csv"
          className="text-xs px-3 py-1.5 border border-gray-400 text-gray-700 rounded hover:bg-gray-50 inline-flex items-center gap-1">
          <span>⬇️</span> Export footage (.csv)
        </a>
      </div>
      {msg && <div className="text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">{msg}</div>}
      <p className="text-[11px] text-gray-500">
        ปุ่มเหล่านี้กวาด<b>ทุกงาน</b>ในรอบ 45 วัน — อาจใช้เวลานาน. สำหรับงานเดียว ใช้ปุ่ม
        “รวมไฟล์เข้ากล่องนี้” ในหน้า upload ของงานนั้นแทน (เร็วกว่า ไม่ timeout).
      </p>
    </div>
  )
}
