import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import AdminAuditBanner from '@/app/_components/AdminAuditBanner'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/admin')
  // v1.50 — console is open to every staff tier (ADMIN / SUPPORT / MANAGER /
  // COORDINATOR), per the v1.38 role model. This layout still gated on ADMIN
  // from the v1.4 era, locking the other tiers out of the whole /admin tree.
  if (!hasConsoleAccess(session.role)) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">Staff only</h1>
        <p className="text-sm text-gray-500 mb-4">
          Your account ({session.email}) doesn't have console access.
          Ask an admin or manager to grant you a staff role.
        </p>
        <Link href="/my-bookings" className="gf-link">Go to My Bookings</Link>
      </div>
    )
  }
  return (
    <>
      <AdminAuditBanner />
      {children}
    </>
  )
}
