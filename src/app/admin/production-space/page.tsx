import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/session'

// Production Admin Space — ADMIN-only landing for the back-office modules
// (equipment / loans / repairs / rentals / purchases / vendors). Moved off the
// main Admin Console so these tools live in one dedicated, admin-gated space.
export const dynamic = 'force-dynamic'

const MODULES = [
  { href: '/admin/equipment', emoji: '🎒', label: 'Equipment', desc: 'คลังอุปกรณ์ — ค้นด้วยชื่อ/serial/รหัส' },
  { href: '/admin/loans', emoji: '🔑', label: 'Loans', desc: 'ยืม–คืนอุปกรณ์' },
  { href: '/admin/repairs', emoji: '🔧', label: 'Repairs', desc: 'งานซ่อม' },
  { href: '/admin/rentals', emoji: '📦', label: 'Rentals', desc: 'เช่าอุปกรณ์จากภายนอก' },
  { href: '/admin/purchases', emoji: '🛒', label: 'Purchases', desc: 'จัดซื้อ' },
  { href: '/admin/vendors', emoji: '🏷️', label: 'Vendors', desc: 'ผู้ขาย/ร้านค้า' },
]

export default async function ProductionAdminSpacePage() {
  const session = await requireAdmin()
  if (!session) redirect('/admin')

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3">
        <ArrowLeft className="w-4 h-4" /> Admin Console
      </Link>

      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Production Admin Space</h1>
        <p className="text-xs sm:text-sm text-gray-500 mt-1">
          เครื่องมือหลังบ้าน (เฉพาะ Admin) — อุปกรณ์ การยืม ซ่อม เช่า จัดซื้อ และผู้ขาย
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {MODULES.map(m => (
          <Link
            key={m.href}
            href={m.href}
            className="ops-card ops-card-pad hover:border-[#673ab7] hover:shadow-sm transition-colors flex flex-col gap-1"
          >
            <span className="text-2xl">{m.emoji}</span>
            <span className="text-sm font-medium text-gray-800">{m.label}</span>
            <span className="text-xs text-gray-500">{m.desc}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
