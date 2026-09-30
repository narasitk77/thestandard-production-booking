import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'zlib'
import { parseDrpMediaPool, unzipEntries } from '../drp-mediapool'

// v1.253 — zip แบบที่ Resolve เขียน: ชื่อ entry เป็นไบต์ UTF-8 ไม่ตั้งธง UTF-8 · ส่วนใหญ่ deflate

function zip(files: Array<[string, string, 0 | 8]>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text, method] of files) {
    const n = Buffer.from(name, 'utf8')
    const raw = Buffer.from(text, 'utf8')
    const data = method === 8 ? deflateRawSync(raw) : raw
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28)
    ch.writeUInt32LE(offset, 42)
    locals.push(lh, n, data)
    central.push(ch, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const clip = (kind: 'Video' | 'Audio', name: string) =>
  `<Sm2Mp${kind}Clip DbId="x">\n <FieldsBlob>0000</FieldsBlob>\n <Name>${name}</Name>\n` +
  `<PTZRPreset><SmPTZRPreset DbId="y"><FieldsBlob/><Name/></SmPTZRPreset></PTZRPreset></Sm2Mp${kind}Clip>`

test('อ่านคลิปวิดีโอ/เสียงจากทุก bin · ตัดเลขนำหน้า bin · ได้รหัสคิวจากชื่อ bin · ไม่นับ <Name> ที่ซ้อนข้างใน', () => {
  const buf = zip([
    ['project.xml', '<Project/>', 8],
    ['MediaPool/Master/000_1_FOOTAGE/004_2026-09-18 · AGN-260918-02/000_อ.ภาณุ/000_1 · SYNC/MpFolder.xml',
      `<x>${clip('Video', 'A009R001_2609181TS03.MP4')}${clip('Video', 'B&amp;W_title.mov')}</x>`, 8],
    ['MediaPool/Master/000_1_FOOTAGE/004_2026-09-18 · AGN-260918-02/000_อ.ภาณุ/001_3 · AUDIO/MpFolder.xml',
      `<x>${clip('Audio', 'ZOOM0001.WAV')}</x>`, 0],
    ['MediaPool/Master/001_MUSIC/MpFolder.xml', `<x>${clip('Audio', 'Song.wav')}</x>`, 8],
    ['SeqContainer/abc.xml', clip('Video', 'ไม่ใช่ Media Pool.mp4'), 8],
  ])
  assert.deepEqual(parseDrpMediaPool(buf), [
    { name: 'A009R001_2609181TS03.MP4', kind: 'video', bin: '1_FOOTAGE/2026-09-18 · AGN-260918-02/อ.ภาณุ/1 · SYNC', bookingCode: 'AGN-260918-02' },
    { name: 'B&W_title.mov', kind: 'video', bin: '1_FOOTAGE/2026-09-18 · AGN-260918-02/อ.ภาณุ/1 · SYNC', bookingCode: 'AGN-260918-02' },
    { name: 'ZOOM0001.WAV', kind: 'audio', bin: '1_FOOTAGE/2026-09-18 · AGN-260918-02/อ.ภาณุ/3 · AUDIO', bookingCode: 'AGN-260918-02' },
    { name: 'Song.wav', kind: 'audio', bin: 'MUSIC', bookingCode: null },
  ])
})

test('อ่านไม่ได้ = throw ไม่ใช่รายการว่าง (Media Pool ว่างจะทำให้ทุกไฟล์ดูเหมือนยังไม่ถูกนำเข้า)', () => {
  assert.throws(() => parseDrpMediaPool(Buffer.from('not a zip at all, just text')), /ไม่ใช่ไฟล์ zip/)
  assert.throws(() => parseDrpMediaPool(zip([['project.xml', '<Project/>', 8]])), /ไม่มี MediaPool/)
  const bad = zip([['MediaPool/Master/MpFolder.xml', '<x/>', 8]])
  const cdAt = bad.readUInt32LE(bad.length - 22 + 16)
  bad.writeUInt16LE(12, cdAt + 10)
  assert.throws(() => unzipEntries(bad, () => true), /วิธีบีบอัด 12/)
})
