import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.288 — นัท 12 พ.ย. 2569 "ให้ตัวสแกน NAS ตรวจ MEDIAPRO ได้ตั้งแต่ไฟล์เข้า NAS — โอเค"
// ตัวสแกนบน NAS อ่าน MEDIAPRO.XML → ระบบจำว่าต้นฉบับไหนเคยเข้า NAS (NAS อัปแล้วลบ) → การ์ดก็อปเสร็จ (ไม่มีไฟล์ใหม่/เขียน 10 นาที)
// แต่ต้นฉบับบางคลิปไม่เคยเข้า NAS และไม่อยู่ในโฟลเดอร์ Drive ของงานนี้ = ก็อปจากการ์ดไม่ครบ → บอกทีมตอนการ์ดยังอยู่ในมือ

const MIN = 60_000
let prevRow: any = null
let chats: string[] = []
let chatOk = true
let alerts: any[] = []
let driveFiles: Array<{ name: string; folderPath: string[] }> = []
let driveRoots: Array<{ id: string; name: string; parents: string[] }> = [{ id: 'landing', name: 'L', parents: [] }]
let listings = 0
let rootLookups = 0
let bigListing = false
let hangRoots: Promise<void> | null = null
let driveFails = false
let shootDates: Record<string, string> = {}
mock.module('../db', {
  namedExports: {
    prisma: {
      nasSyncState: {
        findUnique: async () => prevRow,
        upsert: async ({ update }: any) => { await new Promise(r => setTimeout(r, 5)); prevRow = { status: update.status, manifest: update.manifest }; return {} },
      },
      booking: { findMany: async ({ where }: any) => (where?.bookingCode?.in || []).filter((c: string) => shootDates[c]).map((c: string) => ({ bookingCode: c, shootDate: new Date(`${shootDates[c]}T00:00:00Z`) })) },
    },
  },
})
mock.module('../email', { namedExports: { sendEmail: async () => {}, isEmailConfigured: () => false } })
mock.module('../notify', { namedExports: { notifyChat: async (m: string) => { chats.push(m); return chatOk } } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../ops-alert', { namedExports: { alertOps: async (key: string, subject: string, text: string) => { alerts.push({ key, subject, text }); return { attempted: true, delivered: true } } } })
mock.module('../google-drive', {
  namedExports: {
    findFoldersByCode: async () => { rootLookups++; if (hangRoots) await hangRoots; if (driveFails) throw new Error('Drive 403 rateLimitExceeded'); return driveRoots },
    listFilesRecursive: async () => { listings++; return bigListing ? Array.from({ length: 20000 }, (_, i) => ({ name: `x${i}.MXF`, folderPath: [] })) : driveFiles },
    findChildFolder: async () => null,
    SOUND_STAGING_DIR: '_SOUND-STAGING',
    listSoundStagingTree: async () => ({ bookings: [], containerIds: [] }),
  },
})

let nas: typeof import('../nas-sync')
let nc: typeof import('../nas-cards')
before(async () => { nas = await import('../nas-sync'); nc = await import('../nas-cards') })
beforeEach(() => {
  prevRow = null; chats = []; chatOk = true; alerts = []; driveFiles = []; driveRoots = [{ id: 'landing', name: 'L', parents: [] }]
  listings = 0; rootLookups = 0; bigListing = false; driveFails = false; shootDates = {}
})

const NAME = 'EP01 · ทดสอบ (NWS-KYM-261110-01)'
const DIR = 'EP01/CAM-A/XDROOT'
const O = (n: number) => `Clip/A001C${String(n).padStart(3, '0')}_261110XF.MXF`
const card = (n = 3, extra: any = {}) => ({ dir: DIR, origs: Array.from({ length: n }, (_, i) => O(i + 1)), ...extra })
const files = (...ns: number[]) => ns.map(n => ({ p: `${DIR}/${O(n)}`, size: 1000 }))
const manifest = (fs: any[], c: any = card(), extra: any = {}) => ({ at: new Date().toISOString(), folders: [{ name: NAME, files: fs, ...(c ? { cards: [c] } : {}), ...extra }] })
/** this card's MEDIAPRO.XML on Drive at the given folder path — the proof the card's path maps (C0001-style names) */
const anchor = (...segs: string[]) => ({ name: 'MEDIAPRO.XML', folderPath: segs })
const onDrive = (...ns: number[]) => ns.map(n => ({ name: O(n).split('/').pop()!, folderPath: ['EP01', 'CAM-A', 'XDROOT', 'Clip'] }))
/** card alerts only — the queue-drain "✅ ซิงค์ขึ้น Drive ครบ" also goes to chat */
const short = () => chats.filter(c => c.includes('การ์ดเข้า NAS ไม่ครบ'))
const age = (min: number) => {  // pretend the stored card state is `min` minutes old
  for (const s of Object.values(prevRow.status.cards) as any[]) {
    s.arrivedAt = new Date(Date.now() - min * MIN).toISOString(); s.firstAt = s.arrivedAt
    if (s.retryAfter) s.retryAfter = new Date(Date.now() - MIN).toISOString()
  }
}

test('ก็อปครบ: ต้นฉบับทุกคลิปเคยเข้า NAS (ถึงจะอัปแล้วลบไปแล้ว) = เงียบ ไม่ต้องถาม Drive', async () => {
  await nas.ingestNasManifest(manifest(files(1, 2)))
  await nas.ingestNasManifest(manifest(files(2, 3)))
  await nas.ingestNasManifest(manifest([], null))
  age(15)
  await nas.ingestNasManifest(manifest([], null))
  assert.deepEqual(short(), [])
  assert.equal(listings, 0)
})

test('ก็อปเสร็จ (เงียบ 10 นาที) แต่ต้นฉบับไม่เคยเข้า NAS และไม่อยู่ใน Drive ของงาน = บอกทีม + ops ครั้งเดียว · ก่อนครบ 10 นาที = ยังไม่บอก', async () => {
  await nas.ingestNasManifest(manifest(files(1, 2)))
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.equal(short().length, 0)
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.equal(short().length, 1)
  assert.match(short()[0], /การ์ดเข้า NAS ไม่ครบ — EP01 · ทดสอบ \(NWS-KYM-261110-01\)/)
  assert.match(short()[0], /MEDIAPRO ระบุต้นฉบับ 3 คลิป · ไม่เคยเข้า NAS และไม่อยู่ในโฟลเดอร์ Drive ของงานนี้ 1 คลิป \(A001C003_261110XF\.MXF\)/)
  assert.match(short()[0], /อย่าเพิ่ง format การ์ด/)
  assert.equal(alerts.length, 1)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.equal(short().length, 1, 'the same gap is told once')
})

test('review: ต้นฉบับเกิน 20 คลิปที่อัปขึ้น Drive ไปก่อนสแกนเห็น = ตรวจครบทุกชื่อจากรายการไฟล์ของงาน ไม่เตือนผิด', async () => {
  driveFiles = onDrive(...Array.from({ length: 30 }, (_, i) => i + 1))
  await nas.ingestNasManifest(manifest(files(31, 32, 33, 34, 35, 36, 37, 38, 39, 40), card(40)))
  age(11)
  await nas.ingestNasManifest(manifest(files(31, 32, 33, 34, 35, 36, 37, 38, 39, 40), card(40)))
  assert.deepEqual(short(), [])
  assert.equal(listings, 1, 'one listing of the booking, every name checked')
})

test('review: C0031.MP4 ของงานอื่นไม่ทำให้การ์ดนี้ "ครบ" — ชื่อซ้ำได้ต้องอยู่ path เดียวกันในโฟลเดอร์ของงานนี้', async () => {
  const m4 = { dir: 'EP01/CAM-B/PRIVATE/M4ROOT', origs: ['CLIP/C0001.MP4', 'CLIP/C0002.MP4'] }
  const fs = [{ p: 'EP01/CAM-B/PRIVATE/M4ROOT/CLIP/C0001.MP4', size: 5 }]
  driveFiles = [anchor('EP01', 'CAM-B', 'PRIVATE', 'M4ROOT'), { name: 'C0002.MP4', folderPath: ['EP01', 'CAM-A', 'PRIVATE', 'M4ROOT', 'CLIP'] }]  // another card's C0002
  await nas.ingestNasManifest(manifest(fs, m4))
  age(11)
  await nas.ingestNasManifest(manifest(fs, m4))
  assert.match(short()[0] || '', /C0002\.MP4/)
  prevRow = null; chats = []
  driveFiles = [anchor('EP01', 'CAM-B', 'PRIVATE', 'M4ROOT'), { name: 'C0002 (1).MP4', folderPath: ['EP01', 'CAM-B', 'PRIVATE', 'M4ROOT', 'CLIP'] }]  // this card's, as a Drive "(1)"
  await nas.ingestNasManifest(manifest(fs, m4))
  age(11)
  await nas.ingestNasManifest(manifest(fs, m4))
  assert.deepEqual(short(), [])
})

test('review: การ์ดเดียวกันถูกเทลงอีกโฟลเดอร์ / โฟลเดอร์ "(1)" — ชื่อ FX6 ที่อยู่โฟลเดอร์ไหนของ NAS ก็นับว่าเข้าแล้ว', async () => {
  const twin = { name: `${NAME} (1)`, files: files(3) }
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [{ name: NAME, files: files(1, 2), cards: [card()] }, twin] })
  age(11)
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [{ name: NAME, files: files(1, 2) }, twin] })
  assert.deepEqual(short(), [])
  assert.equal(listings, 0)
})

