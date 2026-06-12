import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { OUTLET_MAP } from '@/lib/data'

export const dynamic = 'force-dynamic'

/**
 * GET /api/producers — v1.54.0. Producer dropdown data, per outlet.
 *
 * Source: active Users tagged with outlet codes in `producerOutlets`
 * (managed on /admin/permissions). Built so the booking form's free-text
 * Producer fields can become a dropdown per outlet.
 *
 *   ?outlet=NWS → { producers: [{ email, name }] } for that outlet
 *   (no param)  → { byOutlet: { NWS: [...], POP: [...], ... } } full map
 *
 * Any logged-in user may read — the booking form is open to everyone.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const outlet = new URL(request.url).searchParams.get('outlet')?.trim().toUpperCase() || null
    if (outlet && !OUTLET_MAP[outlet]) {
      return NextResponse.json({ error: `Unknown outlet code: ${outlet}` }, { status: 400 })
    }

    const users = await prisma.user.findMany({
      where: {
        active: true,
        ...(outlet
          ? { producerOutlets: { has: outlet } }
          : { producerOutlets: { isEmpty: false } }),
      },
      select: { email: true, name: true, thaiName: true, producerOutlets: true },
      orderBy: { email: 'asc' },
    })

    const toEntry = (u: { email: string; name: string | null; thaiName: string | null }) => ({
      email: u.email,
      name: u.thaiName || u.name || u.email.split('@')[0],
    })

    if (outlet) {
      return NextResponse.json({ outlet, producers: users.map(toEntry) })
    }

    const byOutlet: Record<string, Array<{ email: string; name: string }>> = {}
    for (const u of users) {
      for (const code of u.producerOutlets) {
        ;(byOutlet[code] ||= []).push(toEntry(u))
      }
    }
    return NextResponse.json({ byOutlet })
  } catch (e) {
    console.error('GET /api/producers error:', e)
    return NextResponse.json({ error: 'Failed to load producers' }, { status: 500 })
  }
}
