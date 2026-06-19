'use client'

// Route-level error boundary for the booking wizard. The wizard autosaves a
// draft to localStorage, so if a render throws the user's input isn't lost —
// reassure them and offer a retry (which re-mounts and shows the resume prompt).
export default function NewBookingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="max-w-md mx-auto px-4 py-16 text-center">
      <h1 className="text-lg font-medium text-gray-800 mb-2">เกิดข้อผิดพลาดในหน้าจองคิว</h1>
      <p className="text-sm text-gray-500 mb-1">ฉบับร่างของคุณถูกบันทึกไว้อัตโนมัติแล้ว — กด “ลองใหม่” เพื่อทำต่อ</p>
      <p className="text-xs text-gray-400 mb-6 break-words">{error?.message || 'Unknown error'}</p>
      <div className="flex items-center justify-center gap-2">
        <button onClick={reset} className="px-4 py-2 text-sm rounded bg-[#673ab7] text-white hover:bg-[#5e35b1]">ลองใหม่</button>
        <a href="/" className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50">กลับหน้าแรก</a>
      </div>
    </div>
  )
}
