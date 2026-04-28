'use client'

import { useEffect } from 'react'
import Link from 'next/link'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Global error:', error)
  }, [error])

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="gf-card p-6">
        <h1 className="text-xl font-medium text-red-600 mb-2">Something went wrong</h1>
        <p className="text-sm text-gray-600 mb-3">{error.message || 'Unknown error'}</p>
        {error.digest && (
          <p className="text-xs text-gray-400 mb-4">Digest: {error.digest}</p>
        )}
        {error.stack && (
          <details className="mb-4">
            <summary className="text-xs text-gray-500 cursor-pointer">Stack trace</summary>
            <pre className="text-xs bg-gray-50 p-3 rounded mt-2 overflow-auto whitespace-pre-wrap">
              {error.stack}
            </pre>
          </details>
        )}
        <div className="flex gap-2">
          <button onClick={reset} className="gf-submit text-sm">Try again</button>
          <Link href="/admin" className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">
            Back to Admin
          </Link>
        </div>
      </div>
    </div>
  )
}
