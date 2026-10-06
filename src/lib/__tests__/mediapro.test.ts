import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// v1.254 — "ไฟล์พร้อม" ต้องครบตาม MEDIAPRO.XML ของทุกการ์ด Sony (นัท 2 ต.ค. 2569)
// เคสจริงที่ด่านเดิมปล่อยผ่าน: AGN-260929-01 (ขาด MXF 144 GB) · AGN-260930-01 (ก็อปซ้ำ "A024 (1) (1)…") · TSS-TSS-261001-01 (ขาด 9/20)

let trees: Record<string, any[] | Error> = {}
let xmls: Record<string, string> = {}
let downloads: string[] = []
mock.module('../google-drive', {
  namedExports: {
    listFilesRecursive: async (id: string) => {
      const t = trees[id]
      if (t instanceof Error) throw t
      return t || []
    },
    downloadDriveFile: async (id: string) => {
      downloads.push(id)
      if (!(id in xmls)) throw new Error(`Drive 500 for ${id}`)
      return Buffer.from(xmls[id])
    },
  },
})

let mp: typeof import('../mediapro')
before(async () => { mp = await import('../mediapro') })
beforeEach(() => { trees = {}; xmls = {}; downloads = [] })

// Real FX6 MEDIAPRO (AGN-260929-01 · C022), trimmed to the fields the rule reads.
const material = (clip: string, dur = 1000, fps = '25p', vt = 'AVC_3840_2160_H422IP@L51', dir = 'Clip', sub = 'Sub') => `
  <Material uri="./${dir}/${clip}.MXF" type="MXF" dur="${dur}" fps="${fps}" videoType="${vt}" umid="x">
   <Proxy uri="./${sub}/${clip}S03.MP4" type="MP4"/>
   <RelevantInfo uri="./${dir}/${clip}M01.XML" type="XML"/>
   <RelevantInfo uri="./Thmbnl/${clip}T01.JPG" type="JPG"/>
  </Material>`
const xml = (...mats: string[]) => `<?xml version="1.0"?><MediaProfile xmlns="http://xmlns.sony.net/pro/metadata/mediaprofile"><Contents>${mats.join('')}</Contents></MediaProfile>`

let n = 0
const f = (folderPath: string[], name: string, size = 1000) => ({ id: `f${n++}`, name, size, folderPath, md5: `m-${name}-${folderPath.join('/')}`, mimeType: 'x', parents: [], webViewLink: null, createdTime: null, modifiedTime: null, topFolderId: null } as any)
const card = (root: string[], clip: string, origSize = 1_000_000, opts: { skip?: string[] } = {}) =>
  [[[...root, 'Clip'], `${clip}.MXF`, origSize], [[...root, 'Sub'], `${clip}S03.MP4`, 500], [[...root, 'Clip'], `${clip}M01.XML`, 10], [[...root, 'Thmbnl'], `${clip}T01.JPG`, 10]]
    .filter(([, name]) => !(opts.skip || []).some(s => (name as string).endsWith(s)))
    .map(([p, name, size]) => f(p as string[], name as string, size as number))

test('parseMediapro อ่านทุกไฟล์ของแต่ละคลิป · ไม่ใช่ MEDIAPRO = throw', () => {
  const mats = mp.parseMediapro(xml(material('C022C001_260929R4', 112265)))
  assert.deepEqual(mats, [{ uri: 'Clip/C022C001_260929R4.MXF', dur: 112265, fps: '25p', videoType: 'AVC_3840_2160_H422IP@L51',
    files: ['Clip/C022C001_260929R4.MXF', 'Sub/C022C001_260929R4S03.MP4', 'Clip/C022C001_260929R4M01.XML', 'Thmbnl/C022C001_260929R4T01.JPG'] }])
  assert.throws(() => mp.parseMediapro('<html>error page</html>'), /ไม่ใช่ MEDIAPRO/)
})

test('ครบทุกไฟล์ → ผ่าน · ขาดต้นฉบับ (เคส AGN-260929-01 C022) → ไม่ผ่าน และบอกชื่อไฟล์', () => {
  const root = ['EP.1', 'CAM-C', 'C022', 'XDROOT']
  const cards = [{ folderPath: root, materials: mp.parseMediapro(xml(material('C022C001_260929R4'))) }]
  const full = mp.mediaproCheck(card(root, 'C022C001_260929R4'), cards)
  assert.equal(mp.mediaproComplete(full), true)
  assert.equal(full.listed, 4)
  const short = mp.mediaproCheck(card(root, 'C022C001_260929R4', 1, { skip: ['.MXF'] }), cards)
  assert.deepEqual(short.missing, [{ card: root.join('/'), cardPath: root, file: 'Clip/C022C001_260929R4.MXF' }])
  assert.match(mp.mediaproGapText(short), /ขาด 1 ไฟล์ตาม MEDIAPRO \(C022C001_260929R4\.MXF\)/)
})

