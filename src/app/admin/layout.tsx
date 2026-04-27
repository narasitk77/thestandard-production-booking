import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '@/lib/session'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/admin')
  if (session.role !== 'ADMIN') {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">Admin only</h1>
        <p className="text-sm text-gray-500 mb-4">
          Your account ({session.email}) doesn't have admin access.
          Ask an existing admin to grant you access.
        </p>
        <Link href="/my-bookings" className="gf-link">Go to My Bookings</Link>
      </div>
    )
  }
  return <>{children}</>
}
