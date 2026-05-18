import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '@/lib/session'
import { isTeamMember } from '@/lib/team-profiles'

// Gate the whole /ot section (incl. /ot/admin) to the Production team + admins.
// Blocks direct-URL access for anyone outside the team — not just the nav menu.
export default async function OTLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/ot')

  const allowed = session.role === 'ADMIN' || isTeamMember(session.email)
  if (!allowed) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">เฉพาะทีม Production</h1>
        <p className="text-sm text-gray-500 mb-4">
          หน้า OT สำหรับทีม Production เท่านั้น
        </p>
        <Link href="/" className="gf-link">กลับหน้าหลัก</Link>
      </div>
    )
  }

  return <>{children}</>
}
