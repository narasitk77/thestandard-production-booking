import { redirect } from 'next/navigation'
import { getSession, getOTApproverAccess } from '@/lib/session'
import { hasConsoleAccess } from '@/lib/roles'
import PurchasesClient from './PurchasesClient'

export const dynamic = 'force-dynamic'

// Buyer workspace = console staff; approval = manager (same gate as OT approval).
export default async function PurchasesPage() {
  const session = await getSession()
  if (!session) redirect('/login?next=/admin/purchases')
  if (!hasConsoleAccess(session.role)) redirect('/')
  const isApprover = await getOTApproverAccess(session.email)
  return <PurchasesClient currentEmail={session.email} isApprover={isApprover} />
}
