import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findIssues } from '../footage-integrity'

function f(over: any = {}) {
  return {
    id: over.id || 'id1', name: over.name || 'A.MXF',
    mimeType: over.mimeType ?? 'application/octet-stream',
    parents: over.parents || ['p1'], webViewLink: null,
    size: over.size === undefined ? 100 : over.size,
    createdTime: null, modifiedTime: null,
    folderPath: over.folderPath || ['EP01', 'CAM-A', 'Clip'],
    topFolderId: null,
  } as any
}

test('a truncated upload is reported', () => {
  const issues = findIssues('X-1', [f({ size: 0 })])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'zero-byte')
})

test('SONYCARD.IND at 0 bytes is NORMAL — every Sony card ships one', () => {
  // Regression for v1.221.1. v1.221 would have fired on every Sony shoot,
  // and an alert that cries wolf on normal footage gets ignored on the day
  // it finally matters.
  const issues = findIssues('X-1', [f({ name: 'SONYCARD.IND', size: 0, folderPath: ['EP01', 'CAM-A', 'SONY'] })])
  assert.deepEqual(issues, [])
})

test('the sidecar exemption is case-insensitive and does not leak to other names', () => {
  assert.deepEqual(findIssues('X', [f({ name: 'sonycard.ind', size: 0 })]), [])
  assert.equal(findIssues('X', [f({ name: 'SONYCARD.MXF', size: 0 })]).length, 1)
})

test('two files sharing one name in one folder is reported with both sizes', () => {
  const issues = findIssues('X-1', [
    f({ id: 'a', name: 'A.MXF', size: 9_873_129_472, parents: ['same'] }),
    f({ id: 'b', name: 'A.MXF', size: 47_908_238_384, parents: ['same'] }),
  ])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'duplicate-name')
  assert.equal(issues[0].fileIds.length, 2)
})

test('same name in DIFFERENT folders is normal — cameras reuse filenames', () => {
  const issues = findIssues('X-1', [
    f({ id: 'a', name: 'A.MXF', parents: ['camA'] }),
    f({ id: 'b', name: 'A.MXF', parents: ['camB'] }),
  ])
  assert.deepEqual(issues, [])
})

test('an episode with sound but no picture is reported', () => {
  const issues = findIssues('X-1', [f({ name: 'REC-001.WAV', folderPath: ['EP01', 'AUDIO'] })])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'audio-without-video')
})

test('sound AND picture together is fine', () => {
  const issues = findIssues('X-1', [
    f({ name: 'REC-001.WAV', folderPath: ['EP01', 'AUDIO'] }),
    f({ name: 'A.MXF', folderPath: ['EP01', 'CAM-A', 'Clip'] }),
  ])
  assert.deepEqual(issues, [])
})

// ── v1.253 — ตรวจรายวัน (ฟังก์ชันบริสุทธิ์) ─────────────────────────────────────
import { strandedFiles, boxState, renderCheckDoc, formatRunSummary, groupRows, issueKey, type BoxCheck } from '../footage-integrity'

test('v1.253: Sub + XML ไม่มีต้นฉบับ → missing-original (fileIds = Sub/XML) · ต้นฉบับไม่มี XML → missing-sidecar', () => {
  const issues = findIssues('AGN-260929-01', [
    f({ id: 's', name: 'B022C001_2609297HS03.MP4', folderPath: ['EP.1', 'CAM-B', 'XDROOT', 'Sub'] }),
    f({ id: 'x', name: 'B022C001_2609297HM01.XML', folderPath: ['EP.1', 'CAM-B', 'XDROOT', 'Clip'] }),
    f({ id: 'o', name: 'A022C001_260929AA.MXF', folderPath: ['EP.1', 'CAM-A', 'XDROOT', 'Clip'] }),
  ])
  assert.deepEqual(issues.map(i => [i.kind, i.fileIds]), [['missing-original', ['s', 'x']], ['missing-sidecar', ['o']]])
})

