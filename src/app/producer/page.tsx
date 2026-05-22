import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession, getProducerAccess } from '@/lib/session'
import ProducerDashboard from './ProducerDashboard'

export const metadata = { title: 'Producer Dashboard — Production Booking' }

export default async function ProducerPage() {
  const session = await getSession()
  if (!session) redirect('/login?next=/producer')

  const allowed = await getProducerAccess(session.email)
  if (!allowed) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">Producer access only</h1>
        <p className="text-sm text-gray-500 mb-4">
          เมนูนี้สำหรับ Producer / Co-Producer — บัญชีของคุณ ({session.email}) ยังไม่มีสิทธิ์
          ขอให้แอดมินตั้ง position เป็น Producer ในหน้า Permissions
        </p>
        <Link href="/my-bookings" className="gf-link">ไปที่ My Bookings</Link>
      </div>
    )
  }

  return <ProducerDashboard producerEmail={session.email} />
}
