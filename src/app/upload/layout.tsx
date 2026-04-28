import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '@/lib/session'
import { Construction } from 'lucide-react'

export default async function UploadLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/upload')
  if (session.role !== 'ADMIN') {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">Admin only</h1>
        <p className="text-sm text-gray-500 mb-4">
          Upload module is currently restricted to admins.
        </p>
        <Link href="/my-bookings" className="gf-link">Go to My Bookings</Link>
      </div>
    )
  }

  // Admin sees the under-development banner
  return (
    <div>
      <div className="bg-yellow-50 border-b border-yellow-200 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center gap-3 text-sm text-yellow-800">
          <Construction className="w-4 h-4 flex-shrink-0" />
          <div>
            <span className="font-medium">Under Development.</span>{' '}
            <span className="text-yellow-700">This module is not yet ready for production use. Visible to admins only.</span>
          </div>
        </div>
      </div>
      {children}
    </div>
  )
}
