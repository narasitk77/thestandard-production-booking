import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Production Booking — THE STANDARD',
  description: 'ระบบ Production Booking ของ THE STANDARD',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <nav className="bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between text-sm">
          <span className="text-gray-600 font-medium">THE STANDARD · Production</span>
          <div className="flex gap-4">
            <a href="/dashboard" className="gf-link">Dashboard</a>
            <a href="/upload" className="gf-link">Upload Footage</a>
          </div>
        </nav>
        {children}
      </body>
    </html>
  )
}
