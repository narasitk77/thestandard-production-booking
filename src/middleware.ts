import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { resolveTier, tierAllows, tierHome } from '@/lib/tiers'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // AUTH_DISABLED=1 — trusted-LAN/dev bypass. Without a JWT cookie this gate
  // would bounce every request to /login, so it must short-circuit too. Mirrors
  // getSession() in src/lib/session.ts. Off by default; never set on public prod.
  if (process.env.AUTH_DISABLED === '1') return NextResponse.next()

  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })
  const hasSession = !!token?.email

  const isAuthRequired =
    pathname.startsWith('/admin') ||
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/upload') ||
    pathname.startsWith('/my-bookings') ||
    pathname.startsWith('/calendar') ||
    pathname.startsWith('/ot') ||
    pathname === '/'

  if (isAuthRequired && !hasSession) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(url)
  }

  // v1.73 — the Admin hub (back-office + system management) is ADMIN-only.
  // Non-admin console staff (Coordinator/Manager/Support) get bounced back to
  // the booking queue. Keep this list in sync with ADMIN_HUB in Nav.tsx.
  const isAdminOnlyModule =
    /^\/admin\/(production-space|equipment|loans|repairs|rentals|purchases|vendors|vendor-prices|week-plan|team|reminders|permissions|footage-tools|health)(\/|$)/.test(pathname)
  if (isAdminOnlyModule && (token as any)?.role !== 'ADMIN') {
    const url = request.nextUrl.clone()
    url.pathname = '/admin'
    return NextResponse.redirect(url)
  }

  // v1.90 — tier-based page access (admin/coordinator/sound-mgmt/producer/crew).
  // Pages only (never /api — routes do their own auth). Gated only once the token
  // carries `position` (pre-v1.90 tokens have it undefined; the jwt callback fills
  // it on the next session read), so an old session is never wrongly locked out —
  // it keeps the role-based behaviour above until it refreshes.
  const position = (token as any)?.position
  if (hasSession && position !== undefined && !pathname.startsWith('/api')) {
    const tier = resolveTier((token as any)?.role, position)
    if (!tierAllows(tier, pathname)) {
      const url = request.nextUrl.clone()
      url.pathname = tierHome(tier)
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|api/auth|manual).*)',
  ],
}
