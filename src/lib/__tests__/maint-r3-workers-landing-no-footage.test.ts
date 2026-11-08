// maint r3 2026-11-08 — keptNoFootage ("ถ่ายแล้วแต่ฟุตเทจในกล่องยังไม่ครบ") alerted ops every noon and emailed every
// 19:00 forever for a list nobody can fix: a sound-only job's box never gets camera footage. Now the ops alert and
// the 19:00 email (a) skip bookings that expect no camera video (expectsCameraVideo), and (b) fire when a code
// appears that the last alert did not name, else repeat the same set no sooner than every 48 h — one key + one
// remembered set across both passes. The noon team-chat post is unchanged (prod behaviour).
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const H = 3_600_000
const bookings: Record<string, { bookingCode: string; cameraCount: number | null; crewRequired: string[] }> = {
  'VID-1': { bookingCode: 'VID-1', cameraCount: 2, crewRequired: ['Videographer'] },
  'VID-2': { bookingCode: 'VID-2', cameraCount: 1, crewRequired: [] },
  'SND-1': { bookingCode: 'SND-1', cameraCount: 0, crewRequired: ['Sound'] }, // sound-only: no camera video ever
}
let bookingReadFails = false
const beatsDb = new Map<string, { at: Date; note: string | null }>()
const stamps = new Map<string, number>() // alertOps' own per-key throttle, simulated
const sent: { key: string; text: string }[] = []
const chats: string[] = []
const emails: string[] = []
let prune: any = null
let sweep: any = null

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findMany: async (args: any) => {
          if (bookingReadFails) throw new Error('db down')
          return args.where.bookingCode.in.map((c: string) => bookings[c]).filter(Boolean)
        },
      },
      systemHeartbeat: {
        findUnique: async (args: any) => beatsDb.get(args.where.key) ?? null,
        upsert: async (args: any) => { beatsDb.set(args.where.key, { at: args.update.at, note: args.update.note }) },
      },
    },
  },
})
mock.module('../ops-alert', {
  namedExports: {
    alertOps: async (key: string, _s: string, text: string, everyMs = 6 * H) => {
      const last = stamps.get(key)
      if (last != null && Date.now() - last < everyMs) return { attempted: false, delivered: false, discord: false, lark: false, email: false }
      stamps.set(key, Date.now()); sent.push({ key, text })
      return { attempted: true, delivered: true, discord: true, lark: false, email: false }
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../google-drive', { namedExports: {} })
mock.module('../notify', { namedExports: { notifyChat: async (t: string) => { chats.push(t); return true } } })
mock.module('../heartbeat', { namedExports: { recordHeartbeat: async () => {} } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../email', { namedExports: { sendEmail: async (m: any) => { emails.push(m.text) } } })
mock.module('../landing-duplicates', { namedExports: { verifyLandingDuplicates: async () => ({}), verdictLine: () => '' } })
mock.module('../landing-lifecycle', {
  namedExports: {
    pruneLandingToToday: async () => prune,
    manageLandingFolders: async () => sweep,
    ensureLandingForBooking: async () => { throw new Error('not used') },
    trashCancelledBookingFolders: async () => ({ trashed: [], keptWithFiles: [], skipped: [], errors: 0, actions: [] }),
    cancelledLandingText: () => '',
  },
})

let GET: (r: any) => Promise<Response>
before(async () => {
  process.env.PREP_FOLDERS_SECRET = 'landing-secret'
  ;({ GET } = await import('../../app/api/internal/landing/manage/route'))
})
const kept = (...codes: string[]) => codes.map((code) => ({ name: `X (${code})`, code, reason: 'ไม่มีไฟล์กล้องในกล่อง' }))
const setNoon = (...codes: string[]) => {
  prune = { today: '2026-11-08', trashed: 0, keptToday: 0, keptWithFiles: [], keptWithFilesDetail: [], keptManual: [], keptByName: [], keptFuture: [], keptNoFootage: kept(...codes), cancelledWithFiles: [], errors: 0, actions: [] }
}
const setEvening = (...codes: string[]) => {
  sweep = { targetDay: '2026-11-09', targetDayEnd: '2026-11-09', createDays: 1, created: 0, removedPastEmpty: 0, keptRecent: 0, createErrors: 0, removeErrors: 0, keepPastDays: 2, keptNoFootage: kept(...codes), cancelledWithFiles: [], actions: [] }
}
const noon = () => GET(new Request('https://probook.test/api/internal/landing/manage?prune=today&dryRun=0', { headers: { 'x-reconcile-secret': 'landing-secret' } }) as any)
const evening = () => GET(new Request('https://probook.test/api/internal/landing/manage?dryRun=0', { headers: { 'x-reconcile-secret': 'landing-secret' } }) as any)

beforeEach(() => {
  beatsDb.clear(); stamps.clear(); sent.length = 0; chats.length = 0; emails.length = 0; bookingReadFails = false
})

test('sound-only jobs are left out of the ops alert; the noon team chat is unchanged', async () => {
  setNoon('VID-1', 'SND-1')
  await noon()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].key, 'landing-no-footage')
  assert.match(sent[0].text, /VID-1/)
  assert.doesNotMatch(sent[0].text, /SND-1/)
  assert.equal(chats.length, 1)
  assert.match(chats[0], /SND-1/, 'chat keeps HEAD behaviour — a decision for Nat, not changed here')
})

test('only sound-only jobs → no ops alert at all', async () => {
  setNoon('SND-1')
  await noon()
  assert.equal(sent.length, 0)
})

test('the same set is not news: next noon and the 19:00 subset stay quiet (no alert, no email)', async () => {
  setNoon('VID-1', 'VID-2')
  await noon()
  assert.equal(sent.length, 1)
  await noon() // next day, same set — inside 48 h
  setEvening('VID-1') // 19:00 list is a subset of noon's
  await evening()
  assert.equal(sent.length, 1, 'same set within 48 h = no repeat (was: every noon + every 19:00)')
  assert.equal(emails.length, 0, 'nothing else changed at 19:00 → no email for an already-alerted set')
})

test('a new code is news at once; the same set repeats after 48 h', async () => {
  setNoon('VID-1')
  await noon()
  setEvening('VID-1', 'VID-2') // VID-2 never named before
  await evening()
  assert.equal(sent.length, 2, 'a code the last alert did not name → alert now')
  assert.equal(emails.length, 1)
  assert.match(emails[0], /VID-2/)
  stamps.set('landing-no-footage', Date.now() - 49 * H)
  await evening()
  assert.equal(sent.length, 3, 'same set, 48 h later → one repeat')
})

test('booking rows unreadable → every job stays in (louder beats silent)', async () => {
  bookingReadFails = true
  const warn = console.warn
  console.warn = () => {}
  try { setNoon('SND-1'); await noon() } finally { console.warn = warn }
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /SND-1/)
})
