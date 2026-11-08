/**
 * Maintenance 2026-11-08 — POST /api/internal/switcher/prefill:
 *  - the dry run checked duplicates against the DB only, so two items with the same
 *    externalKey in one batch previewed as created: 2 while the real run gives 1 + 1
 *    duplicate (dry-run must match real, docs/bug-classes.md class 5);
 *  - a DB failure was reported as 'invalid' (= bad input) inside a 200.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

let db: any[] = []
let failCreate = false
mock.module('../db', {
  namedExports: {
    prisma: {
      switcherJob: {
        findFirst: async ({ where }: any) => db.find(r => where.externalKey
          ? r.externalKey === where.externalKey
          : r.jobName === where.jobName && r.workDate.getTime() === where.workDate.getTime()) ?? null,
        create: async ({ data }: any) => {
          if (failCreate) throw new Error('connection reset')
          const row = { id: `sj${db.length + 1}`, ...data }
          db.push(row)
          return { id: row.id }
        },
      },
    },
  },
})
mock.module('../session', { namedExports: { getSession: async () => null } })
mock.module('../audit', { namedExports: { logAudit: async () => {} } })

let POST: (r: any) => Promise<Response>
before(async () => {
  process.env.REMINDERS_SECRET = 'prefill-secret'
  ;({ POST } = await import('../../app/api/internal/switcher/prefill/route'))
})
beforeEach(() => { db = []; failCreate = false })

const call = (body: any) => POST(new Request('https://probook.test/api/internal/switcher/prefill', {
  method: 'POST', headers: { 'x-switcher-secret': 'prefill-secret', 'content-type': 'application/json' },
  body: JSON.stringify(body),
}) as any)

const jobs = [
  { externalKey: 'line:msg:1', jobName: 'ไลฟ์แถลงข่าว', workDate: '2026-11-09', outletCode: 'NWS' },
  { externalKey: 'line:msg:1', jobName: 'ไลฟ์แถลงข่าว', workDate: '2026-11-09', outletCode: 'NWS' },
  { jobName: 'ไลฟ์แถลงข่าว', workDate: '2026-11-09', outletCode: 'NWS' }, // no key → name+date
]

test('dry run predicts exactly what the real run does for in-batch duplicates', async () => {
  const dry = await (await call({ dryRun: true, jobs })).json()
  const real = await (await call({ jobs })).json()
  assert.equal(real.created, 1)
  assert.equal(real.duplicate, 2)
  assert.deepEqual([dry.created, dry.duplicate], [real.created, real.duplicate])
  assert.equal(db.length, 1)
})

test('a DB failure is an error (non-200), not "invalid input"', async () => {
  failCreate = true
  const res = await call({ jobs: [jobs[0]] })
  const body = await res.json()
  assert.equal(res.status, 500)
  assert.equal(body.ok, false)
  assert.equal(body.errors, 1)
  assert.equal(body.invalid, 0)
  assert.equal(body.outcomes[0].result, 'error')
})
