'use client'

// v1.115 — inline footage actions on queue cards, so ops can consolidate a
// shoot's files into its box AND email "files ready" WITHOUT opening the upload
// page per booking (ops feedback: doing this one-by-one through /upload was slow).
//   📦 รวมไฟล์  — POST /merge (background job) + poll status, live progress.
//   📣 แจ้งไฟล์ครบ — preview recipients → confirm → POST /notify-ready.
// Each card owns its own state, so several can run at once.
import { useState } from 'react'
import { CARD_HOLD_FIX } from '@/lib/reconciler/guards'

// ── maint 2026-11-08 — pure readers of the two server replies (tested in
// src/lib/__tests__/maint-B5-ui-card-actions.test.ts). UploadSection imports
// both, so the 📦 poll and 📣 result read the same way on the card and the page.

/**
 * One poll of GET /merge. A REAL reset is 200 {job:{running:false, done:false}}
 * (booking-merge.ts getMergeJobStatus). A 502/504 proxy page, a 401 after the
 * session expired, or a 500 is "could not read" — the move is still running
 * server-side, so the poll must keep going instead of announcing a reset (ui-12).
 */
export type MergePoll = 'done' | 'running' | 'reset' | 'unreadable'
export function mergePollState(httpOk: boolean, body: any): MergePoll {
  const job = httpOk && body && typeof body === 'object' ? body.job : null
  if (!job || typeof job !== 'object') return 'unreadable'
  if (job.done) return 'done'
  if (job.running) return 'running'
  return 'reset'
}

/**
 * The result line after POST /notify-ready. The 200 reply carries `recipients`
 * = DELIVERED addresses only and `failedRecipients` = the ones SMTP rejected,
 * so the intended count is their sum; `emailed` is how many sends succeeded.
 * Nothing delivered / email unconfigured come back as 502 / 503 with `error`.
 * The card used to print "✓ ส่งแล้ว N คน" from the recipient list even when
 * SMTP was down (ui-1, bug-classes §1) — ✓ only when every send went out.
 */
