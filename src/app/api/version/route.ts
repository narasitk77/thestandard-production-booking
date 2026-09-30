import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import pkg from '../../../../package.json'

export const dynamic = 'force-dynamic'

/**
 * v1.252 — ผล push schema รอบบูตล่าสุด (scripts/schema-sync.js เขียน .schema-sync.json)
 * 'in-sync' | 'accepted' | 'skipped' · null = ไม่มีไฟล์ (อิมเมจก่อน v1.252 หรือ dev ที่ไม่ได้ผ่าน npm start)
 * (push ครั้งเดียวต่อบูต — start.sh ตั้ง SCHEMA_SYNC_DONE ให้รอบใน `npm start` ข้าม · ที่ลบอะไรไปอยู่ใน log `[schema-sync]`)
 * 'skipped' = แอปกำลังรันบน DB ที่ schema ไม่ตรงกับโค้ดของตัวเอง — ปกติเมื่อถอยอิมเมจ, พังเมื่อ deploy ไปข้างหน้า
 * บอกแค่ผลสั้น ๆ ไม่บอกชื่อตาราง (endpoint นี้ public) · รายละเอียดอยู่ใน log ของคอนเทนเนอร์ `[schema-guard]`
 */
function schemaSync(): string | null {
  try {
    const r = JSON.parse(readFileSync(join(process.cwd(), '.schema-sync.json'), 'utf8')).result
    return typeof r === 'string' ? r : 'unreadable'
  } catch (e: any) {
    return e?.code === 'ENOENT' ? null : 'unreadable'
  }
}

/**
 * GET /api/version — what's actually deployed. Public, no secrets: app version
 * (package.json) + the build commit (APP_GIT_SHA, stamped by CI). Lets anyone
 * confirm the running container matches the intended release after a deploy.
 */
export function GET() {
  const sha = process.env.APP_GIT_SHA || ''
  return NextResponse.json({
    version: pkg.version,
    commit: sha || null,
    imageTag: sha ? `sha-${sha.slice(0, 7)}` : null,
    schemaSync: schemaSync(),
  })
}
