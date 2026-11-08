/**
 * Maintenance 2026-11-08 — OT routes.
 *  - resync dry-run listed bookings staffed only by team mailboxes (video@/sound@) as
 *    "wouldSync" although the real run creates 0 rows for them (dry-run ≠ real).
 *  - bulk approve ({email, month} / allSubmitted) approved whatever was SUBMITTED at
 *    click time, not what the approver was shown → expectedCount guard.
 *  - the CSV cover sheet totals include rows no manager approved, unmarked.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let bookings: any[] = []
let otRows: any[] = []
let updateManyCalls: any[] = []

const matches = (r: any, where: any) => Object.entries(where).every(([k, v]: [string, any]) => {
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k])
  return r[k] === v
})

mock.module('../db', {
  namedExports: {
    prisma: {
      booking: { findMany: async () => bookings },
      oTRecord: {
        findMany: async ({ where }: any) => otRows.filter(r => matches(r, where)),
        updateMany: async (args: any) => {
          updateManyCalls.push(args)
          const hit = otRows.filter(r => matches(r, args.where))
          for (const r of hit) Object.assign(r, args.data)
          return { count: hit.length }
        },
      },
      user: {
        findUnique: async () => ({ signaturePng: 'data:image/png;base64,AAAA' }),
        findMany: async () => [{ email: 'cam@thestandard.co', thaiName: 'ช่างกล้อง', employeeId: 'E1', position: 'Camera' }],
      },
    },
  },
})
mock.module('../session', {
  namedExports: {
    getSession: async () => ({ email: 'boss@thestandard.co', role: 'ADMIN' }),
    requireOTApprover: async () => ({ email: 'boss@thestandard.co', role: 'ADMIN' }),
    getOTApproverAccess: async () => true,
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })

let resyncGET: (r: any) => Promise<Response>
let approvePOST: (r: any) => Promise<Response>
let exportGET: (r: any) => Promise<Response>
before(async () => {
  process.env.REMINDERS_SECRET = 'ot-test-secret'
  ;({ GET: resyncGET } = await import('../../app/api/internal/ot/resync/route'))
  ;({ POST: approvePOST } = await import('../../app/api/ot/admin/approve/route'))
  ;({ GET: exportGET } = await import('../../app/api/ot/export/route'))
})
beforeEach(() => { bookings = []; otRows = []; updateManyCalls = [] })

const post = (body: any) => new Request('https://probook.test/api/ot/admin/approve', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}) as any

test('resync dry-run does not promise to sync a booking staffed only by team mailboxes', async () => {
  bookings = [
    { id: 'b1', bookingCode: 'NWS-ONLYTEAM', assignedEmails: ['video@thestandard.co', 'sound@thestandard.co'], shootDate: new Date() },
    { id: 'b2', bookingCode: 'NWS-PERSON', assignedEmails: ['video@thestandard.co', 'cam@thestandard.co'], shootDate: new Date() },
  ]
  const res = await resyncGET(new Request('https://probook.test/api/internal/ot/resync?month=2026-11&dryRun=1', {
    headers: { 'x-ot-resync-secret': 'ot-test-secret' },
  }) as any)
  const body = await res.json()
  assert.deepEqual(body.wouldSync, ['NWS-PERSON'])
})

const sub = (id: string, email: string) => ({ id, userEmail: email, month: '2026-11', approvalStatus: 'SUBMITTED' })

test('approve {email, month, expectedCount}: a row resubmitted after the page loaded → 409, nothing approved', async () => {
  otRows = [sub('a', 'cam@thestandard.co'), sub('b', 'cam@thestandard.co'), sub('c', 'cam@thestandard.co')]
  const res = await approvePOST(post({ email: 'cam@thestandard.co', month: '2026-11', expectedCount: 2 }))
  assert.equal(res.status, 409)
  assert.equal(updateManyCalls.length, 0)
  assert.ok(otRows.every(r => r.approvalStatus === 'SUBMITTED'))
})

test('approve allSubmitted with the matching count approves exactly those rows', async () => {
  otRows = [sub('a', 'cam@thestandard.co'), sub('b', 'snd@thestandard.co')]
  const res = await approvePOST(post({ month: '2026-11', allSubmitted: true, expectedCount: 2 }))
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.approved, 2)
  assert.deepEqual(updateManyCalls[0].where.id.in.sort(), ['a', 'b'])
})

test('approve without expectedCount keeps the old behaviour (legacy callers)', async () => {
  otRows = [sub('a', 'cam@thestandard.co')]
  const res = await approvePOST(post({ email: 'cam@thestandard.co', month: '2026-11' }))
  assert.equal((await res.json()).approved, 1)
})

test('CSV cover sheet: total unchanged, but unapproved money is stated next to it', async () => {
  const day = (id: string, date: string, status: string) => ({
    id, userEmail: 'cam@thestandard.co', month: '2026-10', approvalStatus: status,
    date: new Date(`${date}T00:00:00Z`), endDate: null, startTime: '09:00', endTime: '20:00',
    jobTask: 'x', justification: 'y', bookingId: 'b1', type: null, description: null,
  })
  // 3 and 4 Oct 2026 are Sat/Sun → 500 THB each
  otRows = [day('r1', '2026-10-03', 'APPROVED'), day('r2', '2026-10-04', 'DRAFT')]
  const res = await exportGET(new Request('https://probook.test/api/ot/export?month=2026-10') as any)
  const csv = await res.text()
  assert.match(csv, /รวมจำนวนเงิน \(THB\)[^\n]*1000/)
  assert.match(csv, /ยังไม่อนุมัติ 500 THB/)
  // Round 3: the unapproved part sits in หมายเหตุ of the total row — no extra THB
  // row under the total (finance sums column G; totals policy is Nat's decision).
  const lines = csv.replace(/^﻿/, '').split('\n').map(l => l.split(','))
  const total = lines.find(c => c[0] === 'รวมจำนวนเงิน (THB)')!
  assert.equal(total[6], '1000')
  assert.match(total[7], /ห้ามแก้ตัวเลขเอง · ในยอดนี้ยังไม่อนุมัติ 500 THB \(อนุมัติแล้ว 500 THB\)/)
  const after = lines.slice(lines.indexOf(total) + 1)
  assert.ok(after.every(c => !/\d/.test(c[6] ?? '')), 'no THB figure below the total')
  assert.deepEqual(after.map(c => c[0]), ['', ''], 'footer = blank row + signature row, as before')
})

test('CSV cover sheet: all approved → total row หมายเหตุ is exactly as before', async () => {
  otRows = [{
    id: 'r1', userEmail: 'cam@thestandard.co', month: '2026-10', approvalStatus: 'APPROVED',
    date: new Date('2026-10-03T00:00:00Z'), endDate: null, startTime: '09:00', endTime: '20:00',
    jobTask: 'x', justification: 'y', bookingId: 'b1', type: null, description: null,
  }]
  const csv = await (await exportGET(new Request('https://probook.test/api/ot/export?month=2026-10') as any)).text()
  assert.match(csv, /\nรวมจำนวนเงิน \(THB\),,,,,,500,ห้ามแก้ตัวเลขเอง\n/)
  assert.doesNotMatch(csv, /ยังไม่อนุมัติ/)
})
