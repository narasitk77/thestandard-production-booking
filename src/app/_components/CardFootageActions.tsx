'use client'

// v1.115 — inline footage actions on queue cards, so ops can consolidate a
// shoot's files into its box AND email "files ready" WITHOUT opening the upload
// page per booking (ops feedback: doing this one-by-one through /upload was slow).
//   📦 รวมไฟล์  — POST /merge (background job) + poll status, live progress.
//   📣 แจ้งไฟล์ครบ — preview recipients → confirm → POST /notify-ready.
// Each card owns its own state, so several can run at once.
import { useState } from 'react'

export default function CardFootageActions({
  bookingId,
  canMerge = true,
  onChanged,
}: {
  bookingId: string
  canMerge?: boolean
  onChanged?: () => void
}) {
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<'' | 'merge' | 'notify'>('')

  const triggerMerge = async () => {
    if (busy) return
    if (!confirm('รวมไฟล์เข้ากล่องของงานนี้?\n\n• ย้ายวิดีโอจาก Production Team (NAS) เข้ากล่อง (MOVE)\n• รวมเสียงจาก Staging เข้า AUDIO\n\nทำเมื่อ NAS ส่งไฟล์ครบแล้ว')) return
    setBusy('merge'); setMsg('⏳ เริ่มย้าย…')
    try {
      const r = await fetch(`/api/bookings/${bookingId}/merge`, { method: 'POST', credentials: 'include' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok && r.status !== 202) { setMsg(d.error || `รวมไฟล์ไม่สำเร็จ (HTTP ${r.status})`); return }
      for (let i = 1; i <= 180; i++) {
        setMsg(`⏳ กำลังย้าย…${i > 12 ? ` (~${Math.round((i * 5) / 60)} นาที)` : ''}`)
        await new Promise(res => setTimeout(res, 5000))
        const sd = await (await fetch(`/api/bookings/${bookingId}/merge`, { credentials: 'include' })).json().catch(() => ({}))
        const job = sd.job || {}
        if (job.done) {
          if (job.error) { setMsg(`❌ ${job.error}`); return }
          const v = job.result?.video || {}, s = job.result?.sound || {}
          const parts: string[] = []
          if (!v.skipped) parts.push(`วิดีโอ ${v.moved ?? 0}/${v.seen ?? 0}`)
          if (!s.skipped && (s.staged ?? 0) > 0) parts.push(`เสียง ${s.copied ?? 0}/${s.staged ?? 0}`)
          setMsg(`✓ ${parts.join(' · ') || 'ไม่มีไฟล์ให้ย้าย'}`)
          onChanged?.()
          return
        }
        if (!job.running) { setMsg('งานย้ายถูกรีเซ็ต — กดใหม่เพื่อย้ายส่วนที่เหลือ'); return }
      }
      setMsg('งานใหญ่มาก ยังย้ายอยู่เบื้องหลัง — กดตรวจภายหลัง')
    } catch (e: any) {
      setMsg(e?.message || 'รวมไฟล์ไม่สำเร็จ')
    } finally {
      setBusy('')
    }
  }

  const triggerNotify = async () => {
    if (busy) return
    setBusy('notify'); setMsg('⏳ ตรวจผู้รับ…')
    try {
      const p = await (await fetch(`/api/bookings/${bookingId}/notify-ready?preview=1`, { method: 'POST', credentials: 'include' })).json().catch(() => ({}))
      if (p.error) { setMsg(p.error); return }
      const recips: string[] = p.recipients || p.to || []
      const folders = p.folderCount ?? p.folders ?? '?'
      if (!recips.length) { setMsg('ไม่มีผู้รับ (ยังไม่ได้ assign / ไม่มีอีเมล)'); return }
      if (!confirm(`ส่งเมล "ไฟล์พร้อม" ให้ ${recips.length} คน?\n\n${recips.join('\n')}\n\nโฟลเดอร์ที่แนบ: ${folders}`)) { setMsg(null); return }
      setMsg('⏳ กำลังส่งเมล…')
      const r = await fetch(`/api/bookings/${bookingId}/notify-ready`, { method: 'POST', credentials: 'include' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setMsg(d.error || `ส่งเมลไม่สำเร็จ (HTTP ${r.status})`); return }
      setMsg(`✓ ส่งแล้ว ${(d.recipients || d.to || recips).length} คน`)
    } catch (e: any) {
      setMsg(e?.message || 'ส่งเมลไม่สำเร็จ')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        {canMerge && (
          <button
            onClick={triggerMerge}
            disabled={!!busy}
            title="รวมไฟล์จาก NAS/Staging เข้ากล่องของงานนี้ (ทำเบื้องหลัง)"
            className="px-2.5 py-1.5 text-xs border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50 disabled:opacity-50 inline-flex items-center gap-1">
            {busy === 'merge' ? '⏳' : '📦'} รวมไฟล์
          </button>
        )}
        <button
          onClick={triggerNotify}
          disabled={!!busy}
          title="ส่งเมลแจ้งทีมงานว่าไฟล์พร้อม พร้อมลิงก์โฟลเดอร์"
          className="px-2.5 py-1.5 text-xs border border-sky-300 text-sky-700 rounded hover:bg-sky-50 disabled:opacity-50 inline-flex items-center gap-1">
          {busy === 'notify' ? '⏳' : '📣'} แจ้งไฟล์ครบ
        </button>
      </div>
      {msg && <div className="text-[11px] text-gray-600 max-w-[220px] text-right leading-tight">{msg}</div>}
    </div>
  )
}
