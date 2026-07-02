'use client'

import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'

// v1.111 — "ตรวจ NAS ↔ Production Team": shows, per landing folder, whether every
// NAS file (scanned by the Mac agent) has arrived on the Drive side — ✅ ครบ /
// 🔄 กำลังขึ้น / ⏳ ยังไม่เริ่ม. The agent pushes a fresh NAS manifest every ~10
// min; the freshness line shows how old the NAS snapshot is.

interface FolderRow {
  name: string
  nasFiles: number
  nasBytes: number
  driveMatched: number
  missingOnDrive: number
  missingSample: string[]
  complete: boolean
}

const GB = 1024 ** 3
const fmtGB = (b: number) => b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`

export default function NasSyncPanel() {
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<{ nasAt: string | null; folders: FolderRow[]; completeCount: number; totalFolders: number } | null>(null)
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
          📡 NAS ↔ Production Team <span className="text-[11px] text-gray-400 font-normal">(เช็คว่าไฟล์จาก NAS ขึ้น Drive ครบ 100% หรือยัง)</span>
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
            ข้อมูล NAS ล่าสุด: {report.nasAt ? new Date(report.nasAt).toLocaleString('th-TH') : '—'} · ครบแล้ว <b>{report.completeCount}/{report.totalFolders}</b> โฟลเดอร์
          </div>
          <div className="space-y-1">
            {report.folders.map(f => (
              <div key={f.name} className={`text-xs border rounded px-2 py-1.5 ${f.complete ? 'bg-green-50 border-green-200' : f.driveMatched === 0 ? 'bg-gray-50 border-gray-200' : 'bg-amber-50 border-amber-200'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-gray-800">
                    {f.complete ? '✅' : f.driveMatched === 0 ? '⏳' : '🔄'} {f.name}
                  </span>
                  <span className="whitespace-nowrap text-gray-600">
                    {f.driveMatched}/{f.nasFiles} · {fmtGB(f.nasBytes)}
                  </span>
                </div>
                {f.missingOnDrive > 0 && f.missingSample.length > 0 && (
                  <div className="text-[10px] text-gray-500 truncate mt-0.5">ค้าง: {f.missingSample.slice(0, 3).join(', ')}{f.missingOnDrive > 3 ? ` +${f.missingOnDrive - 3}` : ''}</div>
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-500">
            ✅ ครบ = กด "รวมไฟล์เข้ากล่องนี้" ได้เลย · ระบบส่งอีเมลแจ้งทันทีเมื่อโฟลเดอร์ไหนครบ + สรุปรายวัน
          </p>
        </>
      )}
    </div>
  )
}
