/**
 * maint 2026-11-08 (batch B1a-merge) — the three hourly Drive routes (video-merge / sound-merge / prep-folders):
 *
 * - the dead-man heartbeat is ticked only by the WORKER's real, whole-scope, not-skipped run. An admin click, a
 *   ?code= one-off or a skipped run (env unset / landing unreadable / no _SOUND-STAGING) used to tick it too.
 * - the card-hold chat fingerprint is written by the route only after notifyChat delivered (a failed post retries).
 * - the "already running" guard is a run guard that expires (merge-lock.ts runGuard), not a boolean.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let session: any = null
let vmResult: any, smResult: any, prepResult: any
let vmGate: Promise<void> | null = null
let chatOk = true
const ticks: string[] = []
const chats: string[] = []
const posted: string[][] = []

mock.module('../session', { namedExports: { getSession: async () => session } })
mock.module('../heartbeat', { namedExports: { recordHeartbeat: async (k: string) => { ticks.push(k) } } })
mock.module('../notify', { namedExports: { notifyChat: async (t: string) => { chats.push(t); return chatOk } } })
mock.module('../video-merge', {
  namedExports: {
    runVideoMerge: async (o: any) => { if (vmGate && !o?.dryRun) await vmGate; return vmResult },
    rememberCardHoldsPosted: async (h: string[]) => { posted.push(h) },
  },
})
mock.module('../sound-merge', { namedExports: { runSoundMerge: async () => smResult } })
mock.module('../prep-folders', { namedExports: { prepTodayShootFolders: async () => prepResult } })

type GET = (r: any) => Promise<Response>
let video: GET, sound: GET, prep: GET
before(async () => {
  process.env.VIDEO_MERGE_SECRET = 'vm-secret'
  process.env.SOUND_MERGE_SECRET = 'sm-secret'
  process.env.PREP_FOLDERS_SECRET = 'pf-secret'
  ;({ GET: video } = await import('../../app/api/internal/video-merge/run/route'))
  ;({ GET: sound } = await import('../../app/api/internal/sound-merge/run/route'))
  ;({ GET: prep } = await import('../../app/api/internal/prep-folders/run/route'))
})

const okVideo = (over: any = {}) => ({ skipped: false, dryRun: false, bookings: 3, landed: 0, moved: 0, movedFolders: 0, errors: 0, cardHolds: [], cardHoldsChatDue: false, results: [], ...over })
beforeEach(() => {
  session = null; vmGate = null; chatOk = true
  ticks.length = 0; chats.length = 0; posted.length = 0
  vmResult = okVideo(); smResult = { skipped: false, bookings: 1, staged: 0, merged: 0, errors: 0, results: [] }
  prepResult = { skipped: false, dryRun: false, total: 1, prepared: 1, errors: 0, prodTeamErrors: 0, results: [] }
})

const worker = (path: string, header: string, secret: string) =>
  new Request(`https://probook.test/api/internal/${path}`, { headers: { [header]: secret } }) as any
const admin = (path: string) => { session = { role: 'ADMIN', email: 'nat@x.co' }; return new Request(`https://probook.test/api/internal/${path}`) as any }
const vw = (qs = '') => worker(`video-merge/run${qs}`, 'x-video-merge-secret', 'vm-secret')
const quiet = () => mock.method(console, 'error', () => {})

// ── video-merge ──────────────────────────────────────────────────────────────

test('video-merge: the worker run that posted the hold list records it — after delivery, and only then', async () => {
  const holds = ['AGN-261104-01: EP01 · x/CAM-A']
  vmResult = okVideo({ cardHolds: holds, cardHoldsChatDue: true })
  assert.equal((await video(vw('?notify=1'))).status, 200)
  assert.equal(chats.length, 1)
  assert.match(chats[0], /ค้าง 1 การ์ด/)
  assert.deepEqual(posted, [holds])
  assert.deepEqual(ticks, ['video-merge'])
})

test('video-merge: a chat post that reached no channel records nothing (retried next run) and is logged as an error', async () => {
  vmResult = okVideo({ cardHolds: ['X: CAM-A'], cardHoldsChatDue: true })
  chatOk = false
  const errors = quiet()
  try {
    assert.equal((await video(vw('?notify=1'))).status, 200)
    assert.deepEqual(posted, [], 'pre-fix: the set was stamped before the post and the post result thrown away')
    assert.ok(errors.mock.calls.some(c => /ส่งไม่ถึง/.test(String(c.arguments[0]))))
  } finally { errors.mock.restore() }
})

test('video-merge: a hold the team already has does not post; a run without ?notify=1 never posts or records', async () => {
  vmResult = okVideo({ cardHolds: ['X: CAM-A'], cardHoldsChatDue: false })
  await video(vw('?notify=1'))
  assert.deepEqual(chats, [])
  vmResult = okVideo({ cardHolds: ['X: CAM-A'], cardHoldsChatDue: true })
  await video(vw())
  assert.deepEqual(chats, [])
  assert.deepEqual(posted, [])
})

test('video-merge: heartbeat only for the worker\'s whole, real, not-skipped run', async () => {
  await video(admin('video-merge/run'))
  assert.deepEqual(ticks, [], 'an admin click must not stand in for a dead worker')
  session = null
  await video(vw('?code=NWS-X-261108-01'))
  assert.deepEqual(ticks, [], 'a one-booking run is not the scheduled sweep')
  await video(vw('?dryRun=1'))
  assert.deepEqual(ticks, [])
  vmResult = okVideo({ skipped: true, reason: 'Production Team landing inaccessible (Drive says: dead)' })
  const errors = quiet()
  try {
    await video(vw('?notify=1'))
    assert.deepEqual(ticks, [], 'a skipped run merged nothing')
    assert.ok(errors.mock.calls.some(c => /run failed: skipped/.test(String(c.arguments[0]))))
  } finally { errors.mock.restore() }
  vmResult = okVideo()
  await video(vw('?notify=1'))
  assert.deepEqual(ticks, ['video-merge'])
})

test('video-merge: a second real run while one is live → 409; once it ends the next one runs', async () => {
  let release!: () => void
  vmGate = new Promise<void>(r => { release = r })
  const first = video(vw())
  await new Promise(r => setImmediate(r))
  assert.equal((await video(vw())).status, 409)
  assert.equal((await video(vw('?dryRun=1'))).status, 200, 'dryRun is never gated')
  release(); assert.equal((await first).status, 200)
  vmGate = null
  assert.equal((await video(vw())).status, 200)
})

// ── sound-merge ──────────────────────────────────────────────────────────────

test('sound-merge: heartbeat only for the worker\'s whole, real, not-skipped run', async () => {
  const sw = (qs = '') => worker(`sound-merge/run${qs}`, 'x-sound-merge-secret', 'sm-secret')
  await sound(admin('sound-merge/run'))
  session = null
  await sound(sw('?code=NWS-X-261108-01'))
  smResult = { skipped: true, reason: 'no _SOUND-STAGING tree yet', bookings: 0, staged: 0, merged: 0, errors: 0, results: [] }
  const errors = quiet()
  try { await sound(sw()) } finally { errors.mock.restore() }
  assert.deepEqual(ticks, [])
  smResult = { skipped: false, bookings: 1, staged: 0, merged: 0, errors: 0, results: [] }
  await sound(sw())
  assert.deepEqual(ticks, ['sound-merge'])
})

// ── prep-folders ─────────────────────────────────────────────────────────────

test('prep-folders: heartbeat only for the worker\'s real, not-skipped run', async () => {
  const pw = () => worker('prep-folders/run', 'x-prep-folders-secret', 'pf-secret')
  await prep(admin('prep-folders/run'))
  session = null
  prepResult = { skipped: true, reason: 'DRIVE_FOOTAGE_ROOT unset or no Drive credentials', dryRun: false, total: 0, prepared: 0, errors: 0, prodTeamErrors: 0, results: [] }
  const errors = quiet()
  try { await prep(pw()) } finally { errors.mock.restore() }
  assert.deepEqual(ticks, [])
  prepResult = { skipped: false, dryRun: false, total: 1, prepared: 1, errors: 0, prodTeamErrors: 0, results: [] }
  assert.equal((await prep(pw())).status, 200)
  assert.deepEqual(ticks, ['prep-folders'])
})
