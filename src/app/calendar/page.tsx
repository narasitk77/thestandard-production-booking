export default function CalendarPage() {
  const calendarId = 'c_74ba4f943e365bd8f8c6617c188f7e2bf1efbe17701f7c6908d620260ef9ce0c%40group.calendar.google.com'
  const src = `https://calendar.google.com/calendar/embed?src=${calendarId}&ctz=Asia%2FBangkok&showTitle=0&showNav=1&showDate=1&showPrint=0&showTabs=1&showCalendars=0&mode=WEEK`

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-normal text-gray-800">Production Calendar</h1>
          <p className="text-sm text-gray-500">Confirmed bookings · Asia/Bangkok</p>
        </div>
        <a href="/admin" className="gf-link text-sm">Admin Console →</a>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <iframe
          src={src}
          style={{ border: 0 }}
          width="100%"
          height="700"
          frameBorder="0"
          scrolling="no"
          title="THE STANDARD Production Calendar"
        />
      </div>

      <p className="text-xs text-gray-400 mt-3 text-center">
        Events appear after Admin approves a booking. Timezone: Asia/Bangkok (ICT)
      </p>
    </div>
  )
}
