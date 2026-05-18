import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // AUTH_DISABLED=1 — no login required (trusted LAN deploy). Let everything
  // through; getSession() in src/lib/session.ts supplies the admin identity.
  if (process.env.AUTH_DISABLED === '1') {
    return NextResponse.next()
  }

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

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|api/auth|manual).*)',
  ],
}
