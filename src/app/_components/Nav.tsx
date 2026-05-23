'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Menu, X, Plus } from 'lucide-react'
import { signOut } from 'next-auth/react'

interface NavProps {
  session: { email: string; role: 'USER' | 'ADMIN' } | null
  // True only for Production-team members and admins — gates the OT menu.
  canSeeOT?: boolean
  // True for admins + Producer/Co-Producer positions — gates the Producer menu.
  canSeeProducer?: boolean
}

export default function Nav({ session, canSeeOT = false, canSeeProducer = false }: NavProps) {
  const [open, setOpen] = useState(false)
  const isAdmin = session?.role === 'ADMIN'

  const close = () => setOpen(false)

  // Primary nav: actions a user reaches for daily. Order matters — left-to-right
  // matches the typical task flow (book → check schedule → check status).
  const primary = (
    <>
      <Link href="/calendar" onClick={close} className="gf-link block py-2 md:py-0">Calendar</Link>
      {session && <Link href="/my-bookings" onClick={close} className="gf-link block py-2 md:py-0">My Bookings</Link>}
      {canSeeProducer && <Link href="/producer" onClick={close} className="gf-link block py-2 md:py-0">Producer</Link>}
      {isAdmin && <Link href="/dashboard" onClick={close} className="gf-link block py-2 md:py-0">Dashboard</Link>}
      {isAdmin && (
        <Link href="/admin" onClick={close} className="block py-2 md:py-0 text-[#db4437] text-sm hover:underline font-medium">
          Admin
        </Link>
      )}
    </>
  )

  // Secondary nav: docs, team-tools, and dev utilities — rendered smaller and
  // pushed behind a divider so they don't compete with the daily-use links.
  const secondary = (
    <>
      {canSeeOT && <Link href="/ot" onClick={close} className="text-xs text-gray-500 hover:text-gray-800 block py-2 md:py-0">OT</Link>}
      <Link href="/manual" onClick={close} className="text-xs text-gray-500 hover:text-gray-800 block py-2 md:py-0">คู่มือ</Link>
      <Link href="/changelog" onClick={close} className="text-xs text-gray-500 hover:text-gray-800 block py-2 md:py-0">อัปเดต</Link>
      {isAdmin && (
        <Link href="/upload" onClick={close} className="text-xs text-gray-400 hover:text-gray-700 block py-2 md:py-0">
          Upload <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded ml-0.5">DEV</span>
        </Link>
      )}
    </>
  )

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-30">
      <div className="px-4 py-2 flex items-center justify-between text-sm gap-2">
        <Link href={session ? '/' : '/login'} className="text-gray-600 font-medium whitespace-nowrap">
          THE STANDARD · Production
        </Link>

        {/* Desktop links */}
        <div className="hidden md:flex gap-4 items-center">
          {/* Persistent primary CTA — always one click away on every page. */}
          {session && (
            <Link
              href="/"
              className="gf-submit text-xs inline-flex items-center gap-1 py-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              New Booking
            </Link>
          )}
          {primary}
          {(canSeeOT || isAdmin) && <span className="text-gray-200">|</span>}
          {secondary}
          {session ? (
            <>
              <span className="text-xs text-gray-400 border-l border-gray-200 pl-3 ml-1 truncate max-w-[180px]">
                {session.email}
              </span>
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                className="text-xs text-gray-500 hover:text-red-600">
                Sign out
              </button>
            </>
          ) : (
            <Link href="/login" className="gf-link">Sign in</Link>
          )}
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setOpen(o => !o)}
          className="md:hidden p-2 -mr-2 text-gray-600 hover:text-gray-900"
          aria-label="Menu">
          {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="md:hidden border-t border-gray-100 px-4 py-2 bg-white shadow-sm">
          <div className="flex flex-col gap-1 text-sm">
            {session && (
              <Link
                href="/"
                onClick={close}
                className="gf-submit text-xs inline-flex items-center gap-1 self-start mb-2"
              >
                <Plus className="w-3.5 h-3.5" /> New Booking
              </Link>
            )}
            {primary}
            <div className="border-t border-gray-100 mt-2 pt-2 flex flex-col gap-1">
              {secondary}
            </div>
            <div className="border-t border-gray-100 pt-2 mt-2">
              {session ? (
                <>
                  <div className="text-xs text-gray-400 mb-2 truncate">{session.email}</div>
                  <button
                    onClick={() => { setOpen(false); signOut({ callbackUrl: '/login' }) }}
                    className="text-sm text-red-600 py-2">
                    Sign out
                  </button>
                </>
              ) : (
                <Link href="/login" onClick={close} className="gf-link block py-2">Sign in</Link>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  )
}
