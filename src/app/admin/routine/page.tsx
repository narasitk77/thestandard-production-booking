import RoutinePlanner from '@/app/_components/RoutinePlanner'

// /admin/routine — the dedicated Routine planner page. The same planner is also
// reachable as the "Routine" mode of /new (console only); both render the shared
// RoutinePlanner component (src/app/_components/RoutinePlanner.tsx).
export default function RoutinePlannerPage() {
  return <RoutinePlanner backHref="/admin" />
}