test('v1.253: ต้นฉบับ FX6 ชื่อเดียวกันสองโฟลเดอร์ ขนาดต่างกัน → ชื่อซ้ำ · ขนาดเท่ากัน (การ์ดคัดลอกซ้ำ) ไม่ติด · _แยกไว้ ไม่นับ', () => {
  const clip = (id: string, parent: string, size: number, top = 'EP.2') =>
    f({ id, name: 'A004R001_260911TJ.MXF', parents: [parent], size, folderPath: [top, 'CAM-A', 'Clip'] })
  const xml = f({ id: 'xml', name: 'A004R001_260911TJM01.XML', folderPath: ['EP.2', 'CAM-A', 'Clip'] })
  assert.deepEqual(findIssues('X', [clip('a', 'p1', 9_870_000_000), clip('b', 'p2', 47_910_000_000), xml]).map(i => i.kind), ['duplicate-name'])
  assert.deepEqual(findIssues('X', [clip('a', 'p1', 47_910_000_000), clip('b', 'p2', 47_910_000_000), xml]), [])
  assert.deepEqual(findIssues('X', [clip('a', 'q', 9_870_000_000, '_แยกไว้ · ไฟล์อัปไม่จบ (ย้ายออก 2026-09-30)'), clip('b', 'p2', 47_910_000_000), xml]), [])
})

test('v1.253: ไฟล์ในโฟลเดอร์ drop ที่ถูกทิ้ง — md5 ตรงกับกล่อง = อยู่แล้ว · name+size ใช้เมื่อฝั่งใดไม่มี md5 · md5 ต่าง = ค้าง', () => {
  const t = (name: string, size: number, md5: string | null) => ({ id: name, name, size, md5, folderPath: ['EP.1', 'CAM-B'], webViewLink: null })
  const box = [f({ name: 'IN-BOX.MXF', size: 5, md5: 'aaa' } as any), f({ name: 'NOMD5.MXF', size: 7 } as any)]
  box[0].md5 = 'aaa'; box[1].md5 = null
  const lost = strandedFiles([
    t('moved-and-renamed.MXF', 5, 'aaa'),      // md5 อยู่ในกล่อง
    t('NOMD5.MXF', 7, 'zzz'),                  // กล่องไม่มี md5 → name+size
    t('IN-BOX.MXF', 5, 'bbb'),                 // ชื่อ+ขนาดตรง แต่เนื้อคนละไฟล์ (TSS-WYS-260824-01)
    t('B022C001_2609297H.MXF', 144e9, 'ccc'),  // ไม่มีในกล่อง
    t('SALVAGE.TMP', 10, null), t('.DS_Store', 10, null), t('._A.MXF', 10, null), t('EMPTY.MXF', 0, null), t('_SHOOT.txt', 10, null),
  ], box)
  assert.deepEqual(lost.map(l => l.name), ['IN-BOX.MXF', 'B022C001_2609297H.MXF'])
})

test('v1.253: สถานะกล่อง — ตรวจไม่ได้ห้ามเป็นครบ · รอต้นฉบับเฉพาะช่วงผ่อนผัน · ไม่ใช่ Sony ห้ามเป็นครบ', () => {
  const sony = [f({ name: 'A001C001_260901AA.MXF' })]
  const orig = [{ bookingCode: 'X', kind: 'missing-original' as const, detail: '', fileIds: [] }]
  assert.equal(boxState({ readable: false, files: sony, issues: [], waiting: false }), 'unreadable')
  assert.equal(boxState({ readable: true, files: sony, issues: orig, waiting: true }), 'waiting')
  assert.equal(boxState({ readable: true, files: sony, issues: orig, waiting: false }), 'issues')
  assert.equal(boxState({ readable: true, files: [f({ name: 'IMG_0001.MOV' })], issues: [], waiting: false }), 'no-sony')
  assert.equal(boxState({ readable: true, files: [f({ name: '_SHOOT.txt' })], issues: [], waiting: false }), 'empty')
  assert.equal(boxState({ readable: true, files: sony, issues: [], waiting: false }), 'ok')
})

function doc(over: Partial<Parameters<typeof renderCheckDoc>[0]> = {}) {
  return {
    bookingCode: 'AGN-260929-01', projectId: 'PP-26-034', projectName: 'GDH <x> & 8 Minute', shootDate: '2026-09-29',
    state: 'ok' as const, waiting: false, files: 3, bytes: 3e9, issues: [], rows: [], stranded: null, mediaPool: null, errors: [],
    ...over,
  }
}