test('ไฟล์ที่ย้ายไปโฟลเดอร์อื่นใน EP เดียวกัน ("Clip (1) (1)") ยังนับ · สำเนา MEDIAPRO ซ้ำ (A024 (1)…) ไม่นับซ้ำ', () => {
  const root = ['EP.4', 'CAM-B', 'B026']
  const files = [...card(root, 'B026C001_260930D6', 1, { skip: ['.MXF'] }), f(['EP.4', 'CAM-B', 'B026', 'Clip (1) (1)'], 'B026C001_260930D6.MXF', 1_000_000)]
  const m = mp.parseMediapro(xml(material('B026C001_260930D6')))
  const r = mp.mediaproCheck(files, [{ folderPath: root, materials: m }, { folderPath: ['EP.4', 'CAM-B', 'B026 (1) (1)'], materials: m }])
  assert.equal(mp.mediaproComplete(r), true)
  assert.equal(r.listed, 4, 'สองสำเนาของ MEDIAPRO เดียวกัน = ไฟล์ชุดเดียว')
})

test('M4ROOT C0001 สองการ์ดกล้องเดียวกัน — C0001 ของการ์ด 1 ไม่ทำให้การ์ด 2 ดูครบ', () => {
  const c1 = ['EP01', 'CAM-A', 'Card 1', 'PRIVATE', 'M4ROOT']
  const c2 = ['EP01', 'CAM-A', 'Card 2', 'PRIVATE', 'M4ROOT']
  const m4 = (clip: string) => material(clip, 500, '50p', 'AVC50_1920_1080_H422P@L42', 'CLIP', 'SUB').replace(/\.MXF/g, '.MP4').replace('./Thmbnl/', './THMBNL/')
  const files = [f([...c1, 'CLIP'], 'C0001.MP4'), f([...c1, 'SUB'], 'C0001S03.MP4'), f([...c1, 'CLIP'], 'C0001M01.XML'), f([...c1, 'THMBNL'], 'C0001T01.JPG')]
  const r = mp.mediaproCheck(files, [
    { folderPath: c1, materials: mp.parseMediapro(xml(m4('C0001'))) },
    { folderPath: c2, materials: mp.parseMediapro(xml(m4('C0001'))) },
  ])
  assert.equal(r.missing.length, 4)
  assert.ok(r.missing.every(x => x.card === c2.join('/')))
})

test('0 ไบต์ / ขนาดต่อเฟรมต่ำกว่าครึ่งของคลิปแบบเดียวกัน (ก็อปไม่จบ) → ไม่ผ่าน · สำเนาที่ใหญ่สุดคือตัวที่นับ', () => {
  const root = ['EP.2', 'CAM-A', 'XDROOT']
  const clips = ['A004R001_260911TJ', 'A004R002_260911AA', 'A004R003_260911BB', 'A004R004_260911CC']
  const files = [
    ...card(root, clips[0], 2_060), ...card(root, clips[1], 10_000), ...card(root, clips[2], 9_900), ...card(root, clips[3], 0),
    f([...root, 'Clip (old)'], `${clips[1]}.MXF`, 50), // smaller copy elsewhere — the full one counts
  ]
  const r = mp.mediaproCheck(files, [{ folderPath: root, materials: mp.parseMediapro(xml(...clips.map(c => material(c, 10)))) }])
  assert.deepEqual(r.zero.map(z => z.file), [`Clip/${clips[3]}.MXF`])
  assert.deepEqual(r.suspect.map(s => [s.file, s.ratio]), [[`Clip/${clips[0]}.MXF`, 0.21]])
  assert.equal(mp.mediaproComplete(r), false)
})

