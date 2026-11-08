// maint r3 2026-11-08 — the boot-time team-profile sync must keep running (prod behaviour) without overwriting
// admin edits: an existing user gets a team-profiles.ts value ONLY where the DB field is null/empty; a non-empty
// DB value that differs from the code is kept and named in the boot log; missing users are created as before.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'
import { TEAM_PROFILES } from '../team-profiles'

const [setUser, blankUser] = TEAM_PROFILES
const rows: Record<string, any> = {
  // admin changed position + name; employeeId matches the code
  [setUser.email]: { thaiName: 'ชื่อที่แอดมินแก้', employeeId: setUser.employeeId, position: 'Head of Everything' },
  // a row created by auth.ts on first login: name null, employeeId empty, position whitespace
  [blankUser.email]: { thaiName: null, employeeId: '', position: '  ' },
}
const calls: { op: string; args: any }[] = []
let disconnected: () => void
const done = new Promise<void>((r) => { disconnected = r })

class FakePrisma {
  user = {
    findUnique: async (args: any) => rows[args.where.email] ?? null,
    create: async (args: any) => { calls.push({ op: 'user.create', args }); return {} },
    upsert: async (args: any) => { calls.push({ op: 'user.upsert', args }); return {} },
    update: async (args: any) => { calls.push({ op: 'user.update', args }); return {} },
  }
  outlet = { upsert: async (args: any) => ({ id: `o-${args.where.code}` }) }
  program = { upsert: async () => ({}) }
  teamMember = { findUnique: async () => ({ id: 't' }), create: async () => ({}) }
  $disconnect = async () => { disconnected() }
}
mock.module('@prisma/client', { namedExports: { PrismaClient: FakePrisma } })

const logs: string[] = []
const errors: string[] = []
before(async () => {
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: any[]) => { logs.push(a.map(String).join(' ')) }
  console.error = (...a: any[]) => { errors.push(a.map(String).join(' ')) }
  try {
    await import('../../../prisma/seed')
    await done
  } finally {
    console.log = origLog
    console.error = origErr
  }
})

test('blank fields are filled from team-profiles.ts — only those fields', () => {
  const upd = calls.filter((c) => c.op === 'user.update')
  assert.equal(upd.length, 1, `exactly the blank user is updated: ${JSON.stringify(upd)}`)
  assert.deepEqual(upd[0].args.where, { email: blankUser.email })
  assert.deepEqual(upd[0].args.data, { thaiName: blankUser.thaiName, employeeId: blankUser.employeeId, position: blankUser.position })
})

test('an admin-set value is never overwritten, and the difference is named in the boot log', () => {
  assert.ok(!calls.some((c) => (c.op === 'user.update' || c.op === 'user.upsert') && c.args.where.email === setUser.email))
  const line = logs.find((l) => l.includes('differs from the DB'))
  assert.ok(line, `no "differs from the DB" line: ${logs.join(' | ')}`)
  assert.match(line!, new RegExp(`${setUser.email.replace(/\./g, '\\.')}\\.thaiName`))
  assert.match(line!, new RegExp(`${setUser.email.replace(/\./g, '\\.')}\\.position`))
  assert.ok(!line!.includes(`${setUser.email}.employeeId`), 'an equal value is not a difference')
})

test('missing users are still created; a clean seed sets no failure exit code', () => {
  const created = calls.filter((c) => c.op === 'user.create').map((c) => c.args.data.email)
  assert.equal(created.length, TEAM_PROFILES.length - 2)
  assert.ok(!created.includes(setUser.email) && !created.includes(blankUser.email))
  assert.ok(!process.exitCode, `exitCode=${process.exitCode}`)
  assert.deepEqual(errors.filter((l) => l.includes('[seed]')), [])
})
