import type { Metadata } from 'next'
import './globals.css'
import { getSession } from '@/lib/session'
import Link from 'next/link'
import LogoutButton from './_components/LogoutButton'

export const metadata: Metadata = {
  title: 'Production Booking — THE STANDARD',
  description: 'ระบบ Production Booking ของ THE STANDARD',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  const isAdmin = session?.role === 'ADMIN'

  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <nav className="bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between text-sm">
          <span className="text-gray-600 font-medium">THE STANDARD · Production</span>
          <div className="flex gap-4 items-center">
            <Link href="/calendar" className="gf-link">Calendar</Link>
            <Link href="/manual" className="gf-link">คู่มือ</Link>
            {session && <Link href="/my-bookings" className="gf-link">My Bookings</Link>}
            {isAdmin && <Link href="/dashboard" className="gf-link">Dashboard</Link>}
            {isAdmin && <Link href="/upload" className="gf-link text-gray-400">Upload <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded ml-0.5">DEV</span></Link>}
            {isAdmin && <Link href="/admin" className="text-[#db4437] text-sm hover:underline font-medium">Admin</Link>}
            {session ? (
              <>
                <span className="text-xs text-gray-400 border-l border-gray-200 pl-3 ml-1">{session.email}</span>
                <LogoutButton />
              </>
            ) : (
              <Link href="/login" className="gf-link">Sign in</Link>
            )}
          </div>
        </nav>
        {children}
      </body>
    </html>
  )
}
