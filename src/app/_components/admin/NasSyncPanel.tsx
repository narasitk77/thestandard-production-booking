'use client'

import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'

// v1.111 — "ตรวจ NAS → Production Team": the NAS is a TRANSFER QUEUE (the sync
// uploads to Drive then deletes the local file), so per folder we show:
//   🔄 กำลังส่ง (queue still has files) · ✅ ส่งครบ (queue drained, files on
//   Drive — counted LIVE by Production ID wherever ops moved them) · ⏳ ยังว่าง.
// The Mac agent refreshes the NAS snapshot every ~10 min.

interface FolderRow {
  name: string
  code: string | null
  nasPending: number
  nasPendingBytes: number
  driveFiles: number | null
  driveBytes: number | null
  state: 'sending' | 'sent' | 'empty'
}

const GB = 1024 ** 3
const fmt = (b: number) => b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`

export default function NasSyncPanel() {
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<{ nasAt: string | null; folders: FolderRow[]; sendingCount: number; sentCount: number } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const check = async () => {
    setLoading(true); setMsg(null)
    try {
      const r = await fetch('/api/admin/nas-sync-report', { credentials: 'include' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.ok === false) { setMsg(d.reason || d.error || `ตรวจไม่สำเร็จ (HTTP ${r.status})`); setReport(null) }
      else setReport(d)
    } catch (e: any) {
      setMsg(e?.message || 'ตรวจไม่สำเร็จ')
    } finally { setLoading(false) }
  }

  return (
    <div className="gf-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-medium text-gray-700">
          📡 NAS → Production Team <span className="text-[11px] text-gray-400 font-normal">(ไฟล์จาก NAS ส่งขึ้น Drive ครบหรือยัง — นับตาม Production ID)</span>
        </div>
        <button onClick={check} disabled={loading}
          className="text-xs px-3 py-1.5 rounded font-medium bg-[#673ab7] text-white hover:bg-[#5e35b1] disabled:opacity-50 inline-flex items-center gap-1">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} ตรวจตอนนี้
        </button>
      </div>
      {msg && <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">{msg}</div>}
      {report && (
        <>
          <div className="text-[11px] text-gray-500">
            ข้อมูล NAS ล่าสุด: {report.nasAt ? new Date(report.nasAt).toLocaleString('th-TH') : '—'} · 🔄 กำลังส่ง <b>{report.sendingCount}</b> · ✅ ส่งครบ <b>{report.sentCount}</b> / {report.folders.length}
          </div>
          <div className="space-y-1">
            {report.folders.map(f => (
              <div key={f.name} className={`text-xs border rounded px-2 py-1.5 ${f.state === 'sent' ? 'bg-green-50 border-green-200' : f.state === 'sending' ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-gray-800">
                    {f.state === 'sent' ? '✅' : f.state === 'sending' ? '🔄' : '⏳'} {f.name}
                  </span>
                  <span className="whitespace-nowrap text-gray-600">
                    {f.nasPending > 0 && <>ค้างคิว {f.nasPending} ({fmt(f.nasPendingBytes)}) · </>}
                    {f.driveFiles != null && <>Drive {f.driveFiles} ไฟล์{f.driveBytes ? ` (${fmt(f.driveBytes)})` : ''}</>}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-500">
            ✅ = คิว NAS ว่าง ไฟล์อยู่บน Drive แล้ว (กด "รวมไฟล์เข้ากล่องนี้" ได้) · ระบบส่งอีเมลแจ้งทันทีเมื่อคิวโฟลเดอร์ไหนระบายหมด + สรุปรายวัน
          </p>
        </>
      )}
    </div>
  )
}
