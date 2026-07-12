import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import WeekPlanClient from './WeekPlanClient'

export const dynamic = 'force-dynamic'

// Week Plan — weekly gear-notes board for CONFIRMED shoots (v1.144 replaced the
// camera-chip allocator with free-text อุปกรณ์/เช่า fields; see WeekPlanClient).
// ADMIN-only: every debounced save PATCHes the booking (background calendar
// re-sync) and the legacy camera-name lookup reads the ADMIN-gated equipment API.
export default async function WeekPlanPage() {
  const session = await getSession()
  if (!session) redirect('/login?next=/admin/week-plan')
  if (session.role !== 'ADMIN') redirect('/admin')
  return <WeekPlanClient />
}