test('review: rsync เขียนไฟล์ซ่อน (ไม่อยู่ในรายการ) แต่ lastWrite ของโฟลเดอร์ขยับ = ยังก็อปอยู่ ไม่ตัดสิน — แม้ MEDIAPRO ขึ้น Drive ไปแล้ว', async () => {
  await nas.ingestNasManifest(manifest(files(1, 2), card(3), { lastWrite: 100 }))
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2), null, { lastWrite: 200 }))   // MEDIAPRO.XML already uploaded + removed
  assert.deepEqual(short(), [], 'a write in the folder = still copying')
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2), null, { lastWrite: 200 }))
  assert.equal(short().length, 1)
})

test('review r4: ชื่อโฟลเดอร์ใน Drive เปลี่ยนหลังรวมกล่อง (EP เปลี่ยนชื่อ · "Cam B" → CAM-B · "M4ROOT (1)") ไม่ทำให้เตือนผิด · หา MEDIAPRO ของการ์ดบน Drive ไม่เจอ = ไม่ตัดสิน', async () => {
  const m4 = { dir: 'EP01 · ชื่อเดิม/Cam B/PRIVATE/M4ROOT', origs: ['CLIP/C0001.MP4', 'CLIP/C0002.MP4', 'CLIP/C0003.MP4'] }
  const fs = [{ p: 'EP01 · ชื่อเดิม/Cam B/PRIVATE/M4ROOT/CLIP/C0001.MP4', size: 5 }]
  driveFiles = [anchor('EP01 · ชื่อใหม่', 'CAM-B', 'PRIVATE', 'M4ROOT (1)'), { name: 'C0002.MP4', folderPath: ['EP01 · ชื่อใหม่', 'CAM-B', 'PRIVATE', 'M4ROOT (1)', 'CLIP'] }]
  await nas.ingestNasManifest(manifest(fs, m4))
  age(11)
  await nas.ingestNasManifest(manifest(fs, m4))
  assert.equal(short().length, 1, 'judged through the renamed folders')
  assert.match(short()[0], /1 คลิป \(C0003\.MP4\)/, 'C0002 found at the renamed path; only the really missing C0003 is named')
  prevRow = null; chats = []
  driveFiles = [{ name: 'C0099.MP4', folderPath: ['somewhere'] }]   // the card itself is not on Drive at any mappable path
  await nas.ingestNasManifest(manifest(fs, m4))
  age(11)
  await nas.ingestNasManifest(manifest(fs, m4))
  assert.deepEqual(short(), [], 'cannot prove the path → never "missing"')
  assert.ok((Object.values(prevRow.status.cards)[0] as any).retryAfter, 'retried later')
})

