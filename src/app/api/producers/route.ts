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
 *   ?outlet=NWS → { producers: [...], coProducers: [...] } for that outlet
 *   (no param)  → { byOutlet: { NWS: { producers, coProducers }, ... } }
 *
 * Each entry is { email, name, nickname }. Producer vs Co-Producer is decided
 * by User.position (anything matching /co.?produc/i is a Co-Producer). v1.59.
 *
 * Any logged-in user may read — the booking form is open to everyone.
 */
type Entry = { email: string; name: string; nickname: string }

function isCoProducer(position: string | null): boolean {
  return /co.?produc/i.test(position || '')
}

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
      select: { email: true, name: true, thaiName: true, nickname: true, position: true, producerOutlets: true },
      orderBy: [{ nickname: 'asc' }, { email: 'asc' }],
    })

    const toEntry = (u: { email: string; name: string | null; thaiName: string | null; nickname: string | null }): Entry => ({
      email: u.email,
      name: u.thaiName || u.name || u.email.split('@')[0],
      nickname: u.nickname || u.thaiName || u.name || u.email.split('@')[0],
    })

    if (outlet) {
      const producers: Entry[] = []
      const coProducers: Entry[] = []
      for (const u of users) (isCoProducer(u.position) ? coProducers : producers).push(toEntry(u))
      return NextResponse.json({ outlet, producers, coProducers })
    }

    const byOutlet: Record<string, { producers: Entry[]; coProducers: Entry[] }> = {}
    for (const u of users) {
      const e = toEntry(u)
      const co = isCoProducer(u.position)
      for (const code of u.producerOutlets) {
        const g = (byOutlet[code] ||= { producers: [], coProducers: [] })
        ;(co ? g.coProducers : g.producers).push(e)
      }
    }
    return NextResponse.json({ byOutlet })
  } catch (e) {
    console.error('GET /api/producers error:', e)
    return NextResponse.json({ error: 'Failed to load producers' }, { status: 500 })
  }
}
