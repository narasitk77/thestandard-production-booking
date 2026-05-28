'use client'

import Link from 'next/link'
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, X, Plus, ChevronDown } from 'lucide-react'
import { signOut } from 'next-auth/react'

interface NavProps {
  session: { email: string; role: 'USER' | 'ADMIN' } | null
  canSeeOT?: boolean
  canSeeProducer?: boolean
  canApproveOT?: boolean
  canUpload?: boolean
}

/**
 * Operations-console nav: compact, sticky, with a single primary CTA
 * (+ New Booking) and a denser link row. Mobile uses a slide-down sheet.
 *
 * Pages a user touches daily live in `primary`; docs/dev utilities live
 * in `secondary` behind a divider.
 */
export default function Nav({ session, canSeeOT = false, canSeeProducer = false, canApproveOT = false, canUpload = false }: NavProps) {
  const [open, setOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const pathname = usePathname() || '/'
  const isAdmin = session?.role === 'ADMIN'
  const close = () => { setOpen(false); setMoreOpen(false) }

  const isActive = (href: string) =>
    href === '/'
      ? pathname === '/'
      : pathname === href || pathname.startsWith(href + '/')

  // Active-link style — a subtle filled chip rather than an underline; reads
  // well at small text sizes on dense nav.
  const linkClass = (active: boolean, extra = '') =>
    `px-2.5 py-1.5 text-sm rounded-md transition-colors ${
      active
        ? 'bg-gray-900 text-white'
        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
    } ${extra}`

  type Item = { href: string; label: string; show: boolean; tone?: 'default' | 'danger' }
  const primary: Item[] = ([
    { href: '/', label: 'Overview', show: !!session },
    { href: '/calendar', label: 'Calendar', show: true },
    { href: '/my-bookings', label: 'My Bookings', show: !!session },
    { href: '/producer', label: 'Producer', show: !!canSeeProducer },
    { href: '/dashboard', label: 'Dashboard', show: !!isAdmin },
    { href: '/admin', label: 'Admin', show: !!isAdmin, tone: 'danger' as const },
  ] as Item[]).filter(i => i.show)

  const secondary: Item[] = [
    { href: '/ot', label: 'OT', show: !!canSeeOT },
    // Manager / OT approver shortcut — admins also see it (admins already
    // have it via the OT page link too, but this avoids the extra hop).
    { href: '/ot/admin', label: 'OT · Approve', show: !!canApproveOT },
    { href: '/profile/signature', label: 'ลายเซ็น', show: !!session },
    { href: '/manual', label: 'คู่มือ', show: true },
    { href: '/changelog', label: 'อัปเดต', show: true },
    // v1.35.3 — Upload shown to crew (video/sound) + admin via canUpload flag.
    // Previously admin-only because /upload was under-development.
    { href: '/upload', label: 'Upload', show: !!canUpload },
    // v1.35.5 — Admin-only review queue for Mark-as-Done
    { href: '/admin/upload-review', label: 'Upload Review', show: !!isAdmin },
  ].filter(i => i.show)

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-30">
      <div className="px-3 sm:px-4 h-12 flex items-center gap-2">
        {/* Brand */}
        <Link
          href={session ? '/' : '/login'}
          className="flex items-center gap-2 text-gray-900 font-semibold text-sm whitespace-nowrap mr-2"
          aria-label="THE STANDARD Production"
        >
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gray-900 text-white text-[10px] font-bold tracking-wide">TS</span>
          <span className="hidden sm:inline">Production</span>
        </Link>

        {/* Desktop primary links */}
        <div className="hidden md:flex items-center gap-1 flex-1 min-w-0">
          {primary.map(item => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              className={linkClass(isActive(item.href), item.tone === 'danger' && !isActive(item.href) ? 'text-red-600 hover:text-red-700' : '')}
            >
              {item.label}
            </Link>
          ))}

          {secondary.length > 0 && (
            <div className="relative ml-1">
              <button
                onClick={() => setMoreOpen(o => !o)}
                onBlur={() => setTimeout(() => setMoreOpen(false), 150)}
                className={linkClass(false, 'inline-flex items-center')}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
              >
                More <ChevronDown className="w-3.5 h-3.5 ml-0.5" />
              </button>
              {moreOpen && (
                <div className="absolute top-full right-0 mt-1 min-w-[160px] bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-40">
                  {secondary.map(item => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={close}
                      className={`block px-3 py-1.5 text-sm ${isActive(item.href) ? 'bg-gray-100 text-gray-900' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`}
                    >
                      {item.label}
                      {item.href === '/upload' && (
                        <span className="text-[10px] bg-yellow-100 text-yellow-800 px-1 rounded ml-1.5">DEV</span>
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right cluster: CTA + identity (desktop) */}
        <div className="hidden md:flex items-center gap-2 ml-auto">
          {session && (
            <Link
              href="/new"
              className="ops-btn-primary ops-btn-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              New Booking
            </Link>
          )}
          {session ? (
            <div className="flex items-center gap-2 pl-2 border-l border-gray-200">
              <span className="text-xs text-gray-500 truncate max-w-[160px]">{session.email}</span>
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                className="text-xs text-gray-500 hover:text-red-600">
                Sign out
              </button>
            </div>
          ) : (
            <Link href="/login" className="ops-btn-secondary ops-btn-sm">Sign in</Link>
          )}
        </div>

        {/* Mobile right cluster: CTA + hamburger */}
        <div className="md:hidden flex items-center gap-2 ml-auto">
          {session && (
            <Link
              href="/new"
              className="ops-btn-primary ops-btn-sm"
              aria-label="New Booking"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden xs:inline">New</span>
            </Link>
          )}
          <button
            onClick={() => setOpen(o => !o)}
            className="p-1.5 -mr-1 text-gray-600 hover:text-gray-900 rounded-md hover:bg-gray-100"
            aria-label="Menu"
            aria-expanded={open}
          >
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile sheet */}
      {open && (
        <div className="md:hidden border-t border-gray-100 bg-white shadow-sm">
          <div className="px-3 py-2 flex flex-col">
            <div className="flex flex-col">
              {primary.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={close}
                  className={`py-2.5 px-2 text-sm rounded-md ${
                    isActive(item.href)
                      ? 'bg-gray-900 text-white font-medium'
                      : item.tone === 'danger'
                        ? 'text-red-600 hover:bg-red-50'
                        : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
            {secondary.length > 0 && (
              <div className="border-t border-gray-100 mt-2 pt-2 flex flex-col">
                {secondary.map(item => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={close}
                    className={`py-2 px-2 text-xs rounded-md ${isActive(item.href) ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'}`}
                  >
                    {item.label}
                    {item.href === '/upload' && (
                      <span className="text-[10px] bg-yellow-100 text-yellow-800 px-1 rounded ml-1.5">DEV</span>
                    )}
                  </Link>
                ))}
              </div>
            )}
            <div className="border-t border-gray-100 mt-2 pt-2">
              {session ? (
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-xs text-gray-500 truncate flex-1">{session.email}</span>
                  <button
                    onClick={() => { close(); signOut({ callbackUrl: '/login' }) }}
                    className="text-xs text-red-600 px-2 py-1">
                    Sign out
                  </button>
                </div>
              ) : (
                <Link href="/login" onClick={close} className="block py-2 px-2 text-sm text-gray-700">Sign in</Link>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  )
}
