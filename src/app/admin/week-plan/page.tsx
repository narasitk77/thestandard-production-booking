import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import WeekPlanClient from './WeekPlanClient'

export const dynamic = 'force-dynamic'

// Camera allocation planner for CONFIRMED shoots, by week. ADMIN-only — it reads
// the camera inventory (GET /api/admin/equipment is ADMIN-gated) and equipment is
// an ADMIN-hub concern, so the page + menu link + middleware all gate on ADMIN.
export default async function WeekPlanPage() {
  const session = await getSession()
  if (!session) redirect('/login?next=/admin/week-plan')
  if (session.role !== 'ADMIN') redirect('/admin')
  return <WeekPlanClient />
}