test('review r4: โฟลเดอร์ที่ agent อ่านไม่ได้ / หายจาก manifest ไม่ถูกตัดสินจากข้อมูลเก่า · การ์ดคนละใบลงโฟลเดอร์เดิม = เริ่มนับใหม่', async () => {
  await nas.ingestNasManifest(manifest(files(1, 2)))
  age(11)
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [], skipped: [NAME] })
  assert.deepEqual(short(), [])
  prevRow = null
  await nas.ingestNasManifest(manifest(files(1, 2, 3)))                                  // card 1 complete
  const other = { dir: DIR, origs: ['Clip/B002C001_261110XF.MXF', 'Clip/B002C002_261110XF.MXF'] }
  await nas.ingestNasManifest(manifest([{ p: `${DIR}/Clip/B002C001_261110XF.MXF`, size: 5 }], other))  // another card, same folder
  const st = Object.values(prevRow.status.cards)[0] as any
  assert.deepEqual(st.origs, other.origs)
  assert.deepEqual(st.seen, ['Clip/B002C001_261110XF.MXF'], "the old card's history is not carried over")
})

test('review r4: ตรวจ Drive ค้างเกินเพดาน = เก็บ manifest ต่อ ไม่ตัดสินรอบนี้ และไม่ส่งอะไรตามหลัง', async () => {
  const saved = nas.cardCheck.deadlineMs
  nas.cardCheck.deadlineMs = 50
  let release: () => void = () => {}
  const hold = new Promise<void>(r => { release = r })
  try {
    await nas.ingestNasManifest(manifest(files(1, 2)))
    age(11)
    hangRoots = hold                                  // Drive's folder lookup hangs until released
    await nas.ingestNasManifest(manifest(files(1, 2)))
    assert.ok(prevRow.manifest, 'the manifest was stored on time')
    release()
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual(short(), [], 'the abandoned check sent nothing')
  } finally { nas.cardCheck.deadlineMs = saved; hangRoots = null }
})

