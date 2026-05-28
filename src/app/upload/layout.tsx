import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession, getUploadAccess } from '@/lib/session'

/**
 * v1.35.3 — `/upload` is now the crew-facing entry point for the
 * dual-cloud upload flow. Previously admin-only (under-development
 * banner); now any user who passes `getUploadAccess` (video / sound
 * roster role, or ADMIN) can reach it.
 *
 * The page itself enforces the per-booking assignment + status gates,
 * so the layout's job here is just the role check + "logged in" check.
 */
export default async function UploadLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?next=/upload')

  const canUpload = await getUploadAccess(session.email)
  if (!canUpload) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">Upload not available</h1>
        <p className="text-sm text-gray-500 mb-4">
          Footage upload is limited to the video and sound team. If you should
          have access, ask an admin to add you to the team roster at <code>/admin/team</code>.
        </p>
        <Link href="/my-bookings" className="gf-link">Go to My Bookings</Link>
      </div>
    )
  }

  return <>{children}</>
}
