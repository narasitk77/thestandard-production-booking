// v1.244 — ดึงใบจอง/ตอนที่จะผูกกับคำขอมิกซ์ (ฝั่ง DB)
//
// กฎการจับคู่อยู่ใน mix-jobs.ts (บริสุทธิ์ + เทส) ไฟล์นี้แค่ดึงแถวที่เกี่ยวข้องแล้วแปลงเป็น
// รูปที่หน้าเว็บโชว์ได้ — resolve, candidates และ POST ใช้ชุดเดียวกัน จะได้ไม่มีสามที่ที่
// "หาใบจองจากรหัส" ด้วยวิธีต่างกันแล้ววันหนึ่งตอบไม่ตรงกัน

import { prisma } from './db'
import { bookingDisplayName } from './display'
import {
  OPEN_MIX_STATUSES, formatMixNumber, normalizeMixQuery,
  type MixTargetBooking, type MixTargetPick,
} from './mix-jobs'

export const MIX_TARGET_SELECT = {
  id: true,
  bookingCode: true,
  status: true,
  shootDate: true,
  deletedAt: true,
  projectName: true,
  producer: true,
  createdByEmail: true,
  producerEmail: true,
  coProducerEmail: true,
  assignedEmails: true,
  outlet: { select: { code: true, name: true } },
  program: { select: { name: true } },
  episodes: {
    orderBy: { sequence: 'asc' as const },
    select: { id: true, episodeId: true, title: true, sequence: true, program: { select: { name: true } } },
  },
} as const

type Row = Awaited<ReturnType<typeof loadByIds>>[number]

export interface MixTargetView {
  id: string
  bookingCode: string | null
  showName: string
  shootDate: string
  status: string
  outletCode: string
  producer: string | null
  episodes: Array<{ id: string; episodeId: string; title: string; sequence: number }>
}

export function toMixTargetView(b: Row): MixTargetView {
  return {
    id: b.id,
    bookingCode: b.bookingCode,
    showName: bookingDisplayName(b),
    shootDate: b.shootDate.toISOString().slice(0, 10),
    status: b.status,
    outletCode: b.outlet.code,
    producer: b.producer,
    episodes: b.episodes.map(e => ({ id: e.id, episodeId: e.episodeId, title: e.title, sequence: e.sequence })),
  }
}

export function toResolverInput(b: Row): MixTargetBooking {
  return {
    id: b.id,
    bookingCode: b.bookingCode,
    status: b.status,
    shootDate: b.shootDate,
    deletedAt: b.deletedAt,
    createdByEmail: b.createdByEmail,
    producerEmail: b.producerEmail,
    coProducerEmail: b.coProducerEmail,
    assignedEmails: b.assignedEmails,
    episodes: b.episodes.map(e => ({ id: e.id, episodeId: e.episodeId, title: e.title, sequence: e.sequence })),
  }
}

/** ชื่องานที่เติมให้ — คนแก้ต่อได้ · ตอนที่เลือกมีชื่อ = ใช้ชื่อตอน ไม่งั้นใช้ชื่อรายการ */
export function suggestMixTitle(view: MixTargetView, episodeRowId: string | null): string {
  const ep = episodeRowId ? view.episodes.find(e => e.id === episodeRowId) : null
  const epTitle = ep?.title?.trim()
  const base = view.showName.trim()
  if (epTitle && epTitle !== '-' && epTitle !== base) return `${base} · ${epTitle}`.slice(0, 200)
  return base.slice(0, 200)
}

export async function loadByIds(ids: string[]) {
  if (ids.length === 0) return []
  return prisma.booking.findMany({ where: { id: { in: ids } }, select: MIX_TARGET_SELECT })
}

/**
 * ใบจองทุกใบที่ "อาจหมายถึง" ของที่คนพิมพ์ — รหัสใบจอง, ไอดีภายใน, หรือมีตอนที่ EP ID ตรง
 *
 * ดึงรวมใบที่ถูกลบ/ยกเลิกด้วยโดยตั้งใจ ให้ resolveMixTarget บอกเหตุผลได้ว่า "ใบนี้ถูกยกเลิก"
 * แทนที่จะตอบว่า "ไม่พบ" ซึ่งทำให้คนคิดว่าพิมพ์ผิด
 */
export async function loadCandidatesForQuery(raw: string) {
  const q = normalizeMixQuery(raw)
  if (!q) return []
  const id = raw.trim()
  const ci = { equals: q, mode: 'insensitive' as const }
  return prisma.booking.findMany({
    where: {
      OR: [
        { bookingCode: ci },
        ...(id ? [{ id }] : []),
        { episodes: { some: { episodeId: ci } } },
      ],
    },
    select: MIX_TARGET_SELECT,
    take: 40,
  })
}

export interface OpenMixJobView {
  code: string
  status: string
  bookingId: string | null
  episodeRowId: string | null
  episodeCode: string | null
  assigneeEmail: string | null
  dueDate: string | null
}

/** คำขอที่ยังเปิดอยู่ของใบเหล่านี้ — โชว์ในฟอร์มก่อนส่ง กันขอซ้ำโดยไม่รู้ตัว */
export async function openMixJobsFor(bookingIds: string[]): Promise<OpenMixJobView[]> {
  if (bookingIds.length === 0) return []
  const rows = await prisma.mixJob.findMany({
    where: { deletedAt: null, bookingId: { in: bookingIds }, status: { in: [...OPEN_MIX_STATUSES] } },
    select: { number: true, status: true, bookingId: true, episodeRowId: true, episodeCode: true, assigneeEmail: true, dueDate: true },
    orderBy: { number: 'asc' },
  })
  return rows.map(r => ({
    code: formatMixNumber(r.number),
    status: r.status,
    bookingId: r.bookingId,
    episodeRowId: r.episodeRowId,
    episodeCode: r.episodeCode,
    assigneeEmail: r.assigneeEmail,
    dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
  }))
}

export type { MixTargetPick }
