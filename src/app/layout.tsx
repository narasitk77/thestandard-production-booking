import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'THE STANDARD — Production Booking',
  description: 'Production Pipeline: Booking to Episode ID to Folder',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="th">
      <body className={inter.className}>
        <div className="min-h-screen flex flex-col">
          <header className="bg-brand-black text-white sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between h-14">
                <a href="/" className="flex items-center gap-3">
                  <span className="text-brand-gold font-bold text-lg tracking-tight">THE STANDARD</span>
                  <span className="text-brand-gray-400 text-sm hidden sm:block">Production Booking</span>
                </a>
                <nav className="flex items-center gap-1">
                  <a
                    href="/"
                    className="px-3 py-1.5 text-sm text-brand-gray-300 hover:text-white hover:bg-brand-gray-800 rounded-md transition-colors"
                  >
                    Book
                  </a>
                  <a
                    href="/dashboard"
                    className="px-3 py-1.5 text-sm text-brand-gray-300 hover:text-white hover:bg-brand-gray-800 rounded-md transition-colors"
                  >
                    Dashboard
                  </a>
                  <a
                    href="/upload"
                    className="px-3 py-1.5 text-sm text-brand-gray-300 hover:text-white hover:bg-brand-gray-800 rounded-md transition-colors"
                  >
                    Upload
                  </a>
                </nav>
              </div>
            </div>
          </header>
          <main className="flex-1">{children}</main>
          <footer className="bg-brand-black text-brand-gray-500 text-xs py-4 text-center">
            <div className="max-w-7xl mx-auto px-4">
              THE STANDARD Production Pipeline · Phase 1 · v1.0.0
            </div>
          </footer>
        </div>
      </body>
    </html>
  )
}
