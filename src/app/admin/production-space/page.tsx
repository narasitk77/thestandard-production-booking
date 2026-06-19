import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, AlertTriangle, ChevronRight } from 'lucide-react'
import { requireAdmin } from '@/lib/session'
import { prisma } from '@/lib/db'
import { startOfTodayBangkok } from '@/lib/bangkok-day'

// Production Admin Space — ADMIN-only inventory-control desk. Organised by the
// real asset lifecycle: คลัง (what we own) → การเคลื่อนไหว (loans out / repairs)
// → จัดซื้อ-จัดหา (rentals/purchases in + suppliers). Each module shows live
// counts and the dashboard surfaces anything that needs action up top.
export const dynamic = 'force-dynamic'

async function getStats() {
  const today = startOfTodayBangkok()
  const in30 = new Date(today.getTime() + 30 * 86_400_000)

  const [
    // Operational status breakdown is over LOANABLE gear only — the 1,200+ fixed
    // assets are a register, not movable stock, and would otherwise drown the bar.
    equipByStatus, equipTotal, equipLoanable, warrantyExpiring,
    loansActive, loansOverdue,
    repairsByStatus,
    rentalsActive, rentalsUnpaid, rentalsPending, rentalsReturnOverdue,
    purchasesByStatus,
    vendorsTotal,
  ] = await Promise.all([
    prisma.equipment.groupBy({ by: ['status'], where: { loanable: true }, _count: { _all: true } }),
    prisma.equipment.count(),
    prisma.equipment.count({ where: { loanable: true } }),
    prisma.equipment.count({ where: { warrantyExpiresAt: { gte: today, lte: in30 } } }),
    prisma.equipmentLoan.count({ where: { status: 'ACTIVE' } }),
    prisma.equipmentLoan.count({ where: { status: 'ACTIVE', dueDate: { lt: today } } }),
    prisma.repairTicket.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.rentalJob.count({ where: { status: 'ACTIVE' } }),
    prisma.rentalJob.count({ where: { status: { not: 'ARCHIVED' }, paymentStatus: { in: ['PENDING', 'INVOICED'] } } }),
    prisma.rentalJob.count({ where: { status: { not: 'ARCHIVED' }, paymentStatus: 'PENDING' } }),
    prisma.rentalJob.count({ where: { status: 'ACTIVE', returnedAt: null, returnDueDate: { not: null, lt: today } } }),
    prisma.purchaseItem.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.vendor.count(),
  ])

  const g = (rows: any[], v: string) => rows.find((r) => r.status === v)?._count._all ?? 0
  return {
    equip: {
      total: equipTotal, loanable: equipLoanable, warrantyExpiring,
      available: g(equipByStatus, 'AVAILABLE'), onLoan: g(equipByStatus, 'ON_LOAN'),
      inRepair: g(equipByStatus, 'IN_REPAIR'), retired: g(equipByStatus, 'RETIRED'),
    },
    loans: { active: loansActive, overdue: loansOverdue },
    repairs: { open: g(repairsByStatus, 'REPORTED') + g(repairsByStatus, 'SENT'), done: g(repairsByStatus, 'RETURNED') },
    rentals: { active: rentalsActive, unpaid: rentalsUnpaid, pending: rentalsPending, returnOverdue: rentalsReturnOverdue },
    purchases: { open: g(purchasesByStatus, 'OPEN'), received: g(purchasesByStatus, 'RECEIVED') },
    vendors: { total: vendorsTotal },
  }
}

