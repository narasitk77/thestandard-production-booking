// The QU sweep's "nobody is chasing these" report (producer left / no email / mail failed)
// went out only via notifyChat(…,'ops'), which reaches nobody on prod (Discord drops 'ops',
// Lark unset) and leaves no ops.alert row for the relay — POD-8MH-260814-01 (producer
// inactive) went unchased from 10 Oct. It now goes through alertOps, keyed by the set.
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let rows: any[] = []
let inactive: string[] = []
let mailFails = false
const alerts: any[][] = []
const mailed: string[] = []

mock.module('../db', {
  namedExports: {
    prisma: {
      // คืนเฉพาะคอลัมน์ที่ select เหมือน prisma จริง — ฟิลด์ที่ลืม select ต้องหายจริงในเทส
      booking: {
        findMany: async ({ select }: any) => rows.map(r => Object.fromEntries(Object.keys(select).map(k => [k, r[k]]))),
        updateMany: async () => ({ count: 1 }),
      },
      user: { findMany: async () => inactive.map(email => ({ email })) },
    },
  },
})
mock.module('../email', {
  namedExports: {
    isEmailConfigured: () => true,
    sendEmail: async ({ to }: any) => { if (mailFails) throw new Error('535 Invalid login'); mailed.push(...to) },
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../ops-alert', {
  namedExports: { alertOps: async (...a: any[]) => { alerts.push(a); return { attempted: true, delivered: true } } },
})

let mod: typeof import('../qu-reminder-dispatch')
before(async () => { mod = await import('../qu-reminder-dispatch') })

const booking = (code: string, producerEmail: string | null) => ({
  id: code, bookingCode: code, agencyRef: 'รอ AE แจ้งอีกทีค่า', shootDate: new Date('2026-08-14T00:00:00Z'),
  status: 'COMPLETED', producer: 'P', producerEmail, quRemindedAt: null, projectName: 'x',
})

beforeEach(() => { rows = []; inactive = []; mailFails = false; alerts.length = 0; mailed.length = 0 })

test('only pending booking has an inactive producer → alertOps once, weekly throttle, names the booking', async () => {
  rows = [booking('POD-8MH-260814-01', 'phantawat.s@thestandard.co')]
  inactive = ['phantawat.s@thestandard.co']
  const r = await mod.runQuReminderSweep()
  assert.equal(r.emailed, 0)
  assert.equal(mailed.length, 0)
  assert.equal(alerts.length, 1)
  const [key, subject, text, everyMs] = alerts[0]
  assert.match(key, /^qu-unreachable:[0-9a-f]{16}$/)
  assert.match(subject, /1 ใบ/)
  assert.match(text, /POD-8MH-260814-01/)
  assert.match(text, /phantawat\.s/)
  assert.equal(everyMs, 7 * 24 * 3_600_000)
})

test('clean sweep (mail delivered, everyone reachable) → no alertOps at all', async () => {
  rows = [booking('AGN-261201-01', 'pro@thestandard.co')]
  const r = await mod.runQuReminderSweep()
  assert.equal(r.emailed, 1)
  assert.equal(alerts.length, 0)
})

test('mail failure and missing producer email alert too; same set → same key, changed set → new key', async () => {
  rows = [booking('AGN-261201-01', 'pro@thestandard.co'), booking('AGN-261202-01', null)]
  mailFails = true
  const r = await mod.runQuReminderSweep()
  assert.equal(r.failed, 1)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0][2], /AGN-261201-01/)
  assert.match(alerts[0][2], /AGN-261202-01/)
  await mod.runQuReminderSweep()
  assert.equal(alerts[1][0], alerts[0][0], 'same set → same key (alertOps throttles it weekly)')
  rows = [booking('AGN-261202-01', null)]
  mailFails = false
  await mod.runQuReminderSweep()
  assert.notEqual(alerts[2][0], alerts[0][0], 'changed set → new key → alerted at once')
})

test('dry run never alerts', async () => {
  rows = [booking('POD-8MH-260814-01', 'phantawat.s@thestandard.co')]
  inactive = ['phantawat.s@thestandard.co']
  await mod.runQuReminderSweep({ dryRun: true })
  assert.equal(alerts.length, 0)
})

// รอบ 2 (23 พ.ย.) — งานหลายวันที่ถ่ายอยู่ยังเร่ง: ต้อง select shootEndDate มาด้วย ไม่งั้น quUrgency
// เห็นแค่วันแรก (ผ่านไปแล้ว = ปกติ = รอ 7 วัน) ทั้งที่คอมเมนต์สัญญาว่านับถึงวันสุดท้าย
test('multi-day job still shooting today, reminded yesterday → mailed again today (shootEndDate is read)', async () => {
  const DAY = 86_400_000
  const todayBkk = Math.floor((Date.now() + 7 * 3_600_000) / DAY) * DAY // @db.Date ของวันนี้ (กรุงเทพ)
  rows = [{
    ...booking('NWS-MLT-261118-01', 'pro@thestandard.co'),
    agencyRef: 'QU-1234TBC',
    shootDate: new Date(todayBkk - 2 * DAY),
    shootEndDate: new Date(todayBkk),
    quRemindedAt: new Date(Date.now() - DAY),
  }]
  const r = await mod.runQuReminderSweep()
  assert.equal(r.producersDue, 1)
  assert.equal(r.emailed, 1)
  assert.deepEqual(mailed, ['pro@thestandard.co'])
})
