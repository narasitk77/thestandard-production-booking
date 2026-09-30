/**
 * v1.253 — อ่านรายชื่อคลิปใน Media Pool จากไฟล์โปรเจกต์ DaVinci (.drp) ที่อยู่บน Drive (กฎล้วน ไม่มี Drive — เทสได้)
 *
 * ที่มา (PP-26-034 · 29–30 ก.ย. 2569): ด่านตรวจที่อ่านแค่ Drive ไม่รู้ว่าคลิปไหน "หายทั้งชุด" (ต้นฉบับ + Sub + XML
 * ไม่มีเลย) · Media Pool คือของที่คนตัดดึงเข้ามาใช้จริง เอามาเป็นตัวตั้งแล้วเทียบกับ Drive ทีละคลิปจึงปิดช่องนั้นได้
 *
 * .drp = zip ที่มี `MediaPool/Master/<bin>/…/MpFolder.xml` · คลิปคือ `<Sm2MpVideoClip>` / `<Sm2MpAudioClip>` ที่มี
 * `<Name>` เป็นลูกชั้นแรกถัดจาก `<FieldsBlob>` (path จริงอยู่ใน blob อ่านไม่ได้) · ชื่อ entry ใน zip เป็น UTF-8 แต่ไม่ได้ตั้ง
 * ธง UTF-8 (Python เห็นเป็น cp437) → ถอดเป็น UTF-8 ตรง ๆ · bin มีเลขลำดับนำหน้า `000_` ที่ Resolve ใส่เอง
 */
import { inflateRawSync } from 'zlib'

export interface DrpClip {
  name: string
  kind: 'video' | 'audio'
  /** bin path ไม่มีเลขนำหน้า เช่น `1_FOOTAGE/2026-09-18 · AGN-260918-02/อ.ภาณุ/1 · SYNC` */
  bin: string
  /** รหัสใบจองจากชื่อ bin (null = bin ไม่ได้ตั้งตามคิว) */
  bookingCode: string | null
}

const BOOKING = /\b([A-Z]{2,4}(?:-[A-Z0-9]{2,5})?-\d{6}-\d{2})\b/
const CLIP = /<Sm2Mp(Video|Audio)Clip\b[^>]*>\s*<FieldsBlob>[^<]*<\/FieldsBlob>\s*<Name>([^<]*)<\/Name>/g

function unxml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

/**
 * zip reader แบบพอใช้ (stored/deflate · ไม่มี zip64) — .drp ขนาด ~1–2 MB · อ่านไม่ได้ = throw ไม่ใช่คืนรายการว่าง
 * (Media Pool ว่างจะทำให้ทุกไฟล์บน Drive ดูเหมือน "ยังไม่อยู่ใน Media Pool")
 */
export function unzipEntries(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('drp: ไม่ใช่ไฟล์ zip (หา end-of-central-directory ไม่เจอ)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || p === 0xffffffff) throw new Error('drp: zip64 ยังไม่รองรับ')
  const out = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`drp: central directory เสียที่ entry ${n}`)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nlen)
    p += 46 + nlen + elen + clen
    if (!want(name)) continue
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`drp: local header เสีย (${name})`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`drp: วิธีบีบอัด ${method} ไม่รองรับ (${name})`)
    if (data.length !== usize) throw new Error(`drp: ขนาดหลังแตกไม่ตรง (${name})`)
    out.set(name, data)
  }
  return out
}

export function parseDrpMediaPool(buf: Buffer): DrpClip[] {
  const entries = unzipEntries(buf, n => n.startsWith('MediaPool/') && n.endsWith('/MpFolder.xml'))
  if (!entries.size) throw new Error('drp: ไม่มี MediaPool/**/MpFolder.xml — ไม่ใช่โปรเจกต์ Resolve หรือรูปแบบเปลี่ยน')
  const clips: DrpClip[] = []
  for (const [entry, data] of entries) {
    const bin = entry.split('/').slice(2, -1).map(s => s.replace(/^\d{3}_/, '')).join('/')
    const bookingCode = BOOKING.exec(bin)?.[1] ?? null
    for (const m of data.toString('utf8').matchAll(CLIP)) {
      clips.push({ name: unxml(m[2]).trim(), kind: m[1] === 'Video' ? 'video' : 'audio', bin, bookingCode })
    }
  }
  return clips
}