// ── small presentational helpers ───────────────────────────────────────────
function Metric({ label, value, tone = 'gray' }: { label: string; value: number; tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue' }) {
  const c = {
    gray: 'text-gray-800', green: 'text-green-700', amber: 'text-amber-700', red: 'text-red-600', blue: 'text-blue-700',
  }[tone]
  return (
    <div className="flex flex-col">
      <span className={`text-lg font-semibold tabular-nums ${value === 0 && tone !== 'gray' ? 'text-gray-300' : c}`}>{value.toLocaleString('th-TH')}</span>
      <span className="text-[11px] text-gray-500">{label}</span>
    </div>
  )
}

function ModuleCard({ href, emoji, title, sub, children }: { href: string; emoji: string; title: string; sub: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="group block border border-gray-200 rounded-lg p-4 bg-white hover:border-[#673ab7] hover:shadow-sm transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">{emoji}</span>
          <div>
            <div className="text-sm font-medium text-gray-800">{title}</div>
            <div className="text-[11px] text-gray-500">{sub}</div>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-[#673ab7]" />
      </div>
      <div className="flex gap-5">{children}</div>
    </Link>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[11px] uppercase tracking-wide text-gray-400 font-medium mt-6 mb-2">{children}</h2>
}

export default async function ProductionAdminSpacePage() {
  const session = await requireAdmin()
  if (!session) redirect('/admin')
  const s = await getStats()

  // Active inventory bar (exclude retired from the usable-stock proportion).
  const usable = s.equip.available + s.equip.onLoan + s.equip.inRepair || 1
  const bar = [
    { w: (s.equip.available / usable) * 100, c: 'bg-green-500' },
    { w: (s.equip.onLoan / usable) * 100, c: 'bg-amber-500' },
    { w: (s.equip.inRepair / usable) * 100, c: 'bg-red-500' },
  ]

  const alerts = [
    { n: s.loans.overdue, href: '/admin/loans', label: 'ยืมเกินกำหนด', tone: 'red' as const },
    { n: s.rentals.returnOverdue, href: '/admin/rentals?status=ACTIVE', label: 'ของเช่าเลยกำหนดคืน', tone: 'red' as const },
    { n: s.rentals.pending, href: '/admin/rentals?payment=PENDING', label: 'ค่าเช่ารอจ่าย', tone: 'red' as const },
    { n: s.repairs.open, href: '/admin/repairs', label: 'งานซ่อมค้าง', tone: 'amber' as const },
    { n: s.equip.warrantyExpiring, href: '/admin/equipment?warranty=soon', label: 'ประกันใกล้หมด (30 วัน)', tone: 'amber' as const },
  ].filter((a) => a.n > 0)

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3">
        <ArrowLeft className="w-4 h-4" /> คิวงาน
      </Link>

      <div className="mb-2">
        <h1 className="text-xl sm:text-2xl font-normal text-gray-800">Production Admin Space</h1>
        <p className="text-xs sm:text-sm text-gray-500 mt-1">
          ระบบคลังอุปกรณ์ (เฉพาะ Admin) — ติดตามสถานะอุปกรณ์ การยืม-คืน ซ่อม เช่า จัดซื้อ และผู้ขาย
        </p>
      </div>

      {/* Attention — anything that needs action */}
      {alerts.length > 0 ? (
        <div className="flex items-center gap-2 flex-wrap mt-3 mb-1">
          <span className="inline-flex items-center gap-1 text-xs text-amber-700 font-medium">
            <AlertTriangle className="w-3.5 h-3.5" /> ต้องจัดการ:
          </span>
          {alerts.map((a) => (
            <Link key={a.label} href={a.href}
              className={`text-xs px-2.5 py-1 rounded-full font-medium border ${a.tone === 'red' ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100' : 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'}`}>
              {a.label} <span className="tabular-nums font-semibold">{a.n}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-1.5 mt-3 inline-block">
          ✓ ไม่มีรายการค้างที่ต้องจัดการ
        </div>
      )}

      {/* ── คลังอุปกรณ์ ── */}
      <SectionTitle>คลังอุปกรณ์</SectionTitle>
      <Link href="/admin/equipment" className="group block border border-gray-200 rounded-lg p-4 bg-white hover:border-[#673ab7] hover:shadow-sm transition-colors">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🎒</span>
            <div>
              <div className="text-sm font-medium text-gray-800">Equipment · อุปกรณ์</div>
              <div className="text-[11px] text-gray-500">
                ทั้งหมด {s.equip.total.toLocaleString('th-TH')} ชิ้น · ยืมออกได้ {s.equip.loanable.toLocaleString('th-TH')} ชิ้น
              </div>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-[#673ab7]" />
        </div>
        {/* stacked status bar — loanable gear only (operational stock) */}
        <div className="text-[10px] text-gray-400 mb-1">สถานะอุปกรณ์ที่ยืมได้ ({s.equip.loanable.toLocaleString('th-TH')} ชิ้น)</div>
        <div className="flex h-2 rounded-full overflow-hidden bg-gray-100 mb-3">
          {bar.map((seg, i) => seg.w > 0 && <div key={i} className={seg.c} style={{ width: `${seg.w}%` }} />)}
        </div>
        <div className="flex gap-6">
          <Metric label="พร้อมใช้" value={s.equip.available} tone="green" />
          <Metric label="ถูกยืม" value={s.equip.onLoan} tone="amber" />
          <Metric label="กำลังซ่อม" value={s.equip.inRepair} tone="red" />
          <Metric label="ปลดระวาง" value={s.equip.retired} tone="gray" />
        </div>
      </Link>

      {/* ── การเคลื่อนไหว ── */}
      <SectionTitle>การเคลื่อนไหว</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ModuleCard href="/admin/loans" emoji="🔑" title="Loans · ยืม-คืน" sub="อุปกรณ์ที่ถูกยืมออก">
          <Metric label="ยืมอยู่" value={s.loans.active} tone="amber" />
          <Metric label="เกินกำหนด" value={s.loans.overdue} tone="red" />
        </ModuleCard>
        <ModuleCard href="/admin/repairs" emoji="🔧" title="Repairs · ซ่อม" sub="งานซ่อม/บำรุงรักษา">
          <Metric label="ค้างซ่อม" value={s.repairs.open} tone="red" />
          <Metric label="ซ่อมเสร็จ" value={s.repairs.done} tone="green" />
        </ModuleCard>
      </div>

      {/* ── จัดซื้อ-จัดหา & ผู้ขาย ── */}
      <SectionTitle>จัดซื้อ-จัดหา &amp; ผู้ขาย</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <ModuleCard href="/admin/rentals" emoji="📦" title="Rentals · เช่าเข้า" sub="เช่าอุปกรณ์จากภายนอก">
          <Metric label="กำลังเช่า" value={s.rentals.active} tone="blue" />
          <Metric label="ค้างจ่าย" value={s.rentals.unpaid} tone="red" />
        </ModuleCard>
        <ModuleCard href="/admin/purchases" emoji="🛒" title="Purchases · จัดซื้อ" sub="สั่งซื้ออุปกรณ์ใหม่">
          <Metric label="รอดำเนินการ" value={s.purchases.open} tone="amber" />
          <Metric label="รับของแล้ว" value={s.purchases.received} tone="green" />
        </ModuleCard>
        <ModuleCard href="/admin/vendors" emoji="🏷️" title="Vendors · ผู้ขาย" sub="ร้านเช่า/ซ่อม/ขาย">
          <Metric label="ทั้งหมด" value={s.vendors.total} tone="gray" />
        </ModuleCard>
      </div>

      {/* ── ระบบ / จัดการ (v1.73 — moved here from the queue console) ── */}
      <SectionTitle>ระบบ / จัดการ</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { href: '/admin/team', emoji: '👥', title: 'ทีมงาน', sub: 'Crew roster' },
          { href: '/admin/permissions', emoji: '🔑', title: 'สิทธิ์ผู้ใช้', sub: 'Roles & access' },
          { href: '/admin/reminders', emoji: '⏰', title: 'Reminders', sub: 'แจ้งเตือนของค้าง' },
          { href: '/admin/health', emoji: '🩺', title: 'Health', sub: 'สถานะระบบ' },
        ].map(m => (
          <Link key={m.href} href={m.href} className="group block border border-gray-200 rounded-lg p-3 bg-white hover:border-[#673ab7] hover:shadow-sm transition-colors">
            <div className="text-lg">{m.emoji}</div>
            <div className="text-sm font-medium text-gray-800 mt-1">{m.title}</div>
            <div className="text-[11px] text-gray-500">{m.sub}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}
