import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'

// v1.50.2 — this outer layout only requires login. The console wall moved to
// the (console) route group so /dashboard/[id] is reachable by people on the
// booking (my-bookings rows link here); the API enforces per-booking scope.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/dashboard')
  return <>{children}</>
}
