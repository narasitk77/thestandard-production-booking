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

export async function GET(request: NextRequest) {
  const voice = new URL(request.url).searchParams.get('voice') === 'crew' ? 'crew' : 'client'
  // The two sides of the mutual review, exactly as buildInvites would assign
  // them: the producer's side rates the crew teams, the crew rates the producer
  // side (and the other crew team).
  const role = voice === 'crew' ? 'camera' : 'producer'
  const targets = targetsFor(role, REVIEW_TARGET_ROLES.map(r => r.key))

  return NextResponse.json({
    demo: true,
    voice,
    booking: {
      code: 'DEMO-000000-01',
      shootDate: new Date().toISOString(),
      show: 'ฟอร์มจำลอง (ไม่ใช่งานจริง)',
      outlet: null,
      job: voice === 'crew' ? 'มุมมองทีมงาน' : 'มุมมองโปรดิวเซอร์',
    },
    yourRole: role,
    targets: targets.map(k => ({ key: k, th: ROLE_TH[k] || k, answered: false })),
    overall: { key: OVERALL_TARGET, th: overallLabelFor(role), answered: false },
    criteria: REVIEW_CRITERIA,
    notice: ANONYMITY_NOTICE_TH,
    submittedAt: null,
  })
}