test('การ์ด Sony ที่ไม่มี MEDIAPRO = ตรวจไม่ได้ (XDROOT · M4ROOT · การ์ดก็อปแบบแบน) · กล้องอื่นไม่มีอะไรให้เทียบ = ผ่าน', () => {
  const files = [
    f(['EP.4', 'CAM-C', 'C024', 'XDROOT', 'Clip'], 'C024C001_260930AA.MXF'),
    f(['EP01', 'CAM-A', 'private', 'M4ROOT', 'CLIP'], 'C0001.MP4'),
    f(['EP01', 'CAM-B', 'Clip'], 'B001C001_260930ZZ.MXF'),
    f(['EP01', 'CAM-D', 'DCIM', '100GOPRO'], 'GX010001.MP4'),
    f(['EP01', 'CAM-E', 'Clip'], 'IMG_0001.MOV'),
    f(['_แยกไว้ · ไฟล์อัปไม่จบ', 'XDROOT', 'Clip'], 'A004R001_260911TJ.MXF'),
  ]
  const r = mp.mediaproCheck(files, [])
  assert.deepEqual(r.unverifiable.sort(), ['EP.4/CAM-C/C024/XDROOT', 'EP01/CAM-A/private/M4ROOT', 'EP01/CAM-B'].sort())
  assert.equal(mp.mediaproComplete(mp.mediaproCheck([f(['EP01', 'CAM-D', 'DCIM'], 'GX010001.MP4')], [])), true)
})

test('ชื่อ "Copy of …" ที่ Drive ตั้งตอนทำสำเนา = ไฟล์เดิม (ทั้ง MEDIAPRO.XML และไฟล์คลิป)', () => {
  const root = ['EP.1', 'CAM-A', 'XDROOT']
  const files = card(root, 'A001C001_260901AA').map((x: any) => x.name.endsWith('S03.MP4') ? { ...x, name: `Copy of ${x.name}` } : x)
  assert.equal(mp.isMediaproFile('Copy of MEDIAPRO.XML'), true)
  assert.equal(mp.mediaproComplete(mp.mediaproCheck(files, [{ folderPath: root, materials: mp.parseMediapro(xml(material('A001C001_260901AA'))) }])), true)
})

test('mediaproGate: ครบ → ok · ขาด → ไม่ ok พร้อมเหตุผล · อ่าน Drive/XML ไม่ได้ / ไฟล์เกินเพดาน / ไม่มีโฟลเดอร์ → ไม่ ok (ห้ามถือว่าครบ)', async () => {
  const root = ['EP.1', 'CAM-A', 'XDROOT']
  const mpFile = f(root, 'MEDIAPRO.XML', 500)
  const dupe = { ...f(['EP.1', 'CAM-A', 'XDROOT (1)'], 'MEDIAPRO.XML', 500), md5: mpFile.md5 }
  xmls[mpFile.id] = xml(material('A001C001_260901AA'))
  trees.box = [...card(root, 'A001C001_260901AA'), mpFile, dupe]
  const ok = await mp.mediaproGate(['box'])
  assert.equal(ok.ok, true)
  assert.match(ok.text, /ครบตาม MEDIAPRO 2 การ์ด · 4 ไฟล์/)
  assert.deepEqual(downloads, [mpFile.id], 'สำเนา md5 เดียวกันโหลดครั้งเดียว')

  trees.box = [...card(root, 'A001C001_260901AA', 1, { skip: ['.MXF'] }), mpFile]
  const short = await mp.mediaproGate(['box'])
  assert.equal(short.ok, false)
  assert.match(short.text, /ขาด 1 ไฟล์ตาม MEDIAPRO/)

  const broken = f(root, 'MEDIAPRO.XML', 500)
  trees.box = [...card(root, 'A001C001_260901AA'), broken]
  assert.match((await mp.mediaproGate(['box'])).text, /ตรวจ MEDIAPRO ไม่ได้: Drive 500/)
  trees.box = new Error('rateLimitExceeded')
  assert.equal((await mp.mediaproGate(['box'])).ok, false)
  trees.box = Array.from({ length: 20000 }, (_, i) => f(['EP.1'], `x${i}.MOV`))
  assert.match((await mp.mediaproGate(['box'])).text, /เกิน 20000/)
  assert.equal((await mp.mediaproGate([])).ok, false)
})

