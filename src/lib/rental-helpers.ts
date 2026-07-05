import { prisma } from '@/lib/db'
import { cleanStr } from '@/lib/admin-parse'
import { getOutlet } from '@/lib/data'

/**
 * The rentals form sends an outlet CODE (e.g. 'NWS'); RentalJob.outletId is a FK
 * to Outlet.id (a cuid). Resolve + upsert the code to its row id so a chosen
 * outlet doesn't blow up the write with a foreign-key violation. Unknown or
 * blank → null (outlet is optional on a rental).
 */
export async function resolveOutletId(codeOrId?: unknown): Promise<string | null> {
  const v = cleanStr(codeOrId)
  if (!v) return null
  // Already a row id? (an edit round-tripping the stored FK) — keep it as-is
  // rather than silently nulling the link because it isn't a known code.
  const byId = await prisma.outlet.findUnique({ where: { id: v }, select: { id: true } })
  if (byId) return byId.id
  const o = getOutlet(v)
  if (!o) return null
  const db = await prisma.outlet.upsert({
    where: { code: o.code },
    update: {},
    create: { code: o.code, name: o.name, notes: o.description, sort: o.sort },
  })
  return db.id
}
