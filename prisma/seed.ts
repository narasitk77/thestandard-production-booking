import { PrismaClient } from '@prisma/client'
import { OUTLETS } from '../src/lib/data'
import { TEAM_PROFILES } from '../src/lib/team-profiles'

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

  console.log('Seed complete.')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
