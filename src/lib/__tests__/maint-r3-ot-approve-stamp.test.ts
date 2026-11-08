/**
 * Maintenance 2026-11-08 round 3 — approve by { id, updatedAt }.
 * recordIds proved "same row", not "same numbers": a row pulled back to DRAFT and
 * resubmitted with new hours after the page loaded keeps its id and is SUBMITTED
 * again, so a bare-id approve signed hours the approver never saw. The review page
 * now sends { id, updatedAt } as loaded; the route approves only rows still
 * SUBMITTED with that exact updatedAt and names the rest.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let otRows: any[] = []
let updateManyCalls: any[] = []

const same = (a: any, b: any) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)
const matches = (r: any, where: any) => Object.entries(where).every(([k, v]: [string, any]) => {
  if (v && typeof v === 'object' && !(v instanceof Date) && 'in' in v) return v.in.includes(r[k])
  return same(r[k], v)
})
// Hook to change a row between the route's read and its write (a race).
let betweenReadAndWrite: (() => void) | null = null

mock.module('../db', {
  namedExports: {
    prisma: {
      oTRecord: {
        findMany: async ({ where }: any) => {
          const hit = otRows.filter(r => matches(r, where)).map(r => ({ id: r.id, updatedAt: r.updatedAt }))
          betweenReadAndWrite?.()
          return hit
        },
        updateMany: async (args: any) => {
          updateManyCalls.push(args)
          const hit = otRows.filter(r => matches(r, args.where))
          for (const r of hit) Object.assign(r, args.data, { updatedAt: new Date() })
          return { count: hit.length }
        },
      },
      user: { findUnique: async () => ({ signaturePng: null }) },
    },
  },
})
mock.module('../session', {
  namedExports: { requireOTApprover: async () => ({ email: 'boss@thestandard.co', role: 'ADMIN' }) },
})

let approvePOST: (r: any) => Promise<Response>
before(async () => {
  ;({ POST: approvePOST } = await import('../../app/api/ot/admin/approve/route'))
})

const T0 = new Date('2026-11-08T03:00:00.123Z')
const row = (id: string, approvalStatus = 'SUBMITTED', updatedAt = T0) =>
  ({ id, userEmail: 'cam@thestandard.co', month: '2026-11', approvalStatus, updatedAt })
// What the review page sends: the record as GET /api/ot serialised it (JSON → ISO string).
const stamp = (r: any) => ({ id: r.id, updatedAt: JSON.parse(JSON.stringify(r.updatedAt)) })

beforeEach(() => { otRows = []; updateManyCalls = []; betweenReadAndWrite = null })

const approve = async (body: any) => {
  const res = await approvePOST(new Request('https://probook.test/api/ot/admin/approve', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as any)
  return { status: res.status, body: await res.json() }
}

test('unchanged row (same updatedAt, still SUBMITTED) → approved', async () => {
  otRows = [row('a')]
  const r = await approve({ recordIds: [stamp(otRows[0])] })
  assert.equal(r.status, 200)
  assert.equal(r.body.approved, 1)
  assert.equal(r.body.requested, 1)
  assert.deepEqual(r.body.notApprovedIds, [])
  assert.equal(otRows[0].approvalStatus, 'APPROVED')
  assert.equal(otRows[0].approvedByEmail, 'boss@thestandard.co')
})

test('row resubmitted with new hours after the page loaded (same id, SUBMITTED, newer updatedAt) → NOT approved, named', async () => {
  otRows = [row('a'), row('b')]
  const seen = otRows.map(stamp)
  otRows[1].updatedAt = new Date(T0.getTime() + 60_000)   // owner edited + resubmitted
  const r = await approve({ recordIds: seen })
  assert.equal(r.body.approved, 1)
  assert.equal(r.body.requested, 2)
  assert.deepEqual(r.body.notApprovedIds, ['b'])
  assert.deepEqual(r.body.changedIds, ['b'])
  assert.equal(otRows[1].approvalStatus, 'SUBMITTED', 'unseen numbers are never signed')
  assert.ok(updateManyCalls.every(c => c.where.id !== 'b'))
})

test('row no longer SUBMITTED (pulled back to DRAFT) → not approved, named in notApprovedIds only', async () => {
  otRows = [row('a')]
  const seen = otRows.map(stamp)
  otRows[0].approvalStatus = 'DRAFT'
  const r = await approve({ recordIds: seen })
  assert.equal(r.body.approved, 0)
  assert.deepEqual(r.body.notApprovedIds, ['a'])
  assert.deepEqual(r.body.changedIds, [])
  assert.equal(otRows[0].approvalStatus, 'DRAFT')
})

test('row edited between the route\'s read and its write → the CAS update misses, reported as changed', async () => {
  otRows = [row('a')]
  const seen = otRows.map(stamp)
  betweenReadAndWrite = () => { otRows[0].updatedAt = new Date(T0.getTime() + 1) }
  const r = await approve({ recordIds: seen })
  assert.equal(r.body.approved, 0)
  assert.deepEqual(r.body.changedIds, ['a'])
  assert.equal(otRows[0].approvalStatus, 'SUBMITTED')
  assert.ok(same(updateManyCalls[0].where.updatedAt, T0), 'the write itself is conditional on updatedAt')
})

test('malformed entry ({ id } without a valid updatedAt) → 400, nothing written', async () => {
  otRows = [row('a'), row('b')]
  for (const bad of [{ id: 'a' }, { id: 'a', updatedAt: 'not-a-date' }, { updatedAt: T0.toISOString() }]) {
    const r = await approve({ recordIds: [stamp(otRows[1]), bad] })
    assert.equal(r.status, 400, JSON.stringify(bad))
  }
  assert.equal(updateManyCalls.length, 0)
  assert.ok(otRows.every(x => x.approvalStatus === 'SUBMITTED'))
})

test('bare ids (legacy callers, /ot/admin today) still approve by status alone', async () => {
  otRows = [row('a'), row('b', 'REJECTED')]
  const r = await approve({ recordIds: ['a', 'b'] })
  assert.equal(r.body.approved, 1)
  assert.deepEqual(r.body.notApprovedIds, ['b'])
  assert.equal(otRows[0].approvalStatus, 'APPROVED')
  assert.equal(otRows[1].approvalStatus, 'REJECTED')
})
