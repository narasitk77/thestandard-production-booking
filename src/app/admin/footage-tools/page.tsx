import BackButton from '@/app/_components/BackButton'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/session'
import SystemMergeTools from '@/app/_components/admin/SystemMergeTools'
import NasSyncPanel from '@/app/_components/admin/NasSyncPanel'

// v1.111 — ADMIN-only home for the system-wide footage sweeps (moved off the
// per-booking upload page). MOVE NAS footage into boxes / fold staged sound /
// re-scan Drive — all keyed by Production ID across every recent booking.
export const dynamic = 'force-dynamic'

export default async function FootageToolsPage() {
  if (!(await requireAdmin())) redirect('/admin')

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <BackButton fallback="/admin/production-space" label="Admin hub" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900" />
      <div>
        <h1 className="text-lg font-semibold text-gray-800">🎬 รวมไฟล์ footage (ทั้งระบบ)</h1>
        <p className="text-xs text-gray-500 mt-1">
          ย้ายไฟล์ที่ NAS ทิ้งไว้ใน Production Team เข้ากล่อง Video 2026, รวมไฟล์เสียงจาก staging,
          และสแกน Drive หา footage — ตาม Production ID ทั้งระบบ (worker รายชั่วโมงก็ทำให้อัตโนมัติ).
        </p>
      </div>
      <NasSyncPanel />
      <SystemMergeTools />
    </div>
  )
}
