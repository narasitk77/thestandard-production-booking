/**
 * Maintenance 2026-11-08 round 2 — admin money routes.
 * decOrNull now throws InvalidMoneyError for '-500' / 'abc1e999' instead of
 * returning null (which WIPED the stored amount). Every POST/PATCH that parses a
 * money field must answer 400 with the Thai message — not 500 — and write nothing.
 */
import { test, mock, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const ME = 'admin@thestandard.co'
let writes: string[] = []

// Any prisma.<model>.<method>: reads return a generic editable row; writes are recorded.
const row = { id: 'x', status: 'DRAFT', itemLabel: 'lens', paymentStatus: 'PENDING', batch: { status: 'DRAFT', ownerEmail: ME } }
const model = (name: string) => new Proxy({}, {
  get: (_t, method: string) => async () => {
    if (/^(create|update|updateMany|delete|deleteMany)$/.test(method)) writes.push(`${name}.${method}`)
    return row
  },
})
const prisma: any = new Proxy({}, {
  get: (_t, name: string) => name === '$transaction' ? async (fn: any) => fn(prisma) : model(name),
})

mock.module('../db', { namedExports: { prisma } })
mock.module('../session', {
  namedExports: {
    requireAdmin: async () => ({ email: ME, role: 'ADMIN' }),
    requireConsole: async () => ({ email: ME, role: 'ADMIN' }),
  },
})
mock.module('../audit', { namedExports: { logAudit: async () => {} } })
mock.module('../equipment-status', { namedExports: { reconcileEquipmentStatus: async () => {} } })

type Handler = (req: any, ctx?: any) => Promise<Response>
const cases: Array<{ name: string; load: () => Promise<Handler>; body: any }> = [
  { name: 'POST rentals', load: async () => (await import('../../app/api/admin/rentals/route')).POST, body: { jobName: 'j', amount: '-500' } },
  { name: 'PATCH rentals/[id]', load: async () => (await import('../../app/api/admin/rentals/[id]/route')).PATCH, body: { amount: '-500' } },
  { name: 'POST purchases', load: async () => (await import('../../app/api/admin/purchases/route')).POST, body: { month: '2026-11', item: 'tape', unitPrice: '-1' } },
  { name: 'PATCH purchases/[id]', load: async () => (await import('../../app/api/admin/purchases/[id]/route')).PATCH, body: { total: '99999999999999' } },
  { name: 'POST repairs', load: async () => (await import('../../app/api/admin/repairs/route')).POST, body: { itemLabel: 'lens', cost: '-20' } },
  { name: 'PATCH repairs/[id]', load: async () => (await import('../../app/api/admin/repairs/[id]/route')).PATCH, body: { cost: '-20' } },
  { name: 'POST equipment', load: async () => (await import('../../app/api/admin/equipment/route')).POST, body: { name: 'cam', purchasePrice: '-1' } },
  { name: 'PATCH equipment/[id]', load: async () => (await import('../../app/api/admin/equipment/[id]/route')).PATCH, body: { purchasePrice: '-1' } },
]

const handlers = new Map<string, Handler>()
before(async () => { for (const c of cases) handlers.set(c.name, await c.load()) })
beforeEach(() => { writes = [] })

for (const c of cases) {
  test(`${c.name}: invalid amount → 400 with the Thai message, nothing written`, async () => {
    const req = new Request('https://probook.test/api/admin/x', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.body),
    })
    const res = await handlers.get(c.name)!(req as any, { params: { id: 'x' } })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /ยอดเงินไม่ถูกต้อง/)
    assert.deepEqual(writes, [])
  })
}
