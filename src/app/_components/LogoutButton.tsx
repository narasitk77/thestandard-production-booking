'use client'

import { signOut } from 'next-auth/react'

export default function LogoutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: '/login' })}
      className="text-xs text-gray-500 hover:text-red-600"
    >
      Sign out
    </button>
  )
}
