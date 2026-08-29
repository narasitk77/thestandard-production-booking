import type { Metadata, Viewport } from 'next'
import './globals.css'
import { getSession, getProducerAccess, getOTApproverAccess, getUploadAccess, getUserTier, getSwitcherAccess } from '@/lib/session'
import { isTeamMember } from '@/lib/team-profiles'
import Nav from './_components/Nav'
import FeedbackWidget from './_components/FeedbackWidget'
import PageEventTracker from './_components/PageEventTracker'
import { isStaging } from '@/lib/app-env'

export const metadata: Metadata = {
  title: 'Production Booking — THE STANDARD',
  description: 'ระบบ Production Booking ของ THE STANDARD',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()

  // OT Approver — ADMIN/MANAGER or anyone with "manager" in their position.
  // Surfaces the /ot/admin link in the nav so managers can reach the review
  // surface without being told the URL.
  const canApproveOT = await getOTApproverAccess(session?.email)
  // OT module is for the Production team — admins also see it (to manage),
  // and OT approvers must see it too (v1.50.1: /ot/admin lives under /ot,
  // so an approver outside the hardcoded roster needs the menu + section).
  const canSeeOT = !!session && (session.role === 'ADMIN' || isTeamMember(session.email) || canApproveOT)
  // Producer Dashboard — admins + users with a Producer/Co-Producer position.
  const canSeeProducer = await getProducerAccess(session?.email)
  // v1.35.3 — Upload — ADMIN or video/sound roster role. Surfaces the
  // /upload link in the nav so crew can find their assigned bookings to
  // upload footage to.
  const canUpload = await getUploadAccess(session?.email)
  // v1.90 — UI tier (admin/coordinator/producer/crew): the nav hides
  // items a tier shouldn't see; middleware blocks the pages to match.
  const tier = await getUserTier(session?.email)
  // v1.211 — /switcher (บันทึกงานไลฟ์). isSwitcher = แท็บหลัก · canOpen = อยู่ใน More
  // บทเรียน v1.168: หน้าที่ไม่มีทางเข้าในเมนู = หน้าที่ยังไม่ได้ปล่อยจริง
  const switcher = await getSwitcherAccess(session?.email, session?.role)

  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        {/* v1.159 — unmissable staging banner so nobody mistakes the test stack
            for the real system (server component: reads APP_ENV directly). */}
        {isStaging() && (
          <div className="bg-amber-500 text-black text-center text-xs font-bold py-1 tracking-wide">
            ⚠️ STAGING — ระบบทดสอบ ข้อมูลในนี้ไม่ใช่ของจริง
          </div>
        )}
        <Nav
          session={session ? { email: session.email, role: session.role } : null}
          tier={tier}
          canSeeOT={canSeeOT}
          canSeeProducer={canSeeProducer}
          canApproveOT={canApproveOT}
          canUpload={canUpload}
          canSeeSwitcher={switcher.canOpen}
          isSwitcher={switcher.isSwitcher}
        />
        {/* v1.190 — บันทึกการเปิดหน้าเฉพาะหน้าใน allowlist (ดู lib/page-events.ts)
            วางไว้หลัง session gate: ไม่มี session = endpoint ตีกลับ ไม่มีอะไรถูกเก็บ */}
        {session && <PageEventTracker />}
        {children}
        {/* v1.133 — floating feedback box on every page (signed-in users only;
            the API needs an identity to reply to). */}
        {session && <FeedbackWidget />}
      </body>
    </html>
  )
}
