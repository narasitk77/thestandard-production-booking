import type { Metadata, Viewport } from 'next'
import './globals.css'
import { getSession, getProducerAccess } from '@/lib/session'
import { isTeamMember } from '@/lib/team-profiles'
import Nav from './_components/Nav'

export const metadata: Metadata = {
  title: 'Production Booking — THE STANDARD',
  description: 'ระบบ Production Booking ของ THE STANDARD',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()

  // OT module is for the Production team — admins also see it (to manage).
  const canSeeOT = !!session && (session.role === 'ADMIN' || isTeamMember(session.email))
  // Producer Dashboard — admins + users with a Producer/Co-Producer position.
  const canSeeProducer = await getProducerAccess(session?.email)

  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <Nav
          session={session ? { email: session.email, role: session.role } : null}
          canSeeOT={canSeeOT}
          canSeeProducer={canSeeProducer}
        />
        {children}
      </body>
    </html>
  )
}