test('รีวิว: การ์ดเดียวที่ถูกแยกคลิปไปหลาย EP (AGN-260911-01 · A004 R001 ใน EP.2, R002 ใน EP.3 · MEDIAPRO ชุดเดียวกันทั้งสอง EP) → ครบ · ลบ R002 → ขาดไฟล์นั้น', () => {
  const ep2 = ['EP.2', 'CAM-A'], ep3 = ['EP.3', 'CAM-A']
  const m = mp.parseMediapro(xml(material('A004R001_260911TJ'), material('A004R002_260911AA')))
  const cards = [{ folderPath: ep2, materials: m }, { folderPath: ep3, materials: m }]
  const files = [...card(ep2, 'A004R001_260911TJ'), ...card(ep3, 'A004R002_260911AA')]
  const ok = mp.mediaproCheck(files, cards)
  assert.equal(mp.mediaproComplete(ok), true, JSON.stringify(ok.missing))
  assert.equal(ok.listed, 8)
  const short = mp.mediaproCheck(files.filter((x: any) => x.name !== 'A004R002_260911AA.MXF'), cards)
  assert.deepEqual(short.missing.map(x => x.file), ['Clip/A004R002_260911AA.MXF'])
})

test('รีวิว: ต้นฉบับ Sony ที่ไม่มี MEDIAPRO ใบไหนระบุ (โฟลเดอร์ "Clip (1) (1)" · MXF ลอยใน CAM-B · การ์ดที่ MEDIAPRO ถูกแทนด้วยของอีกใบ) = ตรวจไม่ได้', () => {
  const root = ['EP.4', 'CAM-A', 'A024']
  const cards = [{ folderPath: root, materials: mp.parseMediapro(xml(material('A024C001_260930F3'))) }]
  const files = [
    ...card(root, 'A024C001_260930F3'),
    f([...root, 'Clip (1) (1)'], 'A024C002_260930XX.MXF'),         // a clip of a merged card the MEDIAPRO does not list
    f(['EP.4', 'CAM-B'], 'B026C001_260930D6.MXF'),                   // loose MXF, no card folder at all
    f(['EP.4', 'CAM-B', 'B026', 'Clip (1) (1)'], 'B026C002_260930D7.MXF'),
  ]
  const r = mp.mediaproCheck(files, cards)
  assert.deepEqual(r.unverifiable.sort(), ['EP.4/CAM-A/A024/Clip (1) (1)', 'EP.4/CAM-B', 'EP.4/CAM-B/B026/Clip (1) (1)'].sort())
  assert.equal(mp.mediaproComplete(r), false)
  assert.match(mp.mediaproGapText(r), /การ์ด Sony ไม่มี MEDIAPRO\.XML 3 การ์ด/)
})

// ── v1.260 — จากการตรวจทั้งไดรฟ์ 4–6 ต.ค. 2569 (495 ใบ) ─────────────────────────

test('v1.260: ชื่อที่ Drive ต่อท้าย " (1) (1)" ตอนอัปซ้ำ = ไฟล์เดิม (AGN-260930-01 มี A025C002_260930SJ (1) (1) (1).MXF md5 เดียวกับตัวที่ถูกทิ้ง แต่ถูกรายงานว่าขาด)', () => {
  const root = ['EP.4', 'CAM-A', 'A025']
  const files = card(root, 'A025C002_260930SJ').map((x: any) => x.name === 'A025C002_260930SJ.MXF' ? { ...x, name: 'A025C002_260930SJ (1) (1) (1).MXF' } : x)
  const r = mp.mediaproCheck(files, [{ folderPath: root, materials: mp.parseMediapro(xml(material('A025C002_260930SJ'))) }])
  assert.equal(mp.mediaproComplete(r), true, JSON.stringify(r.missing))
  assert.deepEqual(r.unverifiable, [], 'ต้นฉบับชื่อ "(1)" ไม่ใช่คลิปที่ MEDIAPRO ไม่รู้จัก')
})

