import { PrismaClient } from '@prisma/client'
import { OUTLETS } from '../src/lib/data'

const prisma = new PrismaClient()

async function main() {
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
