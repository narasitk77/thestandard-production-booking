'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { signOut } from 'next-auth/react'

interface NavProps {
  session: { email: string; role: 'USER' | 'ADMIN' } | null
}

export default function Nav({ session }: NavProps) {
  const [open, setOpen] = useState(false)
  const isAdmin = session?.role === 'ADMIN'

  const close = () => setOpen(false)

  const links = (
    <>
      <Link href="/calendar" onClick={close} className="gf-link block py-2 md:py-0">Calendar</Link>
      <Link href="/manual" onClick={close} className="gf-link block py-2 md:py-0">คู่มือ</Link>
      {session && <Link href="/my-bookings" onClick={close} className="gf-link block py-2 md:py-0">My Bookings</Link>}
      {session && <Link href="/ot" onClick={close} className="gf-link block py-2 md:py-0">OT</Link>}
      {isAdmin && <Link href="/dashboard" onClick={close} className="gf-link block py-2 md:py-0">Dashboard</Link>}
      {isAdmin && (
        <Link href="/upload" onClick={close} className="gf-link block py-2 md:py-0 text-gray-400">
          Upload <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded ml-0.5">DEV</span>
        </Link>
      )}
      {isAdmin && (
        <Link href="/admin" onClick={close} className="block py-2 md:py-0 text-[#db4437] text-sm hover:underline font-medium">
          Admin
        </Link>
      )}
    </>
  )

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-30">
      {/* Top bar */}
      <div className="px-4 py-2 flex items-center justify-between text-sm">
        <Link href={session ? '/' : '/login'} className="text-gray-600 font-medium">
          THE STANDARD · Production
        </Link>

        {/* Desktop links */}
        <div className="hidden md:flex gap-4 items-center">
          {links}
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
            {links}
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
