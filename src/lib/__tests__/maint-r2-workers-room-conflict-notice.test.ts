// 2026-11-08 maintenance round 2 — "ห้องไม่ว่าง" must reach someone.
//
// Round 1 moved CONFLICT-waiting bookings out of staleStuck into conflictWaiting,
// which left the one-time transition post in syncRoomBooking as the ONLY notice.
// That post was fire-and-forget: notifyChat's false was dropped, and a missing
// time or a describeRoomClash failure returned without posting anything. The
// status is already stamped CONFLICT by then, so the next run never retries the
// notice — a failed post meant nobody ever heard. Now: post anyway (saying what
// could not be read), and fall back to alertOps('room-conflict:<code>').
// Also: conflictWaiting + failed must show in the heartbeat note.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const posted: string[] = []
const alerts: { key: string; text: string }[] = []
const beats: { key: string; note?: string }[] = []
let chatResult: () => Promise<boolean> = async () => true
let clashes: () => Promise<any[]> = async () => []
let payloadTimes = { startDate: '2026-12-03', startTime: '09:00', endDate: '2026-12-03', endTime: '17:00' }
let currentStatus: string | null = null
let reconcileResult: any = {}

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: {
        findUnique: async () => ({
          id: 'b1', bookingCode: 'NWS-TSN-261203-01', locationId: 'tsd-studio-1', locationName: 'Studio 1',
          shootDate: new Date('2026-12-03T00:00:00Z'), shootEndDate: null, callTime: '09:00', estimatedWrap: '12:00',
          producer: 'P', producerEmail: 'p@x', createdByEmail: 'p@x', projectName: null,
          outlet: { code: 'NWS', name: 'News' }, program: { name: 'Show' }, episodes: [],
          roomBookingNo: null, roomBookingStatus: currentStatus, roomBookingError: null,
          status: 'CONFIRMED', deletedAt: null,
        }),
        update: async () => ({}),
      },
    },
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../notify', {
  namedExports: { notifyChat: async (t: string) => { posted.push(t); return chatResult() } },
})
mock.module('../ops-alert', {
  namedExports: {
    alertOps: async (key: string, _s: string, text: string) => {
      alerts.push({ key, text }); return { attempted: true, delivered: true }
    },
  },
})
mock.module('../room-booking', {
  namedExports: {
    // pure helpers — same rules as the real ones
    bangkokToUtcIso: (d: string, t: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d) && /^\d{2}:\d{2}$/.test(t) ? new Date(`${d}T${t}:00+07:00`).toISOString() : null,
    bkkTime: (iso: string | null) => (iso ? iso.slice(11, 16) : '?'),
    describeRoomClash: () => clashes(),
    roomTargetForBooking: () => ({ roomId: 1, startAt: 'x', endAt: 'y' }),
    roomIdForLocation: () => 1,
    buildRoomBookingPayload: () => ({ payload: { roomId: 1, title: 'NWS · Show [PB-NWS-TSN-261203-01]', ...payloadTimes } }),
    roomBookingEnabled: () => true,
    roomBookingAllowed: () => true,
    listRoomBookings: async () => [],
    findMarkerBooking: () => null,
    findManualHold: () => null,
    roomBookingMarker: (c: string) => `[PB-${c}]`,
    createRoomBooking: async () => ({ kind: 'conflict', message: 'ห้องถูกจองแล้ว' }),
    findExistingRoomBooking: async () => null,
    cancelRoomBooking: async () => ({ kind: 'not-found' }),
  },
})
mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../heartbeat', {
  namedExports: { recordHeartbeat: async (key: string, note?: string) => { beats.push({ key, note }) } },
})
mock.module('../room-booking-reconcile', { namedExports: { reconcileRoomBookings: async () => reconcileResult } })

