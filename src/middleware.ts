import { NextRequest, NextResponse } from 'next/server'

// Lightweight cookie presence check at the edge.
// Full role validation happens in the route via getSession() (which uses Prisma).
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const hasSession = request.cookies.has('pb_session')

  const isAuthRequired =
    pathname.startsWith('/admin') ||
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/upload') ||
    pathname === '/' ||
    pathname.startsWith('/my-bookings')

  if (isAuthRequired && !hasSession) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|api/auth|calendar).*)',
  ],
}
