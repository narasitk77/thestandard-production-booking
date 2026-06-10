import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession, getOTApproverAccess } from '@/lib/session'

export default async function OTAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/ot/admin')
  // v1.50 — match the OT API gate (requireOTApprover): ADMIN, MANAGER, or
  // legacy position-contains-"manager". The old ADMIN-only check blocked
  // Manager approvers at the page while the nav and APIs let them through.
  if (!(await getOTApproverAccess(session.email))) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">Approvers only</h1>
        <p className="text-sm text-gray-500 mb-4">หน้านี้สำหรับ Admin / Manager ที่อนุมัติ OT เท่านั้น</p>
        <Link href="/ot" className="gf-link">กลับไปหน้า OT</Link>
      </div>
    )
  }
  return <>{children}</>
}