test('v1.253: เอกสาร — hash ไม่เปลี่ยนเมื่อเปลี่ยนแค่เวลาตรวจ · เปลี่ยนเมื่อผลเปลี่ยน · escape ชื่อ', () => {
  const a = renderCheckDoc(doc(), { checkedAt: new Date('2026-09-30T06:00:00Z'), appUrl: 'https://p' })
  const b = renderCheckDoc(doc(), { checkedAt: new Date('2026-10-01T06:00:00Z'), appUrl: 'https://p' })
  const c = renderCheckDoc(doc({ state: 'issues', issues: [{ bookingCode: 'AGN-260929-01', kind: 'missing-original', detail: 'B022C001_2609297H', fileIds: ['f1'] }] }),
    { checkedAt: new Date('2026-09-30T06:00:00Z'), appUrl: 'https://p' })
  assert.equal(a.hash, b.hash)
  assert.notEqual(a.html, b.html)
  assert.notEqual(a.hash, c.hash)
  assert.ok(a.html.includes('GDH &lt;x&gt; &amp; 8 Minute'))
  assert.ok(!a.html.includes('<x>'))
  assert.ok(c.html.includes('https://drive.google.com/open?id=f1'))
})

test('v1.253: เอกสาร — Media Pool ที่ไม่มี .drp ต้องบอกว่า "ไม่ได้เทียบ" ไม่ใช่ซิงก์ครบ', () => {
  const r = renderCheckDoc(doc({ mediaPool: { drp: null, status: 'no-drp', inPool: 0, missing: 0, notInPool: [] } }), { checkedAt: new Date(), appUrl: 'https://p' })
  assert.ok(r.html.includes('ไม่ได้เทียบ (ไม่ได้แปลว่าซิงก์ครบ)'))
  assert.ok(!r.html.includes('ซิงก์ครบ 0'))
})

test('v1.253: groupRows ผูกปัญหากับ EP/กล้องผ่าน fileIds', () => {
  const rows = groupRows([
    f({ id: 'a', name: 'A001C001_260901AA.MXF', folderPath: ['EP.1', 'CAM-A', 'XDROOT', 'Clip'], size: 10 }),
    f({ id: 'w', name: 'REC.WAV', folderPath: ['EP.1', 'AUDIO'], size: 5 }),
  ], [{ bookingCode: 'X', kind: 'missing-sidecar', detail: '', fileIds: ['a'] }])
  assert.deepEqual(rows.map(r => [r.ep, r.cam, r.files, r.sony, r.audio, r.kinds]), [
    ['EP.1', 'AUDIO', 1, false, true, []],
    ['EP.1', 'CAM-A', 1, true, false, ['missing-sidecar']],
  ])
})

function box(over: Partial<BoxCheck> = {}): BoxCheck {
  return {
    bookingCode: 'AGN-1', projectId: null, shootDate: '2026-09-20', boxId: 'b', state: 'ok', waiting: false,
    files: 1, bytes: 1, counts: {}, issues: [], stranded: null, mediaPool: null, issueKey: 'k0',
    doc: { action: 'unchanged', url: null, id: 'd', announced: 'k0' }, errors: [], notes: [], ...over,
  }
}

test('v1.253: สรุปแชต — ข่าว = ปัญหาที่ยังไม่เคยส่งถึงแชต (ไม่ใช่ "เอกสารถูกเขียนใหม่")', () => {
  const issue = { bookingCode: 'AGN-1', kind: 'zero-byte' as const, detail: 'x', fileIds: [] }
  const announced = box({ state: 'issues', counts: { 'zero-byte': 1 }, issues: [issue], issueKey: 'k1', doc: { action: 'updated', url: null, id: 'd', announced: 'k1' } })
  assert.equal(formatRunSummary({ boxes: [box(), announced], docs: true }), '', 'ส่งไปแล้ว + เอกสารแค่ถูกเขียนใหม่ (.drp ใหม่) = ไม่ต้องพูดซ้ำ')

  const unsent = box({ ...announced, doc: { action: 'unchanged', url: null, id: 'd', announced: 'k0' } })
  assert.match(formatRunSummary({ boxes: [unsent], docs: true }), /• AGN-1 — 0 ไบต์ 1/, 'เอกสารเขียนแล้วแต่แชตเมื่อวานส่งไม่ถึง → ยังเป็นข่าว')

  const s = formatRunSummary({ boxes: [box(), announced, box({ bookingCode: 'AGN-2', state: 'issues', stranded: { files: 2, bytes: 288e9, purgeAfter: '2026-10-29T05:00:00Z' } })], docs: true })
  assert.match(s, /🚨 ไฟล์ค้างในถังขยะ/)
  assert.match(s, /AGN-2 — 2 ไฟล์ 288\.00 GB/)
  assert.doesNotMatch(s, /• AGN-1 —/)
})

