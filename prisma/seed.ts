import { PrismaClient } from '@prisma/client'
import { OUTLETS } from '../src/lib/data'
import { TEAM_PROFILES } from '../src/lib/team-profiles'
import { INITIAL_TEAM_ROSTER } from '../src/lib/team-roster'

const prisma = new PrismaClient()

const ADMIN_EMAILS = ['narasit.k@thestandard.co']

async function main() {
  console.log('Seeding team profiles...')
  for (const p of TEAM_PROFILES) {
    const isAdmin = ADMIN_EMAILS.includes(p.email)
    await prisma.user.upsert({
      where: { email: p.email },
      update: {
        thaiName: p.thaiName,
        employeeId: p.employeeId,
        position: p.position,
      },
      create: {
        email: p.email,
        thaiName: p.thaiName,
        employeeId: p.employeeId,
        position: p.position,
        role: isAdmin ? 'ADMIN' : 'USER',
      },
    })
  }
  console.log(`✓ ${TEAM_PROFILES.length} team profiles synced`)

  console.log('Seeding outlets and programs...')

  for (const outlet of OUTLETS) {
    const created = await prisma.outlet.upsert({
      where: { code: outlet.code },
      update: { name: outlet.name, notes: outlet.description, sort: outlet.sort },
      create: {
        code: outlet.code,
        name: outlet.name,
        notes: outlet.description,
        sort: outlet.sort,
      },
    })

    for (const program of outlet.programs) {
      await prisma.program.upsert({
        where: { code_outletId: { code: program.code, outletId: created.id } },
        update: { name: program.name, category: program.category },
        create: {
          code: program.code,
          name: program.name,
          category: program.category,
          outletId: created.id,
        },
      })
    }

    console.log(`✓ ${outlet.code} — ${outlet.programs.length} programs`)
  }

  // v1.31 — team_members table for crew assignment roster (was hardcoded
  // in admin/[id]/page.tsx as a TEAM constant). Only inserts members
  // missing from the DB — edits made via /admin/team survive subsequent
  // seed runs.
  console.log('Seeding team_members (crew assignment roster)...')
  let inserted = 0
  for (let i = 0; i < INITIAL_TEAM_ROSTER.length; i++) {
    const m = INITIAL_TEAM_ROSTER[i]
    const existing = await prisma.teamMember.findUnique({ where: { email: m.email } })
    if (existing) continue
    await prisma.teamMember.create({
      data: { email: m.email, name: m.name, role: m.role, sort: i },
    })
    inserted++
  }
  console.log(`✓ team_members: ${inserted} inserted, ${INITIAL_TEAM_ROSTER.length - inserted} already present`)

  console.log('Seed complete.')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