let sync: typeof import('../room-booking-sync')
let GET: (r: any) => Promise<Response>
before(async () => {
  sync = await import('../room-booking-sync')
  ;({ GET } = await import('../../app/api/internal/room-booking/reconcile/route'))
})
beforeEach(() => {
  posted.length = 0; alerts.length = 0; beats.length = 0
  chatResult = async () => true
  clashes = async () => []
  payloadTimes = { startDate: '2026-12-03', startTime: '09:00', endDate: '2026-12-03', endTime: '17:00' }
  currentStatus = null
})

const quiet = async <T>(fn: () => Promise<T>) => {
  const e = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = e }
}
/** the notice is fire-and-forget from syncRoomBooking — let it settle */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

async function conflictRun() {
  return quiet(async () => {
    const r = await sync.syncRoomBooking('b1')
    await settle()
    return r
  })
}

test('transition to CONFLICT, chat delivered → one post, no ops alert', async () => {
  const r = await conflictRun()
  assert.equal(r.status, 'CONFLICT')
  assert.equal(posted.length, 1)
  assert.match(posted[0], /จองห้องให้ NWS-TSN-261203-01 ไม่ได้/)
  assert.equal(alerts.length, 0)
})

test('chat NOT delivered → alertOps room-conflict:<code> carries the same text', async () => {
  chatResult = async () => false
  await conflictRun()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].key, 'room-conflict:NWS-TSN-261203-01')
  assert.match(alerts[0].text, /จองห้องให้ NWS-TSN-261203-01 ไม่ได้/)
})

test('chat throws → alertOps', async () => {
  chatResult = async () => { throw new Error('discord down') }
  await conflictRun()
  assert.deepEqual(alerts.map(a => a.key), ['room-conflict:NWS-TSN-261203-01'])
})

test('describeRoomClash fails → still posts, saying the clash list could not be read', async () => {
  clashes = async () => { throw new Error('429 quota') }
  await conflictRun()
  assert.equal(posted.length, 1)
  assert.match(posted[0], /อ่านรายการที่ชนจากระบบกลางไม่ได้: 429 quota/)
  assert.equal(alerts.length, 0)
})

test('unparseable payload time → still posts (used to return silently)', async () => {
  payloadTimes = { startDate: '2026-12-03', startTime: '9am', endDate: '2026-12-03', endTime: '17:00' }
  await conflictRun()
  assert.equal(posted.length, 1)
  assert.match(posted[0], /แปลงเวลาที่ขอไม่ได้/)
})

test('unparseable time AND chat down → alertOps', async () => {
  payloadTimes = { startDate: '', startTime: '', endDate: '', endTime: '' }
  chatResult = async () => false
  await conflictRun()
  assert.deepEqual(alerts.map(a => a.key), ['room-conflict:NWS-TSN-261203-01'])
})

test('already CONFLICT (no transition) → no repeat post, no alert', async () => {
  currentStatus = 'CONFLICT'
  await conflictRun()
  assert.equal(posted.length + alerts.length, 0)
})

test('reconcile heartbeat note carries ล้ม and รอห้อง', async () => {
  reconcileResult = {
    scanned: 9, staleCancelled: [], staleStuck: [{ code: 'A', bookingNo: 'BK-1', reason: 'x' }],
    wrongRoomReleased: [], vanished: [], notEnabled: [], booked: [{ code: 'B' }],
    failed: [{ code: 'C', status: 'INVALID' }], conflictWaiting: ['D', 'E'], dryRun: false,
  }
  const saved = process.env.REMINDERS_SECRET
  process.env.REMINDERS_SECRET = 'r2-test-secret'
  try {
    const res = await GET(new Request('https://probook.test/api/internal/room-booking/reconcile?dryRun=0',
      { headers: { 'x-room-booking-secret': 'r2-test-secret' } }) as any)
    assert.equal(res.status, 200)
  } finally {
    if (saved === undefined) delete process.env.REMINDERS_SECRET
    else process.env.REMINDERS_SECRET = saved
  }
  assert.equal(beats.length, 1)
  assert.equal(beats[0].note, 'ค้าง 1 · ปลดแล้ว 0 · จองใหม่ 1 · ล้ม 1 · รอห้อง 2')
})
