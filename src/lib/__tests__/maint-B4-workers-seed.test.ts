// 2026-11-08 maintenance — prisma/seed.ts runs on EVERY web boot (start.sh).
//
// (1) It used to upsert `update: { thaiName, employeeId, position }`, writing the
//     code's TEAM_PROFILES back over admin edits made in /admin/permissions on every
//     deploy — and `position` gates OT approval (positionGrantsOT) and the producer
//     tier. Users must now be create-only, the same rule team_members already had.
//     (maint r3: create-only dropped the prod sync; it is now fill-blanks — an existing user whose fields an
//     admin has set is still never written. Fill-blanks itself: maint-r3-workers-seed-fill-blanks.test.ts)
// (2) `.catch(console.error)` swallowed a failed seed, exit 0, so start.sh's
//     `|| echo` never fired. A failure must set a non-zero exit code and print the
//     `[seed] run failed` tag the Hermes log scan matches.
//
// The seed runs main() at import, so the client is swapped for an in-memory fake
// and the test waits for $disconnect (the seed's last act) before asserting.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'
import { TEAM_PROFILES } from '../team-profiles'

const existingEmail = TEAM_PROFILES[0].email
const calls: { op: string; args: any }[] = []
let failOutlets = false
let disconnected: () => void
const done = new Promise<void>((r) => { disconnected = r })

class FakePrisma {
  user = {
    // the existing row carries admin-set values (fill-blanks only writes null/empty fields)
    findUnique: async (args: any) => (args.where.email === existingEmail
      ? { id: 'u1', thaiName: 'ชื่อที่แอดมินแก้', employeeId: 'TSD99999', position: 'Producer (set in /admin/permissions)' }
      : null),
    create: async (args: any) => { calls.push({ op: 'user.create', args }); return {} },
    upsert: async (args: any) => { calls.push({ op: 'user.upsert', args }); return {} },
    update: async (args: any) => { calls.push({ op: 'user.update', args }); return {} },
  }
  outlet = {
    upsert: async (args: any) => {
      if (failOutlets) throw new Error('simulated DB blip after db push')
      return { id: `o-${args.where.code}` }
    },
  }
  program = { upsert: async () => ({}) }
  teamMember = { findUnique: async () => ({ id: 't' }), create: async () => ({}) }
  $disconnect = async () => { disconnected() }
}
mock.module('@prisma/client', { namedExports: { PrismaClient: FakePrisma } })

const errors: string[] = []
before(async () => {
  failOutlets = true
  const origErr = console.error
  const origLog = console.log
  console.error = (...a: any[]) => { errors.push(a.map(String).join(' ')) }
  console.log = () => {}
  try {
    await import('../../../prisma/seed')
    await done
    // .finally() runs after the catch handler, so exitCode is already set here.
  } finally {
    console.error = origErr
    console.log = origLog
  }
})

test('existing users are never updated — admin edits to position survive a deploy', () => {
  assert.equal(calls.filter((c) => c.op === 'user.upsert' || c.op === 'user.update').length, 0,
    'seed must not write over an existing user row')
  const created = calls.filter((c) => c.op === 'user.create').map((c) => c.args.data.email)
  assert.ok(!created.includes(existingEmail), 'an existing user must not be re-created')
  assert.equal(created.length, TEAM_PROFILES.length - 1, 'every missing profile is still created')
})

test('a failed seed exits non-zero and says `[seed] run failed`', () => {
  const code = process.exitCode
  // Reset before asserting so the runner does not mark this file failed by exit code.
  process.exitCode = 0
  assert.equal(code, 1, 'seed failure must set a non-zero exit code')
  assert.ok(errors.some((l) => l.includes('[seed] run failed')), `no [seed] run failed line: ${errors.join(' | ')}`)
})
