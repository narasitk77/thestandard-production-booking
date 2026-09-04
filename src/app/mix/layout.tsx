import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'

/**
 * v1.215 — ประตูของ /mix
 *
 * ต่างจาก /switcher โดยตั้งใจ: ที่นั่นปิดทั้งส่วนไว้ให้เฉพาะสวิตเชอร์ ที่นี่
 * **เปิดให้ทุกคนที่ล็อกอิน** เพราะครึ่งหนึ่งของหน้านี้คือ "ตั้งคำขอ" ซึ่งคนขอคือ
 * โปรดิวเซอร์/คนตัด/ใครก็ได้ที่มีงาน — กั้นด้วย role แล้วต้องมาไล่เพิ่มคนทีละคน
 * และคนที่เพิ่มไม่ทันก็กลับไปทักในไลน์เหมือนเดิม ซึ่งคือเหตุผลที่คิวจะว่างเปล่า
 *
 * การกั้นตัวจริงอยู่ที่ **ปุ่มรับงาน/เปลี่ยนสถานะ** (ทีมเสียงเท่านั้น) บังคับใน
 * src/lib/mix-jobs.ts และเช็คซ้ำที่ route — ไม่ใช่ที่ประตูนี้
 */
export default async function MixLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login?callbackUrl=/mix')
  return <>{children}</>
}
