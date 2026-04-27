import type { AuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import { prisma } from './db'

const ALLOWED_DOMAIN = 'thestandard.co'
const INITIAL_ADMINS = ['narasit.k@thestandard.co']

export const authOptions: AuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      authorization: {
        params: {
          hd: ALLOWED_DOMAIN,
          prompt: 'select_account',
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

      const existing = await prisma.user.findUnique({ where: { email } })
      if (!existing) {
        await prisma.user.create({
          data: {
            email,
            name: (profile as any)?.name ?? null,
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
    async jwt({ token, user }) {
      const email = (user?.email || token.email)?.toLowerCase()
      if (email) {
        const u = await prisma.user.findUnique({ where: { email } })
        if (u) {
          ;(token as any).role = u.role
          ;(token as any).userId = u.id
          ;(token as any).active = u.active
          token.email = u.email
          token.name = u.name
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        ;(session.user as any).role = (token as any).role || 'USER'
        ;(session.user as any).id = (token as any).userId
      }
      return session
    },
  },
}
