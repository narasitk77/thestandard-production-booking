/**
 * Maintenance 2026-11-08 round 2 — /ot/admin bulk approve.
 * Round 1 had the page send `expectedCount` with allSubmitted. The page counted
 * active, listed people only; the server counted every SUBMITTED row of the month.
 * One disabled user (or no-account email) with a non-qualifying SUBMITTED row →
 * 409 STALE on every click, every reload, all month.
 * Now: the summary lists everyone with a SUBMITTED row and hands out the ids; the
 * page sends exactly those ids; the route approves the ones still SUBMITTED and
 * names the rest.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let otRows: any[] = []
let users: any[] = []

const matches = (r: any, where: any) => Object.entries(where).every(([k, v]: [string, any]) => {
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k])
  return r[k] === v
})

mock.module('../db', {
  namedExports: {
    prisma: {
      oTRecord: {
        findMany: async ({ where, select }: any) => otRows.filter(r => matches(r, where))
          .map(r => (select ? { id: r.id } : r)),
        updateMany: async ({ where, data }: any) => {
          const hit = otRows.filter(r => matches(r, where))
          for (const r of hit) Object.assign(r, data)
          return { count: hit.length }
        },
      },
      user: {
        findUnique: async () => ({ signaturePng: null }),
        findMany: async ({ where }: any) => users.filter(u => where.active === undefined || u.active === where.active),
      },
    },
  },
})
mock.module('../session', {
  namedExports: { requireOTApprover: async () => ({ email: 'boss@thestandard.co', role: 'ADMIN' }) },
})

let summaryGET: (r: any) => Promise<Response>
let approvePOST: (r: any) => Promise<Response>
before(async () => {
  ;({ GET: summaryGET } = await import('../../app/api/ot/summary/route'))
  ;({ POST: approvePOST } = await import('../../app/api/ot/admin/approve/route'))
})

// Wed 11 Nov 2026, one hour → never qualifies for OT pay.
const row = (id: string, email: string, approvalStatus = 'SUBMITTED') => ({
  id, userEmail: email, month: '2026-11', approvalStatus,
  date: new Date('2026-11-11T00:00:00Z'), endDate: null, startTime: '09:00', endTime: '10:00',
  jobTask: 'x', justification: 'y',
})

beforeEach(() => {
  users = [
    { id: 'u1', email: 'cam@thestandard.co', active: true, role: 'USER' },
    { id: 'u2', email: 'gone@thestandard.co', active: false, role: 'USER' },
  ]
  otRows = [
    row('a', 'cam@thestandard.co'),
    row('b', 'gone@thestandard.co'),        // disabled user, non-qualifying
    row('c', 'noaccount@thestandard.co'),   // no User row, non-qualifying
    row('d', 'cam@thestandard.co', 'DRAFT'),
  ]
})

const summary = async () => (await (await summaryGET(new Request('https://probook.test/api/ot/summary?month=2026-11') as any)).json()).summary
const approve = async (body: any) => {
  const res = await approvePOST(new Request('https://probook.test/api/ot/admin/approve', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as any)
  return { status: res.status, body: await res.json() }
}

test('summary hands out the id of every SUBMITTED row of the month — disabled and no-account people included', async () => {
  const ids = (await summary()).flatMap((s: any) => s.submittedRecordIds).sort()
  assert.deepEqual(ids, ['a', 'b', 'c'])
})

test('approve everyone (page flow): approves exactly what was shown, a later submit is left alone', async () => {
  const ids = (await summary()).flatMap((s: any) => s.submittedRecordIds)
  otRows.push(row('late', 'cam@thestandard.co'))   // submitted after the page loaded
  const r = await approve({ recordIds: ids })
  assert.equal(r.status, 200)
  assert.equal(r.body.approved, 3)
  assert.equal(r.body.requested, 3)
  assert.deepEqual(r.body.notApprovedIds, [])
  assert.deepEqual(otRows.filter(x => x.approvalStatus === 'APPROVED').map(x => x.id).sort(), ['a', 'b', 'c'])
  assert.equal(otRows.find(x => x.id === 'late')!.approvalStatus, 'SUBMITTED', 'never seen → never signed')
})

test('a shown row that changed status meanwhile is not approved, and is named', async () => {
  const ids = (await summary()).flatMap((s: any) => s.submittedRecordIds)
  otRows.find(x => x.id === 'b')!.approvalStatus = 'DRAFT'   // owner pulled it back to edit
  const r = await approve({ recordIds: [...ids, 'a'] })      // duplicates do not inflate `requested`
  assert.equal(r.status, 200)
  assert.equal(r.body.approved, 2)
  assert.equal(r.body.requested, 3)
  assert.deepEqual(r.body.notApprovedIds, ['b'])
  assert.equal(otRows.find(x => x.id === 'b')!.approvalStatus, 'DRAFT')
})
