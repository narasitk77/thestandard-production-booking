import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// maint r2 2026-11-08 (footage):
//  1. footage-integrity POST — the round-1 "mark only boxes the summary NAMED" skip must touch only `issues` boxes.
//     The summary names only live (state 'issues') boxes, so a box whose issues CLEARED (state ok, issueKey changed)
//     would sit in that skip forever if isNews ever stopped checking state → never marked, and the issue's return
//     would not be news. isNews is mocked WITHOUT the state check on purpose: the route's own guard must hold alone.
//  2. landing/manage — auth accepts ANY configured secret (internalSecretAllowed), not only the first-set one.

let marked: string[] = []
let chatOk = true
let beats: Array<[string, string]> = []
let prune: any = null

mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../footage-integrity', {
  namedExports: {
    formatRunSummary: (_s: unknown, named?: Set<string>) => { named?.add('A'); return '🎞️ summary naming A' },
    isNews: (b: any) => !b.doc.id || b.doc.announced !== b.issueKey,
  },
})
mock.module('../google-drive', { namedExports: { markFootageCheckAnnounced: async (id: string) => { marked.push(id) } } })
mock.module('../notify', {
  namedExports: {
    notifyChatDetailed: async () => ({ discord: chatOk, lark: false, any: chatOk }),
    notifyChat: async () => chatOk,
  },
})
mock.module('../ops-alert', { namedExports: { alertOps: async () => ({ attempted: true, delivered: true, discord: true, lark: false, email: false }) } })
mock.module('../heartbeat', { namedExports: { recordHeartbeat: async (k: string, n: string) => { beats.push([k, n]) } } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../email', { namedExports: { sendEmail: async () => ({}) } })
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
  // both set: the old chain compared against PREP_FOLDERS_SECRET only, so a caller holding NEXTAUTH_SECRET got 401
  process.env.PREP_FOLDERS_SECRET = 'prep-secret'
  process.env.NEXTAUTH_SECRET = 'nextauth-secret'
  ;({ POST: fiPOST } = await import('../../app/api/internal/footage-integrity/run/route'))
  ;({ GET: landingGET } = await import('../../app/api/internal/landing/manage/route'))
})
beforeEach(() => {
  marked = []; chatOk = true; beats = []
  prune = { today: '2026-11-08', trashed: 0, keptToday: 0, keptWithFiles: [], keptWithFilesDetail: [], keptManual: [], keptByName: [], keptFuture: [], keptNoFootage: [], cancelledWithFiles: [], errors: 0, actions: [] }
})

const box = (code: string, state = 'issues') => ({ bookingCode: code, state, issueKey: `k-${code}`, errors: [], doc: { id: `doc-${code}`, announced: 'old-key' } })
const fiReq = (body: unknown) => new Request('https://probook.test/api/internal/footage-integrity/run', {
  method: 'POST', headers: { 'x-footage-integrity-secret': 'fi-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
}) as any

test('r2: footage-integrity — กล่องที่ปัญหาหายแล้ว (state ok · issueKey เปลี่ยน) ถูกมาร์ก announced หลังส่งถึงแชต', async () => {
  const body: any = await (await fiPOST(fiReq({ boxes: [box('A'), box('B'), box('CLR', 'ok')], docs: true }))).json()
  assert.ok(marked.includes('doc-CLR'), 'กล่องที่หายแล้วต้องถูกมาร์ก ไม่งั้นปัญหาเดิมกลับมาจะไม่เป็นข่าว')
  assert.ok(marked.includes('doc-A'), 'A ถูกเอ่ยชื่อ = แจ้งแล้ว')
  assert.ok(!marked.includes('doc-B'), 'B ถูกตัด = ยังไม่ได้แจ้ง')
  assert.equal(body.unnamed, 1, 'นับเฉพาะกล่อง issues ที่ไม่ถูกเอ่ยชื่อ')
  assert.match(beats[0][1], /unnamed=1/)
})

test('r2: footage-integrity — กล่องที่หายแล้วถูกมาร์กแม้แชตส่งไม่ถึง (ไม่มีอะไรต้องส่ง) · ข่าวไม่ถูกมาร์ก', async () => {
  chatOk = false
  const body: any = await (await fiPOST(fiReq({ boxes: [box('A'), box('CLR', 'ok')], docs: true }))).json()
  assert.deepEqual(marked, ['doc-CLR'])
  assert.equal(body.unnamed, 0)
})

const landingReq = (headers: Record<string, string>) =>
  new Request('https://probook.test/api/internal/landing/manage?prune=today&dryRun=1', { headers }) as any

test('r2: landing/manage — รับ secret ไหนก็ได้ที่ตั้งไว้ (ไม่ใช่แค่ตัวแรกใน chain) · ทั้งสอง header + Bearer', async () => {
  for (const headers of <Array<Record<string, string>>>[
    { 'x-reconcile-secret': 'prep-secret' },
    { 'x-reconcile-secret': 'nextauth-secret' },
    { 'x-prep-folders-secret': 'nextauth-secret' },
    { authorization: 'Bearer prep-secret' },
  ]) {
    const res = await landingGET(landingReq(headers))
    assert.equal(res.status, 200, JSON.stringify(headers))
  }
})

test('r2: landing/manage — secret ผิด / ไม่มี secret และไม่มี session = 401', async () => {
  assert.equal((await landingGET(landingReq({ 'x-reconcile-secret': 'wrong' }))).status, 401)
  assert.equal((await landingGET(landingReq({}))).status, 401)
})
