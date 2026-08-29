import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession, getSwitcherAccess } from '@/lib/session'

/**
 * v1.211 — ประตูของ /switcher
 *
 * ปิดทั้งส่วน ไม่ใช่แค่ซ่อนเมนู: tiers.ts ปล่อย '/switcher' ผ่านให้ทุก tier
 * (สวิตเชอร์อยู่ tier 'crew' ซึ่งเปิดได้แค่ /upload) การตัดสินตัวจริงจึงต้อง
 * อยู่ตรงนี้ที่รู้จัก roster — แบบเดียวกับ /ot
 */
export default async function SwitcherLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?callbackUrl=/switcher')

  const access = await getSwitcherAccess(session.email, session.role)
  if (!access.canOpen) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-medium text-gray-800 mb-2">เฉพาะทีมสวิตเชอร์</h1>
        <p className="text-sm text-gray-500 mb-4">
          หน้านี้สำหรับทีมสวิตเชอร์และทีมที่ดูแลคิวงาน
          <br />
          ถ้าคุณเป็นสวิตเชอร์แต่เข้าไม่ได้ ให้แจ้งแอดมินตั้งตำแหน่งที่ /admin/permissions
        </p>
        <Link href="/" className="gf-link">กลับหน้าหลัก</Link>
      </div>
    )
  }

  return <>{children}</>
}
