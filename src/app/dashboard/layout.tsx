import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/dashboard')
  // v1.50 — same console gate as /admin: every staff tier, plain USER excluded.
  if (!hasConsoleAccess(session.role)) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">Staff only</h1>
        <p className="text-sm text-gray-500 mb-4">
          The full dashboard is staff-only. You can view bookings you've requested or are assigned to.
        </p>
        <Link href="/my-bookings" className="gf-submit inline-block">Go to My Bookings</Link>
      </div>
    )
  }
  return <>{children}</>
}
