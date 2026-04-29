// Thai public holidays — sourced from Thai gov calendar (en.th#holiday@group.v.calendar.google.com)
// Update yearly. Add substitute days when holiday falls on weekend.

export interface Holiday {
  date: string  // YYYY-MM-DD
  name: string
  nameEn: string
  substitute?: boolean
}

export const THAI_HOLIDAYS: Holiday[] = [
  // ── 2026
  { date: '2026-01-01', name: 'วันขึ้นปีใหม่',                  nameEn: "New Year's Day" },
  { date: '2026-01-02', name: 'วันหยุดชดเชย',                  nameEn: 'Substitute Holiday', substitute: true },
  { date: '2026-02-12', name: 'วันมาฆบูชา',                     nameEn: 'Makha Bucha Day' },
  { date: '2026-04-06', name: 'วันจักรี',                        nameEn: 'Chakri Memorial Day' },
  { date: '2026-04-13', name: 'วันสงกรานต์',                    nameEn: 'Songkran Festival' },
  { date: '2026-04-14', name: 'วันสงกรานต์',                    nameEn: 'Songkran Festival' },
  { date: '2026-04-15', name: 'วันสงกรานต์',                    nameEn: 'Songkran Festival' },
  { date: '2026-05-01', name: 'วันแรงงานแห่งชาติ',             nameEn: 'National Labour Day' },
  { date: '2026-05-04', name: 'วันฉัตรมงคล',                    nameEn: 'Coronation Day' },
  { date: '2026-05-11', name: 'วันวิสาขบูชา',                   nameEn: 'Visakha Bucha Day' },
  { date: '2026-06-03', name: 'วันเฉลิมพระชนมพรรษาพระราชินี', nameEn: "Queen Suthida's Birthday" },
  { date: '2026-07-28', name: 'วันเฉลิมพระชนมพรรษา ร.10',     nameEn: "King Vajiralongkorn's Birthday" },
  { date: '2026-07-29', name: 'วันอาสาฬหบูชา',                  nameEn: 'Asahna Bucha Day' },
  { date: '2026-07-30', name: 'วันเข้าพรรษา',                    nameEn: 'Buddhist Lent Day' },
  { date: '2026-08-12', name: 'วันแม่แห่งชาติ',                   nameEn: "Mother's Day" },
  { date: '2026-10-13', name: 'วันคล้ายวันสวรรคต ร.9',          nameEn: 'King Bhumibol Memorial Day' },
  { date: '2026-10-23', name: 'วันปิยมหาราช',                   nameEn: 'Chulalongkorn Day' },
  { date: '2026-12-07', name: 'วันหยุดชดเชย วันเฉลิม ร.9',     nameEn: "Substitute King Bhumibol's Birthday", substitute: true },
  { date: '2026-12-10', name: 'วันรัฐธรรมนูญ',                   nameEn: 'Constitution Day' },
  { date: '2026-12-31', name: 'วันสิ้นปี',                        nameEn: "New Year's Eve" },
]

const HOLIDAY_DATES = new Set(THAI_HOLIDAYS.map(h => h.date))

function dateKey(date: Date | string): string {
  if (typeof date === 'string') return date.slice(0, 10)
  // Use local date components (we treat shoot dates as local Bangkok dates)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isThaiHoliday(date: Date | string): boolean {
  return HOLIDAY_DATES.has(dateKey(date))
}

export function getHolidayName(date: Date | string): string | null {
  const found = THAI_HOLIDAYS.find(h => h.date === dateKey(date))
  return found ? found.name : null
}