export function notifyResultMessage(httpOk: boolean, status: number, d: any): { ok: boolean; text: string } {
  if (!httpOk || !d || d.ok === false) return { ok: false, text: d?.error || `ส่งเมลไม่สำเร็จ (HTTP ${status})` }
  const failed: string[] = Array.isArray(d.failedRecipients) ? d.failedRecipients : []
  const n = Array.isArray(d.recipients) ? d.recipients.length + failed.length : null
  if (d.emailConfigured === false) return { ok: false, text: `⚠️ ระบบอีเมลยังไม่ได้ตั้งค่า — ไม่มีใครได้รับเมล${n !== null ? ` (ตั้งใจส่ง ${n} คน)` : ''}` }
  if (typeof d.emailed !== 'number' || n === null) return { ok: false, text: '⚠️ ส่งคำสั่งแล้ว แต่อ่านผลการส่งไม่ได้ — ตรวจกับทีมก่อนส่งซ้ำ' }
  // emailError already names who missed it; fall back to the list if it is absent
  const err = d.emailError ? ` — ${d.emailError}` : failed.length ? ` — ส่งไม่ถึง: ${failed.join(', ')}` : ''
  if (d.emailed === 0 && n > 0) return { ok: false, text: `❌ ส่งเมลไม่สำเร็จ ไม่มีใครได้รับ (0/${n})${err}` }
  if (d.emailed < n || d.emailError) return { ok: false, text: `⚠️ เมลถึง ${d.emailed}/${n} คน${err}` }
  return { ok: true, text: `✓ ส่งแล้ว ${d.emailed} คน` }
}

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
      let unreadable = 0
      for (let i = 1; i <= 180; i++) {
        setMsg(unreadable
          ? `⚠️ อ่านสถานะไม่ได้ ${unreadable} ครั้งติด — งานยังย้ายอยู่เบื้องหลัง กำลังลองอ่านใหม่…`
          : `⏳ กำลังย้าย…${i > 12 ? ` (~${Math.round((i * 5) / 60)} นาที)` : ''}`)
        await new Promise(res => setTimeout(res, 5000))
        let state: MergePoll = 'unreadable', sd: any = null
        try {
          const sr = await fetch(`/api/bookings/${bookingId}/merge`, { credentials: 'include' })
          sd = await sr.json().catch(() => null)
          state = mergePollState(sr.ok, sd)
        } catch { /* network blip — same as an unreadable poll */ }
        if (state === 'unreadable') { unreadable++; continue }
        unreadable = 0
        const job = sd.job
        if (state === 'done') {
          if (job.error) { setMsg(`❌ ${job.error}`); return }
          const v = job.result?.video || {}, s = job.result?.sound || {}
          const held = v.cardHolds?.length ?? 0 // v1.280 — a held card is not "moved 0"
          const parts: string[] = []
          if (held) parts.push(`⛔ ค้าง ${held} การ์ด — ${CARD_HOLD_FIX}`)
          if (!v.skipped) parts.push(`วิดีโอ ${v.moved ?? 0} ไฟล์${(v.movedFolders ?? 0) > 0 ? ` +${v.movedFolders} โฟลเดอร์` : ''}${v.conflicts ? ` ⚠️ ชื่อซ้ำ (1) ${v.conflicts} ไม่ย้าย` : ''}${v.err ? ` ⚠️ error ${v.err}` : ''}`)
          if (!s.skipped && (s.staged ?? 0) > 0) parts.push(`เสียง ${s.copied ?? 0}/${s.staged ?? 0}`)
          setMsg(`${held || v.err ? '' : '✓ '}${parts.join(' · ') || 'ไม่มีไฟล์ให้ย้าย'}`)
          onChanged?.()
          return
        }
        if (state === 'reset') { setMsg('งานย้ายถูกรีเซ็ต — กดใหม่เพื่อย้ายส่วนที่เหลือ'); return }
      }
      setMsg(unreadable
        ? `⚠️ อ่านสถานะงานย้ายไม่ได้ (${unreadable} ครั้งล่าสุด) — งานอาจยังวิ่งอยู่ เปิดหน้า Upload ของงานนี้เพื่อดูผล`
        : 'งานใหญ่มาก ยังย้ายอยู่เบื้องหลัง — กดตรวจภายหลัง')
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
      // ui-1 — a non-OK preview (502 HTML, 401) used to parse to {} and read as
      // "ไม่มีผู้รับ (ยังไม่ได้ assign)": an error dressed as an empty crew.
      const pr = await fetch(`/api/bookings/${bookingId}/notify-ready?preview=1`, { method: 'POST', credentials: 'include' })
      const p = await pr.json().catch(() => null)
      if (!pr.ok || !p) { setMsg(p?.error || `ตรวจผู้รับไม่สำเร็จ (HTTP ${pr.status})`); return }
      if (p.error) { setMsg(p.error); return }
      const recips: string[] = p.recipients || p.to || []
      const folders = p.folderCount ?? p.folders ?? '?'
      if (!recips.length) { setMsg('ไม่มีผู้รับ (ยังไม่ได้ assign / ไม่มีอีเมล)'); return }
      // v1.274 — the auto path was holding this one back: say why before a human overrides it
      const heldWarn = p.held?.detail ? `⚠️ ระบบอัตโนมัติยังไม่แจ้ง เพราะไฟล์ไม่ครบ (ตรวจ ${String(p.held.at || '').slice(0, 10)}): ${p.held.detail}\nส่งตอนนี้ = ทีมจะได้แจ้งว่าพร้อมทั้งที่ยังขาดไฟล์\n\n` : ''
      if (!confirm(`${heldWarn}ส่งเมล "ไฟล์พร้อม" ให้ ${recips.length} คน?\n\n${recips.join('\n')}\n\nโฟลเดอร์ที่แนบ: ${folders}`)) { setMsg(null); return }
      setMsg('⏳ กำลังส่งเมล…')
      const r = await fetch(`/api/bookings/${bookingId}/notify-ready`, { method: 'POST', credentials: 'include' })
      const d = await r.json().catch(() => null)
      setMsg(notifyResultMessage(r.ok, r.status, d).text)
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