test('v1.253: issueKey ไม่นับปัญหาช่วงรอต้นฉบับ และไม่ขึ้นกับลำดับ', () => {
  const a = { bookingCode: 'X', kind: 'zero-byte' as const, detail: 'a', fileIds: [] }
  const b = { bookingCode: 'X', kind: 'duplicate-name' as const, detail: 'b', fileIds: [] }
  const w = { bookingCode: 'X', kind: 'missing-original' as const, detail: 'w', fileIds: [] }
  assert.equal(issueKey([a, b], false), issueKey([b, a], false))
  assert.equal(issueKey([a, w], true), issueKey([a], true))
  assert.notEqual(issueKey([a, w], false), issueKey([a], false))
})

test('v1.253: สรุปแชต — ปัญหาในช่วงผ่อนผันไม่ขึ้น · รอบไม่ครบต้องบอก · docs ปิดบอก would-* · ไม่มีกล่องผูกต้องบอก', () => {
  const w = box({ state: 'waiting', waiting: true, counts: { 'missing-original': 1 }, doc: { action: 'would-create', url: null } })
  assert.equal(formatRunSummary({ boxes: [w], docs: false }), '')
  const s = formatRunSummary({ boxes: [w, box({ doc: { action: 'would-create', url: null } })], docs: false, failure: 'หน้า offset=50 ล้ม', noBox: 2, noBoxCodes: ['AGN-9'] })
  assert.match(s, /รอบนี้ตรวจไม่ครบ: หน้า offset=50 ล้ม/)
  assert.match(s, /ยังไม่เปิดเขียน \(จะสร้าง 2/)
  assert.match(s, /ไม่มีกล่องผูก 2 ใบ \(ไม่ได้ตรวจ: AGN-9\)/)
})

test('v1.253: สรุปแชตไม่เกินงบ Discord (1990) และบรรทัดระดับรอบ + คำเตือนรอดเสมอ', () => {
  const many = Array.from({ length: 40 }, (_, i) => box({
    bookingCode: `AGN-2609${String(i).padStart(2, '0')}-01`, state: 'issues', counts: { 'missing-sidecar': 12 }, issueKey: `n${i}`,
    issues: Array.from({ length: 5 }, (_, j) => ({ bookingCode: 'x', kind: 'missing-sidecar' as const, detail: `EP.${j}/CAM-A · A00${j}C001_2609${i}AA — มีต้นฉบับ แต่ขาด M01.XML`.repeat(2), fileIds: [] })),
    doc: { action: 'created', url: 'https://docs.google.com/document/d/abcdefghijklmnopqrstuvwxyz0123456789/edit', id: 'd', announced: null },
  }))
  const stranded = Array.from({ length: 15 }, (_, i) => box({ bookingCode: `S-${i}`, state: 'issues', stranded: { files: 3, bytes: 3e11, purgeAfter: null } }))
  const s = formatRunSummary({ boxes: [...stranded, ...many, box({ state: 'unreadable', errors: ['Drive 500'] })], docs: true, failure: 'หน้า offset=120 ล้ม' })
  assert.ok(s.length <= 1990, `ยาว ${s.length}`)
  for (const must of ['รอบนี้ตรวจไม่ครบ', 'อ่านกล่องไม่ได้ 1 ใบ', 'อย่าเพิ่งลบ', '🚨', '…อีก']) assert.ok(s.includes(must), must)
})

test('v1.253 รีวิว: Sub วางแบนไม่มีโครงการ์ด → ขาดต้นฉบับ (ไม่ใช่ "ครบ")', () => {
  const files = [
    f({ id: 's1', name: 'B022C001_2609297HS03.MP4', folderPath: ['EP.1', 'CAM-A'] }),
    f({ id: 's2', name: 'B022C002_2609297HS03.MP4', folderPath: ['EP.1', 'CAM-A', 'Proxy'] }),
  ]
  const issues = findIssues('X', files)
  assert.deepEqual(issues.map(i => [i.kind, i.fileIds]), [['missing-original', ['s1']], ['missing-original', ['s2']]])
  assert.equal(boxState({ readable: true, files, issues, waiting: false }), 'issues')
})

test('v1.253 รีวิว: C0001 การ์ด A ครบ การ์ด B ขาดต้นฉบับ → ชี้การ์ด B อย่างเดียว', () => {
  const m4 = (cam: string, kind: 'CLIP' | 'SUB', name: string, id: string) =>
    f({ id, name, parents: [`${cam}/${kind}`], folderPath: ['EP.1', cam, 'PRIVATE', 'M4ROOT', kind] })
  const files = [
    m4('CAM-A', 'CLIP', 'C0001.MP4', 'a1'), m4('CAM-A', 'CLIP', 'C0001M01.XML', 'a2'),
    m4('CAM-B', 'CLIP', 'C0001M01.XML', 'b1'), m4('CAM-B', 'SUB', 'C0001S03.MP4', 'b2'),
  ]
  const issues = findIssues('X', files)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'missing-original')
  assert.deepEqual(issues[0].fileIds.sort(), ['b1', 'b2'])
  assert.match(issues[0].detail, /^EP\.1\/CAM-B · C0001/)
  assert.deepEqual(groupRows(files, issues).map(r => [r.cam, r.kinds]), [['CAM-A', []], ['CAM-B', ['missing-original']]])
})

