import { PrismaClient } from '@prisma/client'
import { OUTLETS } from '../src/lib/data'
import { TEAM_PROFILES } from '../src/lib/team-profiles'
import { INITIAL_TEAM_ROSTER } from '../src/lib/team-roster'

const prisma = new PrismaClient()

const ADMIN_EMAILS = ['narasit.k@thestandard.co']

async function main() {
  // 2026-11-08 (maint r3) — fill blanks, never overwrite. start.sh runs this seed on EVERY web boot; HEAD's
  // `upsert update: { thaiName, employeeId, position }` wrote the code's values back over whatever an admin had set
  // in /admin/permissions, so a position change (which gates OT approval — positionGrantsOT — and the producer tier
  // — resolveTier) silently reverted on the next deploy. Round 1 made it create-only, which dropped the prod sync
  // (Nat's rule: no removal without his go). Now: missing users are created as before, and an existing user gets a
  // code value only where the DB field is null/empty. A code value that DIFFERS from a non-empty DB value is NOT
  // applied — it is logged by name below, so a team-profiles.ts edit that did not land is visible in the boot log.
  console.log('Seeding team profiles...')
  const PROFILE_FIELDS = ['thaiName', 'employeeId', 'position'] as const
  let usersCreated = 0
  let usersFilled = 0
  const kept: string[] = []
  for (const p of TEAM_PROFILES) {
    const existing = await prisma.user.findUnique({
      where: { email: p.email },
      select: { thaiName: true, employeeId: true, position: true },
    })
    if (!existing) {
      await prisma.user.create({
        data: {
          email: p.email,
          thaiName: p.thaiName,
          employeeId: p.employeeId,
          position: p.position,
          role: ADMIN_EMAILS.includes(p.email) ? 'ADMIN' : 'USER',
        },
      })
      usersCreated++
      continue
    }
    const fill: Partial<Record<(typeof PROFILE_FIELDS)[number], string>> = {}
    for (const f of PROFILE_FIELDS) {
      const db = existing[f]?.trim()
      if (!db) { if (p[f]?.trim()) fill[f] = p[f] }
      else if (p[f]?.trim() && db !== p[f].trim()) kept.push(`${p.email}.${f}`)
    }
    if (Object.keys(fill).length) {
      await prisma.user.update({ where: { email: p.email }, data: fill })
      usersFilled++
    }
  }
  console.log(`✓ team profiles: ${usersCreated} created, ${usersFilled} had blank field(s) filled, ${TEAM_PROFILES.length - usersCreated - usersFilled} untouched`)
  if (kept.length) {
    console.log(`[seed] team-profiles.ts differs from the DB for ${kept.length} field(s) — DB value kept (edit in /admin/permissions to change): ${kept.slice(0, 20).join(', ')}${kept.length > 20 ? ` … +${kept.length - 20}` : ''}`)
  }

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

// A failed seed must EXIT NON-ZERO: `.catch(console.error)` used to swallow it,
// so start.sh's `|| echo` never fired and new outlets/programs from data.ts were
// simply missing until the next boot. The `[seed] run failed` tag is what the
// Hermes log scan (BAD_RE) picks up. Boot still continues — start.sh's `||`.
main()
  .catch((e) => {
    console.error('[seed] run failed:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