test('ไฟล์ยังทยอยเข้า/โตขึ้น = ยังก็อปอยู่ · ไฟล์ถูกอัปแล้วหายไปไม่นับเป็นความเคลื่อนไหว', async () => {
  await nas.ingestNasManifest(manifest(files(1)))
  age(11)
  await nas.ingestNasManifest(manifest([...files(1), { p: `${DIR}/${O(2)}`, size: 10 }]))
  assert.deepEqual(short(), [])
  age(11)
  await nas.ingestNasManifest(manifest([...files(1), { p: `${DIR}/${O(2)}`, size: 5000 }]))
  assert.deepEqual(short(), [])
  age(11)
  await nas.ingestNasManifest(manifest(files(2)))
  assert.equal(short().length, 1)
})

test('review: รายการไฟล์บน NAS ถูกตัดที่เพดาน = ไม่ตัดสิน · หาโฟลเดอร์ Drive ของงานไม่เจอ / list ไม่ได้ = ไม่เตือน และไม่ list ซ้ำทุกนาที', async () => {
  await nas.ingestNasManifest(manifest(files(1, 2), card(), { truncated: true }))
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2), card(), { truncated: true }))
  assert.deepEqual(short(), [])
  prevRow = null
  driveRoots = []
  await nas.ingestNasManifest(manifest(files(1, 2)))
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  await nas.ingestNasManifest(manifest(files(1, 2)))
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.deepEqual(short(), [])
  assert.equal(rootLookups, 1, 'backed off — not a Drive lookup every minute')
  prevRow = null
  driveRoots = [{ id: 'landing', name: 'L', parents: [] }]
  bigListing = true                           // the booking's folders hit the listing cap → cannot judge
  await nas.ingestNasManifest(manifest(files(1, 2)))
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.deepEqual(short(), [])
  bigListing = false
  prevRow = null
  driveRoots = [{ id: 'landing', name: 'L', parents: [] }]
  driveFails = true
  await nas.ingestNasManifest(manifest(files(1, 2)))
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.deepEqual(short(), [])
  assert.ok(prevRow.manifest, 'stored anyway')
  driveFails = false
  age(11)                                     // the back-off ran out
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.equal(short().length, 1, 'retried after the back-off and told')
})

test('review: แชตทีมส่งไม่ถึง = ยังไม่จำว่าแจ้งแล้ว (ops อย่างเดียวหยุดคน format การ์ดไม่ได้) → ลองใหม่หลังพัก', async () => {
  chatOk = false
  await nas.ingestNasManifest(manifest(files(1, 2)))
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.equal(short().length, 1)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.equal(short().length, 1, 'backed off — not every minute')
  chatOk = true
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.equal(short().length, 2)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.equal(short().length, 2, 'told → remembered')
})

test('คลิปลงวันก่อนวันถ่าย (การ์ดไม่ได้ format) ไม่นับ — แต่เก่ากว่าวันถ่ายเกินปี (นาฬิกากล้องรีเซ็ต) ยังนับว่าหาย (กฎเดียวกับด่าน Drive)', async () => {
  shootDates = { 'NWS-KYM-261110-01': '2026-11-11' }
  await nas.ingestNasManifest(manifest(files(1, 2)))
  age(11)
  await nas.ingestNasManifest(manifest(files(1, 2)))
  assert.deepEqual(short(), [], 'A001C003_261110… is dated 10 Nov, the shoot is 11 Nov')
  prevRow = null
  const reset = { dir: DIR, origs: ['Clip/A001C001_210101XF.MXF', 'Clip/A001C002_210101XF.MXF'] }
  await nas.ingestNasManifest(manifest([{ p: `${DIR}/Clip/A001C001_210101XF.MXF`, size: 5 }], reset))
  age(11)
  await nas.ingestNasManifest(manifest([{ p: `${DIR}/Clip/A001C001_210101XF.MXF`, size: 5 }], reset))
  assert.match(short()[0] || '', /A001C002_210101XF/)
})

