import fs from 'fs'
import path from 'path'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export const metadata = {
  title: 'คู่มือการใช้งาน — Production Booking',
}

export default function ManualPage() {
  let content = ''
  try {
    content = fs.readFileSync(path.join(process.cwd(), 'USER_MANUAL_TH.md'), 'utf8')
  } catch {
    content = '# Manual not found'
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="gf-card p-6 md:p-10 manual-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => <h1 className="text-3xl font-normal text-gray-800 mt-2 mb-3 pb-3 border-b border-gray-200">{children}</h1>,
            h2: ({ children }) => <h2 className="text-2xl font-medium text-gray-800 mt-8 mb-3">{children}</h2>,
            h3: ({ children }) => <h3 className="text-lg font-medium text-gray-700 mt-6 mb-2">{children}</h3>,
            h4: ({ children }) => <h4 className="text-base font-medium text-gray-700 mt-4 mb-2">{children}</h4>,
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
