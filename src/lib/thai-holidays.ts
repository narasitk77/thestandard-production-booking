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

  // ── 2027 — **ยังไม่ครบ** ครม. ยังไม่ประกาศปฏิทินวันหยุด 2027 (เช็ก 2026-09-23)
  // ใส่เฉพาะวันที่แน่นอนโดยไม่ต้องรอประกาศ · วันจันทรคติ (มาฆบูชา วิสาขบูชา
  // อาสาฬหบูชา เข้าพรรษา) และวันชดเชยทั้งหมด **ยังขาด** — ห้ามเดา
  // พอ ครม. ประกาศแล้วเติมให้ครบ แล้วลบคอมเมนต์นี้
  { date: '2027-01-01', name: 'วันขึ้นปีใหม่',                    nameEn: "New Year's Day" },
]

const HOLIDAY_DATES = new Set(THAI_HOLIDAYS.map(h => h.date))

/**
 * ปีที่ตารางนี้ครอบคลุม **ครบทั้งปี** — ใช้บอกว่า "ไม่ใช่วันหยุด" เชื่อได้หรือเปล่า
 *
 * เขียนมือ ห้าม derive จาก THAI_HOLIDAYS — ถ้า derive แล้วปีไหนมีสักวันเดียว
 * (เช่น 2027 ที่มีแต่ 1 ม.ค.) จะถูกนับว่าครบทั้งปีทันที คำเตือนก็เลยเงียบ
 * ตรงจุดที่ควรดังที่สุด · เติมปีใหม่ที่นี่ **หลัง** ลงวันครบแล้วเท่านั้น
 */
const COVERED_YEARS = new Set(['2026'])

/**
 * ตารางนี้ครอบคลุมปีนั้นหรือยัง
 *
 * WHY. `isThaiHoliday()` คืน false ทั้งกับ "วันนั้นไม่ใช่วันหยุด" และ "ไม่มีข้อมูล
 * ปีนั้นเลย" — สองอย่างนี้ต่างกันสิ้นเชิงแต่หน้าตาเหมือนกัน ตอนสร้างงาน routine
 * ข้ามปี `skipHolidays: true` จะดู "ทำงานอยู่" ทั้งที่ไม่ได้ข้ามอะไรเลยสักวัน
 * (เจอ 2026-09-23 ตอนจะต่ออายุ Now ถึง มี.ค. 2027 — ตารางมีแต่ปี 2026)
 *
 * ผู้เรียกที่ตัดสินใจจากวันหยุด **ต้องเช็กตัวนี้ก่อน** แล้วบอกคนใช้ให้รู้
 * ว่าช่วงไหนไม่มีข้อมูล — เงียบไว้แปลว่าคนกดจะเชื่อว่าข้ามให้แล้ว
 */
export function holidayYearCovered(year: number | string): boolean {
  return COVERED_YEARS.has(String(year))
}

/** ปีที่ยังไม่มีข้อมูลในช่วงวันที่ให้มา (inclusive, YYYY-MM-DD) */
export function uncoveredHolidayYears(startDate: string, endDate: string): string[] {
  // ต้องเป็นปี 4 หลักจริง ๆ — Number('') คือ 0 ซึ่ง finite เลยหลุด isFinite ไปได้
  // แล้วคืน ['0'] ออกมาเป็นคำเตือนที่อ่านไม่รู้เรื่อง (เทสจับได้ v1.234)
  if (!/^\d{4}-/.test(startDate) || !/^\d{4}-/.test(endDate)) return []
  const from = Number(startDate.slice(0, 4))
  const to = Number(endDate.slice(0, 4))
  if (to < from) return []
  const out: string[] = []
  for (let y = from; y <= to; y++) if (!COVERED_YEARS.has(String(y))) out.push(String(y))
  return out
}

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
