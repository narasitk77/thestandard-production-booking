import Link from 'next/link'
import { getSession } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'

// v1.50.2 — console gate for the dashboard LIST only. The booking detail
// (/dashboard/[id]) lives outside this group so people on a booking
// (requester / producer / crew) can open their own bookings from
// /my-bookings; the API scopes reads via canViewBooking.
export default async function DashboardConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (session && !hasConsoleAccess(session.role)) {
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