test('v1.260: การ์ดไม่ได้ format — คลิปวันก่อนหน้าที่ MEDIAPRO อ้างแต่ไม่ได้ก็อปมา (AGN-260713-02 "ขาด" 416 ไฟล์ของ 9 ก.ค. ที่อยู่ในกล่อง TSS-TSL-260709-03) = stale ไม่กั้น · คลิปวันถ่ายที่ขาดยังกั้น · ไม่บอกวันถ่าย = กฎเดิม · คลิปวันหลังไม่ถือเป็น stale', () => {
  const root = ['EP01', 'CAM-A', 'M4ROOT']
  const cards = [{ folderPath: root, materials: mp.parseMediapro(xml(material('B001R001_260709TQ'), material('A001R001_260713AB'))) }]
  const files = card(root, 'A001R001_260713AB')
  const r = mp.mediaproCheck(files, cards, { shootFrom: '2026-07-13' })
  assert.deepEqual(r.missing, [])
  assert.equal(r.stale.length, 4)
  assert.equal(r.stale[0].date, '2026-07-09')
  assert.equal(mp.mediaproComplete(r), true)
  assert.match(mp.mediaproStaleText(r), /ข้ามคลิปก่อนวันถ่าย 4 ไฟล์ \(2026-07-09/)
  const short = mp.mediaproCheck(files.filter((x: any) => x.name !== 'A001R001_260713AB.MXF'), cards, { shootFrom: '2026-07-13' })
  assert.deepEqual(short.missing.map(x => x.file), ['Clip/A001R001_260713AB.MXF'])
  assert.match(mp.mediaproGapText(short), /ขาด 1 ไฟล์ตาม MEDIAPRO.*ข้ามคลิปก่อนวันถ่าย 4/)
  assert.equal(mp.mediaproCheck(files, cards).missing.length, 4, 'ไม่มีวันถ่าย → ขาดเหมือนเดิม')
  const later = mp.mediaproCheck(files, [{ folderPath: root, materials: mp.parseMediapro(xml(material('A001R001_260713AB'), material('A002R001_260720ZZ'))) }], { shootFrom: '2026-07-13' })
  assert.equal(later.missing.length, 4, 'คลิปลงวันหลังวันถ่ายที่หายไป = ขาดจริง')
  assert.equal(later.stale.length, 0)
  // รีวิว: คลิปวันก่อนที่ "ก็อปมาครึ่งเดียว" (มี Sub/XML แต่ไม่มีต้นฉบับ) เป็นของกล่องนี้ → ขาด ไม่ใช่ stale
  const half = mp.mediaproCheck([...files, ...card(root, 'B001R001_260709TQ', 1, { skip: ['.MXF'] })], cards, { shootFrom: '2026-07-13' })
  assert.deepEqual(half.missing.map(x => x.file), ['Clip/B001R001_260709TQ.MXF'])
  assert.equal(half.stale.length, 0)
  // รีวิว: นาฬิกากล้องรีเซ็ต (210101) ไม่ใช่ "งานก่อน" — เก่ากว่าหนึ่งปีก่อนวันถ่าย = ไม่รู้ = ขาด
  const reset = mp.mediaproCheck(files, [{ folderPath: root, materials: mp.parseMediapro(xml(material('A003R004_210101EY'), material('A001R001_260713AB'))) }], { shootFrom: '2026-07-13' })
  assert.equal(reset.missing.length, 4)
  assert.equal(reset.stale.length, 0)
})

test('v1.260: gate ส่งวันถ่ายให้กฎ — คลิปวันก่อนบนการ์ดไม่กั้น "ไฟล์พร้อม" แต่บอกไว้ในข้อความ', async () => {
  const root = ['EP01', 'CAM-A', 'M4ROOT']
  const mpFile = f(root, 'MEDIAPRO.XML', 500)
  xmls[mpFile.id] = xml(material('B001R001_260709TQ'), material('A001R001_260713AB'))
  trees.box = [...card(root, 'A001R001_260713AB'), mpFile]
  const r = await mp.mediaproGate(['box'], { shootFrom: '2026-07-13' })
  assert.equal(r.ok, true, r.text)
  assert.match(r.text, /ครบตาม MEDIAPRO 1 การ์ด · 4 ไฟล์ · ข้ามคลิปก่อนวันถ่าย 4 ไฟล์/)
  assert.equal((await mp.mediaproGate(['box'])).ok, false, 'ไม่บอกวันถ่าย = กฎเดิม')
})

test('รีวิว: gate — กล่องว่าง/อยู่ในถังขยะ (เดินได้ไฟล์ 0 หรือมีแต่ _SHOOT.txt) = ตรวจไม่ได้ ไม่ใช่ "ไม่มีการ์ด Sony"', async () => {
  trees.dead = []
  const dead = await mp.mediaproGate(['dead'])
  assert.equal(dead.ok, false)
  assert.match(dead.text, /ตรวจ MEDIAPRO ไม่ได้/)
  trees.stub = [f([], '_SHOOT.txt', 300)]
  assert.equal((await mp.mediaproGate(['stub'])).ok, false)
  trees.gopro = [f(['EP01', 'CAM-D', 'DCIM'], 'GX010001.MP4')]
  const gopro = await mp.mediaproGate(['gopro'])
  assert.equal(gopro.ok, true, 'กล้องอื่นไม่มี MEDIAPRO ให้เทียบ — ด่านนี้ไม่กั้น')
  assert.match(gopro.text, /ไม่มีการ์ด Sony/)
})