test('v1.253 รีวิว: ไฟล์ในโฟลเดอร์ _แยกไว้ ไม่ขึ้นเป็นแถว "ครบ" ในเอกสาร', () => {
  const rows = groupRows([f({ name: 'A004R001_260911TJ.MXF', folderPath: ['_แยกไว้ · ไฟล์อัปไม่จบ'] })], [])
  assert.deepEqual(rows, [])
})

test('v1.253.2: hash ไม่ขึ้นกับลำดับที่ Drive คืนไฟล์ (ลำดับปัญหา / fileIds / kinds ในแถว)', () => {
  const i1 = { bookingCode: 'X', kind: 'missing-original' as const, detail: 'C022C001_260929R4', fileIds: ['b', 'a'] }
  const i2 = { bookingCode: 'X', kind: 'missing-original' as const, detail: 'B022C001_2609297H', fileIds: ['d', 'c'] }
  const row = (kinds: any[]) => ({ ep: 'EP.1', cam: 'CAM-B', files: 1, bytes: 1, audio: false, sony: true, kinds })
  const at = { checkedAt: new Date('2026-09-30T06:00:00Z'), appUrl: 'https://p' }
  const a = renderCheckDoc(doc({ state: 'issues', issues: [i1, i2], rows: [row(['zero-byte', 'missing-original'])] }), at)
  const b = renderCheckDoc(doc({ state: 'issues', issues: [{ ...i2, fileIds: ['c', 'd'] }, { ...i1, fileIds: ['a', 'b'] }], rows: [row(['missing-original', 'zero-byte'])] }), at)
  assert.equal(a.hash, b.hash)
})

test('v1.254 รีวิว: แถว EP/กล้องที่ขาดตาม MEDIAPRO (ไม่มีไฟล์ให้ชี้) ไม่ขึ้น "ครบ"', () => {
  const files = [f({ id: 'a', name: 'A024C001_261001AA.MP4', folderPath: ['EP01 · Osotspa', 'CAM-A', 'M4ROOT', 'CLIP'] })]
  const issues = [{ bookingCode: 'X', kind: 'mediapro-missing' as const, detail: 'CLIP/A024C003_261001MM.MP4', fileIds: [], group: { ep: 'EP01 · Osotspa', cam: 'CAM-A' } }]
  assert.deepEqual(groupRows(files, issues).map(r => r.kinds), [['mediapro-missing']])
})
