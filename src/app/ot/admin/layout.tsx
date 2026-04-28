import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '@/lib/session'

export default async function OTAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/ot/admin')
  if (session.role !== 'ADMIN') {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">Admin only</h1>
        <p className="text-sm text-gray-500 mb-4">หน้านี้สำหรับ Admin เท่านั้น</p>
        <Link href="/ot" className="gf-link">กลับไปหน้า OT</Link>
      </div>
    )
  }
  return <>{children}</>
}