test('review: MEDIAPRO อ่านไม่ได้จนการ์ดเงียบ = บอก ops ครั้งเดียว (ไม่ใช่เงียบเหมือน "ไม่มีอะไรขาด") · การ์ดเก่ากว่า 7 วันถูกลืม', async () => {
  await nas.ingestNasManifest({ at: new Date().toISOString(), folders: [{ name: NAME, files: files(1), cards: [{ dir: DIR, error: 'ParseError: no element found' }] }] })
  age(11)
  await nas.ingestNasManifest(manifest(files(1), null))
  await nas.ingestNasManifest(manifest(files(1), null))
  assert.deepEqual(short(), [])
  assert.equal(alerts.filter(a => a.key.startsWith('nas-card-unreadable:')).length, 1)
  age(8 * 24 * 60)
  await nas.ingestNasManifest(manifest([], null))
  assert.deepEqual(prevRow.status.cards, {})
})

test('review: manifest สองชุดมาพร้อมกัน (agent ส่งซ้ำตอน server ช้า) = ทำทีละชุด เตือนครั้งเดียว', async () => {
  await nas.ingestNasManifest(manifest(files(1, 2)))
  age(11)
  await Promise.all([nas.ingestNasManifest(manifest(files(1, 2))), nas.ingestNasManifest(manifest(files(1, 2)))])
  assert.equal(short().length, 1)
})

test('quietShortCards / notOnDrive (pure): ชุดที่ขาดเปลี่ยน = ข่าวใหม่ · ชุดเดิม = ไม่ซ้ำ · FX6 ที่ไหนก็ได้ · C0001 ต้อง path เดียวกัน', () => {
  const now = new Date()
  const s = { folder: NAME, dir: DIR, code: 'X', origs: [O(1), O(2)], seen: [O(1)], present: true, firstAt: new Date(0).toISOString(), arrivedAt: new Date(now.getTime() - 20 * MIN).toISOString() }
  assert.deepEqual(nc.quietShortCards({ k: { ...s, present: false } }, now, () => null), [], 'a folder not in this manifest is not judged')
  assert.deepEqual(nc.quietShortCards({ k: s }, now, () => null).map(c => c.missing), [[O(2)]])
  assert.deepEqual(nc.quietShortCards({ k: { ...s, alerted: O(2) } }, now, () => null), [])
  assert.equal(nc.quietShortCards({ k: { ...s, alerted: O(2), origs: [O(1), O(2), O(3)] } }, now, () => null).length, 1)
  assert.deepEqual(nc.notOnDrive([O(2)], DIR, [{ name: 'A001C002_261110XF.MXF', folderPath: ['elsewhere'] }]), [])
  const anc = (...p: string[]) => ({ name: 'MEDIAPRO.XML', folderPath: p })
  assert.deepEqual(nc.notOnDrive(['CLIP/C0002.MP4'], 'CAM-B/M4ROOT', [anc('CAM-B', 'M4ROOT'), { name: 'C0002.MP4', folderPath: ['CAM-A', 'M4ROOT', 'CLIP'] }]), ['CLIP/C0002.MP4'])
  assert.deepEqual(nc.notOnDrive(['CLIP/C0002.MP4'], 'CAM-B/M4ROOT', [anc('CAM-B', 'M4ROOT'), { name: 'C0002.MP4', folderPath: ['CAM-B', 'M4ROOT', 'CLIP'] }]), [])
  assert.equal(nc.notOnDrive(['CLIP/C0002.MP4'], 'CAM-B/M4ROOT', [{ name: 'C0002.MP4', folderPath: ['CAM-B', 'M4ROOT', 'CLIP'] }]), null, 'no anchor → cannot judge')
  assert.deepEqual(nc.notOnDrive([O(2)], DIR, []), [O(2)], 'FX6 names need no anchor')
  assert.equal(nc.normSeg('Cam A-2'), 'CAM-A-2')
  assert.equal(nc.normSeg('EP01 · ชื่อใหม่ (1)'), 'EP01')
  assert.equal(nc.normSeg('M4ROOT (1) (1)'), 'M4ROOT')
})
