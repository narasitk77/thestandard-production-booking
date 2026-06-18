import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'

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

  // Production Admin Space modules are ADMIN-only. Non-admin staff get bounced
  // back to the console (the module APIs also enforce requireAdmin themselves).
  const isAdminOnlyModule =
    /^\/admin\/(equipment|loans|repairs|rentals|purchases|vendors)(\/|$)/.test(pathname)
  if (isAdminOnlyModule && (token as any)?.role !== 'ADMIN') {
    const url = request.nextUrl.clone()
    url.pathname = '/admin'
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|api/auth|manual).*)',
  ],
}
