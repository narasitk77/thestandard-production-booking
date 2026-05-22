import fs from 'fs'
import path from 'path'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export const metadata = {
  title: 'Changelog — Production Booking',
}

// Read the repo CHANGELOG.md at build time (it's COPY'd into the image) and
// render it. Single source of truth — no separate copy to maintain.
export default function ChangelogPage() {
  let content = ''
  try {
    content = fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8')
  } catch {
    content = '# Changelog not found'
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-4">
        <h1 className="text-2xl sm:text-3xl font-normal text-gray-800">อัปเดตระบบ · Changelog</h1>
        <p className="text-sm text-gray-500 mt-1">
          รายการการเปลี่ยนแปลงของระบบ Production Booking แต่ละเวอร์ชัน (ใหม่สุดอยู่บน)
        </p>
      </div>
      <div className="gf-card p-6 md:p-10 manual-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => <h1 className="text-2xl font-normal text-gray-800 mt-2 mb-3 pb-3 border-b border-gray-200">{children}</h1>,
            // Version headers — make them stand out as section dividers.
            h2: ({ children }) => <h2 className="text-xl font-medium text-[#673ab7] mt-8 mb-3 pb-2 border-b border-gray-100">{children}</h2>,
            h3: ({ children }) => <h3 className="text-base font-semibold text-gray-800 mt-5 mb-2">{children}</h3>,
            h4: ({ children }) => <h4 className="text-sm font-medium text-gray-700 mt-4 mb-1.5">{children}</h4>,
            p: ({ children }) => <p className="text-sm text-gray-700 leading-relaxed mb-3">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-6 text-sm text-gray-700 space-y-1 mb-3">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-6 text-sm text-gray-700 space-y-1 mb-3">{children}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            strong: ({ children }) => <strong className="font-medium text-gray-900">{children}</strong>,
            code: ({ children }) => <code className="bg-gray-100 text-[#673ab7] px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>,
            pre: ({ children }) => <pre className="bg-gray-50 border border-gray-200 rounded p-3 text-xs font-mono overflow-x-auto mb-3">{children}</pre>,
            blockquote: ({ children }) => <blockquote className="border-l-4 border-yellow-300 bg-yellow-50 pl-4 py-2 my-3 text-sm text-gray-700">{children}</blockquote>,
            a: ({ href, children }) => <a href={href} className="text-[#673ab7] hover:underline" target="_blank" rel="noopener">{children}</a>,
            hr: () => <hr className="my-6 border-gray-200" />,
            table: ({ children }) => <div className="overflow-x-auto my-3"><table className="min-w-full text-sm border border-gray-200">{children}</table></div>,
            thead: ({ children }) => <thead className="bg-gray-50">{children}</thead>,
            th: ({ children }) => <th className="text-left px-3 py-2 text-xs font-medium text-gray-600 border-b border-gray-200">{children}</th>,
            td: ({ children }) => <td className="px-3 py-2 text-gray-700 border-b border-gray-100 align-top">{children}</td>,
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
