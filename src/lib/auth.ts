import type { AuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import { prisma } from './db'
import { findProfileByEmail } from './team-profiles'

const ALLOWED_DOMAIN = 'thestandard.co'
// Who is auto-promoted to ADMIN on first login. Configurable so the seed admin
// isn't a hidden single-person dependency baked in code; defaults to the
// original owner when the env var is unset.
const INITIAL_ADMINS = (process.env.INITIAL_ADMIN_EMAILS || 'narasit.k@thestandard.co')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

async function refreshAccessToken(token: any) {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      }),
    })
    const refreshed = await response.json()
    if (!response.ok) throw refreshed

    return {
      ...token,
      accessToken: refreshed.access_token,
      accessTokenExpires: Date.now() + (refreshed.expires_in || 3600) * 1000,
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
      accessTokenError: undefined,
    }
  } catch (error) {
    console.error('Google access token refresh failed:', error)
    return {
      ...token,
      accessTokenError: 'RefreshAccessTokenError',
    }
  }
}

export const authOptions: AuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      authorization: {
        params: {
          hd: ALLOWED_DOMAIN,
          prompt: 'consent select_account',
          access_type: 'offline',
          response_type: 'code',
          scope: [
            'openid',
            'email',
            'profile',
            'https://www.googleapis.com/auth/gmail.send',
          ].join(' '),
        },
      },
    }),
  ],
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: '/login', error: '/login' },
  callbacks: {
    async signIn({ profile }) {
      const email = (profile as any)?.email?.toLowerCase()
      if (!email) return false
      if (!email.endsWith('@' + ALLOWED_DOMAIN)) return '/login?error=domain'

      const teamProfile = findProfileByEmail(email)
      const existing = await prisma.user.findUnique({ where: { email } })
      if (!existing) {
        await prisma.user.create({
          data: {
            email,
            name: (profile as any)?.name ?? null,
            thaiName: teamProfile?.thaiName ?? null,
            employeeId: teamProfile?.employeeId ?? null,
            position: teamProfile?.position ?? null,
            role: INITIAL_ADMINS.includes(email) ? 'ADMIN' : 'USER',
          },
        })
      } else {
        if (!existing.active) return '/login?error=disabled'
        if ((profile as any)?.name && existing.name !== (profile as any).name) {
          await prisma.user.update({
            where: { id: existing.id },
            data: { name: (profile as any).name },
          })
        }
      }
      return true
    },
    async jwt({ token, user, account }) {
      let nextToken: any = token
      if (account?.access_token) {
        nextToken = {
          ...nextToken,
          accessToken: account.access_token,
          accessTokenExpires: account.expires_at ? account.expires_at * 1000 : Date.now() + 3600 * 1000,
          refreshToken: account.refresh_token ?? nextToken.refreshToken,
          accessTokenError: undefined,
        }
      } else if (
        nextToken.accessToken &&
        nextToken.accessTokenExpires &&
        Date.now() > nextToken.accessTokenExpires - 60_000 &&
        nextToken.refreshToken
      ) {
        nextToken = await refreshAccessToken(nextToken)
      }

      const email = (user?.email || nextToken.email)?.toLowerCase()
      if (email) {
        const u = await prisma.user.findUnique({ where: { email } })
        if (u) {
          nextToken.role = u.role
          nextToken.userId = u.id
          nextToken.active = u.active
          nextToken.email = u.email
          nextToken.name = u.name
        }
      }
      return nextToken
    },
    async session({ session, token }) {
      if (session.user) {
        ;(session.user as any).role = (token as any).role || 'USER'
        ;(session.user as any).id = (token as any).userId
        // v1.50 — surface active so getSession can revoke deactivated users
        // mid-token (signIn only blocks them at login; the JWT lives 7 days).
        ;(session.user as any).active = (token as any).active
        ;(session.user as any).accessTokenError = (token as any).accessTokenError
      }
      return session
    },
  },
}
