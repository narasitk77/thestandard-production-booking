'use client'

import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

/**
 * A real "back" button (v1.109): goes to the ACTUAL previous page via
 * router.back() so a detail page returns to whatever list you came from
 * (My Bookings, Dashboard, คิวงาน, …) instead of a hard-coded destination.
 * Falls back to `fallback` only when there's no in-app history (deep link /
 * fresh tab), so direct loads still have somewhere to go.
 */
export default function BackButton({
  fallback,
  label = 'กลับ',
  className = 'inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-2',
  iconClassName = 'w-4 h-4',
}: {
  fallback: string
  label?: string
  className?: string
  iconClassName?: string
}) {
  const router = useRouter()
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push(fallback)
  }
  return (
    <button type="button" onClick={goBack} className={className}>
      <ArrowLeft className={iconClassName} /> {label}
    </button>
  )
}
