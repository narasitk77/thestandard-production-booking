/**
 * GET /api/review/demo?voice=client|crew — v1.173.6. The form, simulated.
 *
 * Why this exists: the only way to look at the review form used to be an invite
 * minted on a REAL booking, and submitting it wrote a real, permanent, un-
 * deletable rating of real colleagues. The operator opened one to inspect the
 * copy, sent it, and there was no undo — because append-only is the promise the
 * whole feature rests on. A test must not be able to do that.
 *
 * So this returns the same payload shape the token route returns, built from a
 * booking that does not exist. Nothing is read from the database and nothing can
 * be written back: the page that renders it never POSTs.
 *
 * Deliberately NOT session-gated. It contains no real data of any kind, and the
 * point is to be able to hand the link to someone and ask "does this read right?"
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  REVIEW_TARGET_ROLES, ANONYMITY_NOTICE_TH, targetsFor,
  OVERALL_TARGET, overallLabelFor,
} from '@/lib/review-access'
import { REVIEW_CRITERIA } from '@/lib/shoot-review'

export const dynamic = 'force-dynamic'

const ROLE_TH: Record<string, string> = Object.fromEntries(REVIEW_TARGET_ROLES.map(r => [r.key, r.th]))

/**
 * Every seat at the shoot, because the review is MUTUAL and each seat sees a
 * different form. Collapsing the crew into one "ฝั่งทีมงาน" hid the sound
 * engineer's view entirely — they rate the producer side and the camera team,
 * which is not what either other form shows.
 */
const SEATS: Record<string, { role: string; th: string }> = {
  producer: { role: 'producer', th: 'มุมมองโปรดิวเซอร์ / เจ้าของงาน' },
  camera: { role: 'camera', th: 'มุมมองทีมกล้อง' },
  sound: { role: 'sound', th: 'มุมมองทีมเสียง' },
  // v1.173.6 shipped with these two names; keep them working.
  client: { role: 'producer', th: 'มุมมองโปรดิวเซอร์ / เจ้าของงาน' },
  crew: { role: 'camera', th: 'มุมมองทีมกล้อง' },
}

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams
  const asked = (sp.get('role') || sp.get('voice') || 'producer').toLowerCase()
  const seat = SEATS[asked] ?? SEATS.producer
  const role = seat.role
  const targets = targetsFor(role, REVIEW_TARGET_ROLES.map(r => r.key))

  return NextResponse.json({
    demo: true,
    seat: role,
    booking: {
      code: 'DEMO-000000-01',
      shootDate: new Date().toISOString(),
      show: 'ฟอร์มจำลอง (ไม่ใช่งานจริง)',
      outlet: null,
      job: seat.th,
    },
    yourRole: role,
    targets: targets.map(k => ({ key: k, th: ROLE_TH[k] || k, answered: false })),
    overall: { key: OVERALL_TARGET, th: overallLabelFor(role), answered: false },
    criteria: REVIEW_CRITERIA,
    notice: ANONYMITY_NOTICE_TH,
    submittedAt: null,
  })
}
