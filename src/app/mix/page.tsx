'use client'

/**
 * v1.215 — /mix · คิวงานมิกซ์เสียง
 *
 * ที่มา: งานมิกซ์ถูกสั่งกันในแชท ไม่มีที่ไหนตอบได้ว่าคิวยาวแค่ไหน ใครกำลังทำอะไร
 * และงานไหนเลยกำหนดไปแล้ว
 *
 * **จงใจเป็นคิวจอง ไม่ใช่สมุดบันทึก** — /switcher เป็น log ให้คนทำงานมากรอกย้อนหลัง
 * และมี 0 แถวตั้งแต่ปล่อยมา ที่นี่กลับด้าน: คนที่กรอกคือคนที่อยากได้ของ ไม่กรอก
 * แล้วไม่ได้งาน ส่วนบันทึกว่าใครทำอะไรเกิดขึ้นเองเป็นผลพลอยได้
 *
 * สองอย่างที่ตั้งใจออกแบบ:
 *  - **ทุกคนเห็นคิวทั้งหมด** ไม่ใช่เฉพาะของตัวเอง — คนขอต้องเห็นว่าคิวยาวแค่ไหน
 *    ก่อนไปรับปากลูกค้าว่าจะได้วันไหน (และกฎ "เห็นเฉพาะของตัวเอง" คือคลาสบั๊ก
 *    ที่ทำให้โปรดิวเซอร์ 59 คนมองไม่เห็นงานตัวเองใน v1.196)
 *  - **ไม่มีช่อง "ด่วน"** มีแต่กำหนดส่ง — ถ้ามีช่องด่วนทุกคนจะติ๊กเหมือนกันหมด
 *    แล้วมันก็ไม่ได้บอกอะไรอีกต่อไป
 *
 * v1.244 — ตัวคิวย้ายไปอยู่ใน MixQueuePanel เพราะหน้าแอดมินต้องใช้ตัวเดียวกัน (แท็บ "คิว Mixing"
 * ของ Sound Admin) · สองสำเนาของคิวเดียวคือสองชุดกฎปุ่มที่ค่อย ๆ ไม่ตรงกัน (bug-classes #9)
 * · ?scope=mine คือปลายทางในเมลแจกงาน จึงต้องอ่านจาก URL
 */

import { useEffect, useState } from 'react'
import MixQueuePanel from '@/app/_components/MixQueuePanel'

type Scope = 'open' | 'mine' | 'all'
const SCOPES: readonly string[] = ['open', 'mine', 'all']

export default function MixQueuePage() {
  // อ่าน URL ใน effect แทน useSearchParams เพื่อเลี่ยงข้อบังคับ Suspense ตอน build
  const [scope, setScope] = useState<Scope | null>(null)
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('scope') || ''
    setScope(SCOPES.includes(s) ? (s as Scope) : 'open')
  }, [])

  if (!scope) return null
  return <MixQueuePanel variant="page" initialScope={scope} />
}
