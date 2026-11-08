import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// maint 2026-11-08 (B1b) — two routes that said "told" without knowing:
//  1. footage-integrity POST marked EVERY news box announced once a channel took the summary, though the 1,900-char
//     budget had cut some to "…อีก N ใบ" with no code → those became "ค้างเดิม" (a number) and were never named.
//  2. landing ?prune=today sent 🚨 "ถ่ายแล้วแต่ฟุตเทจในกล่องยังไม่ครบ" through notifyChat only and dropped the result:
//     no ops alert, no audit row (the condition ignored keptNoFootage) — a dead webhook = no trace at all.

let marked: string[] = []
let chatOk = true
let alerts: Array<{ key: string; text: string }> = []
let audits: any[] = []
let beats: Array<[string, string]> = []
let prune: any = null

mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../footage-integrity', {
  namedExports: {
    // the real budget logic is tested in footage-integrity.test.ts; here: the summary names A only
    formatRunSummary: (_s: unknown, named?: Set<string>) => { named?.add('A'); return '🎞️ summary naming A' },
    isNews: (b: any) => b.state === 'issues' && b.doc.announced !== b.issueKey,
  },
})
mock.module('../google-drive', { namedExports: { markFootageCheckAnnounced: async (id: string) => { marked.push(id) } } })
mock.module('../notify', {
  namedExports: {
    notifyChatDetailed: async () => ({ discord: chatOk, lark: false, any: chatOk }),
    notifyChat: async () => chatOk,
  },
})
mock.module('../ops-alert', { namedExports: { alertOps: async (key: string, _s: string, text: string) => { alerts.push({ key, text }); return { attempted: true, delivered: true, discord: true, lark: false, email: false } } } })
mock.module('../heartbeat', { namedExports: { recordHeartbeat: async (k: string, n: string) => { beats.push([k, n]) } } })
mock.module('../audit', { namedExports: { logAudit: async (a: any) => { audits.push(a) } } })
mock.module('../email', { namedExports: { sendEmail: async () => ({}) } })
// maint r3 — landing/manage reads bookings (sound-only filter) + the last alerted no-footage set: no real DB in tests
mock.module('../db', { namedExports: { prisma: { booking: { findMany: async () => [] }, systemHeartbeat: { findUnique: async () => null, upsert: async () => ({}) } } } })
mock.module('../landing-duplicates', { namedExports: { verifyLandingDuplicates: async () => ({}), verdictLine: () => '' } })
mock.module('../landing-lifecycle', {
  namedExports: {
    pruneLandingToToday: async () => prune,
    manageLandingFolders: async () => { throw new Error('not used') },
    ensureLandingForBooking: async () => { throw new Error('not used') },
    trashCancelledBookingFolders: async () => ({ trashed: [], keptWithFiles: [], skipped: [], errors: 0, actions: [] }),
    cancelledLandingText: () => '',
  },
})

let fiPOST: (r: any) => Promise<Response>
let landingGET: (r: any) => Promise<Response>
before(async () => {
  process.env.REMINDERS_SECRET = 'fi-secret'
  process.env.PREP_FOLDERS_SECRET = 'landing-secret'
  ;({ POST: fiPOST } = await import('../../app/api/internal/footage-integrity/run/route'))
  ;({ GET: landingGET } = await import('../../app/api/internal/landing/manage/route'))
})
beforeEach(() => {
  marked = []; chatOk = true; alerts = []; audits = []; beats = []
  prune = { today: '2026-11-08', trashed: 0, keptToday: 0, keptWithFiles: [], keptWithFilesDetail: [], keptManual: [], keptByName: [], keptFuture: [], keptNoFootage: [], cancelledWithFiles: [], errors: 0, actions: [] }
})

const box = (code: string) => ({ bookingCode: code, state: 'issues', issueKey: `k-${code}`, errors: [], doc: { id: `doc-${code}`, announced: null } })
const fiReq = (body: unknown) => new Request('https://probook.test/api/internal/footage-integrity/run', {
  method: 'POST', headers: { 'x-footage-integrity-secret': 'fi-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
}) as any

test('maint: footage-integrity — มาร์ก announced เฉพาะกล่องที่ข้อความเอ่ยชื่อ · ที่ถูกตัดยังเป็นข่าวรอบหน้า', async () => {
  const res = await fiPOST(fiReq({ boxes: [box('A'), box('B'), box('C')], docs: true }))
  const body: any = await res.json()
  assert.deepEqual(marked, ['doc-A'], 'B, C ไม่ถูกเอ่ยชื่อ = ยังไม่ได้แจ้ง')
  assert.equal(body.unnamed, 2)
  assert.match(beats[0][1], /unnamed=2/)
})

test('maint: footage-integrity — แชตส่งไม่ถึง = ไม่มาร์กข่าวใดเลย (เหมือนเดิม)', async () => {
  chatOk = false
  await fiPOST(fiReq({ boxes: [box('A'), box('B')], docs: true }))
  assert.deepEqual(marked, [])
})

const landingReq = () => new Request('https://probook.test/api/internal/landing/manage?prune=today&dryRun=0', { headers: { 'x-reconcile-secret': 'landing-secret' } }) as any

test('maint: landing prune — งานที่ฟุตเทจในกล่องยังไม่ครบ → alertOps ทุกครั้ง + แถว audit (แม้ไม่มีอะไรถูกทิ้ง)', async () => {
  prune.keptNoFootage = [{ name: 'X (POD-OTH-261107-01)', code: 'POD-OTH-261107-01', reason: 'ไม่มีโฟลเดอร์ในกล่อง (ไดรฟ์ VIDEO) เลย' }]
  const res = await landingGET(landingReq())
  const body: any = await res.json()
  assert.equal(body.chatDelivered, true)
  const a = alerts.find(x => x.key === 'landing-no-footage')
  assert.ok(a, 'ops ต้องได้ยินเสมอ ไม่ใช่แค่แชตทีม')
  assert.match(a!.text, /POD-OTH-261107-01/)
  const row = audits.find(x => x.action === 'drive.prune_landing_to_today')
  assert.ok(row, 'ต้องมีร่องรอยใน audit')
  assert.equal(row.changes.keptNoFootage, 1)
  assert.deepEqual(row.changes.noFootageCodes, ['POD-OTH-261107-01'])
})

test('maint: landing prune — แชตส่งไม่ถึง → ตอบ chatDelivered=false (ไม่เงียบ) · ops ยังได้ยิน', async () => {
  chatOk = false
  prune.keptNoFootage = [{ name: 'X (C-1)', code: 'C-1', reason: 'r' }]
  const body: any = await (await landingGET(landingReq())).json()
  assert.equal(body.chatDelivered, false)
  assert.ok(alerts.some(x => x.key === 'landing-no-footage'))
})

test('maint: landing prune — ไม่มีอะไรค้าง = ไม่เตือน ไม่มีแถว (เหมือนเดิม)', async () => {
  const body: any = await (await landingGET(landingReq())).json()
  assert.equal(body.chatDelivered, null)
  assert.equal(alerts.length, 0)
  assert.equal(audits.length, 0)
})
