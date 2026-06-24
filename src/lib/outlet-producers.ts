// v1.59.0 — Outlet Producer / Co-Producer seed.
//
// Source of truth: the "outlet DB" sheet the ops team maintains
// (1vuSt2XNUWxGeMTF1I1P5KNAqunBQQTolNxQBQe_T_Gg). Imported into the User table
// via POST /api/admin/import-producers so these people (a) get an account they
// can sign into with Google SSO and (b) populate the per-outlet Producer /
// Co-Producer dropdowns in the booking form (GET /api/producers).
//
// `role` drives which dropdown they appear in; `position` is stored on the
// User (also what producer-dashboard access keys off). Section/Department from
// the sheet maps to our outlet codes:
//   The Secret Sauce→TSS · Pop→POP · LIFE→LIF · Wealth→WLT · News Program→NWS
//   Podcast→POD · Video Production (Production/Platform)→AGN

export interface OutletProducerSeed {
  employeeId: string
  thaiName: string
  nickname: string
  email: string
  outlet: string            // outlet code this person produces for
  role: 'Producer' | 'Co-Producer' | 'Other'
  position: string          // stored on the User (normalized for dropdown roles)
}

export const OUTLET_PRODUCERS: OutletProducerSeed[] = [
  { employeeId: 'TSD00171', thaiName: 'นางสาวจตุพร ลัมยศ',        nickname: 'มิ้ง',  email: 'jatuphorn.l@thestandard.co', outlet: 'TSS', role: 'Co-Producer', position: 'Co-Producer' },
  { employeeId: 'TSD00301', thaiName: 'นางสาวอิงตะวัน สุวรรณสุภา', nickname: 'แพร',   email: 'ingtawan.s@thestandard.co',  outlet: 'TSS', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00236', thaiName: 'นางสาวชุติกาญจน์ ปิยะมังคลา', nickname: 'ขิม',  email: 'chutikarn.p@thestandard.co', outlet: 'POP', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00273', thaiName: 'นางสาวธัญศิริ ลิ่มสถาพร',   nickname: 'มีน',   email: 'thansiri.l@thestandard.co',  outlet: 'LIF', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00105', thaiName: 'นางสาวทิวาพร ปิ่นสุข',      nickname: 'ปิ่น',  email: 'thiwaporn.p@thestandard.co', outlet: 'WLT', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00108', thaiName: 'นายบุญญฤทธิ์ บัวขำ',        nickname: 'เค้ก',  email: 'boonyarit.b@thestandard.co', outlet: 'NWS', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00162', thaiName: 'นางสาวพิชญ์สินี ยงประพัฒน์', nickname: 'แอ๊นท์', email: 'pidsinee.y@thestandard.co',  outlet: 'WLT', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00192', thaiName: 'นายเตชนันต์ วิทยาสรรเพชร',  nickname: 'เติร์ก', email: 'techanan.w@thestandard.co',  outlet: 'WLT', role: 'Co-Producer', position: 'Co-Producer' },
  { employeeId: 'TSD00189', thaiName: 'นายศรุต อดิการิ',           nickname: 'ศรุต',  email: 'sarut.a@thestandard.co',     outlet: 'NWS', role: 'Producer',    position: 'Content Creator (The Standard NOW)' },
  // v1.96.0 — News Program producers added from the ops outlet-DB sheet (2026-06-24).
  { employeeId: 'TSD00133', thaiName: 'นางสาวสุธามาส ทวินันท์',     nickname: 'ข้าวฟ่าง', email: 'suthamat.t@thestandard.co', outlet: 'NWS', role: 'Producer',    position: 'Content Creator' },
  { employeeId: 'TSD00216', thaiName: 'นางสาวตรีนุช อิงคุทานนท์',   nickname: 'หนามเตย',  email: 'trinuch.i@thestandard.co',  outlet: 'NWS', role: 'Producer',    position: 'Content Creator' },
  { employeeId: 'TSD00037', thaiName: 'นางสาวอ้อมเทียน ทาระมัด',   nickname: 'อ้อม',  email: 'aomtian.t@thestandard.co',   outlet: 'AGN', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00131', thaiName: 'นางสาวอรทิชา ตั้งวรรณสิทธิ์', nickname: 'ซัง',   email: 'onticha.t@thestandard.co',   outlet: 'AGN', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00271', thaiName: 'นางสาวณัฐชยา กาฬสิงห์',     nickname: 'ไนซ์',  email: 'natchaya.k@thestandard.co',  outlet: 'AGN', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00095', thaiName: 'นางสาวกมลวรรณ ลาภบุญอุดม',  nickname: 'ดรีม',  email: 'kamonwan.l@thestandard.co',  outlet: 'AGN', role: 'Other',       position: 'Switcher' },
  { employeeId: 'TSD00318', thaiName: 'นายอธิษฐาน กาญจนะพงศ์',     nickname: 'ฝัน',   email: 'atisthan.k@thestandard.co',  outlet: 'POD', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00123', thaiName: 'นายพันธวัฒน์ เศรษฐวิไล',    nickname: 'ใหญ่',  email: 'phantawat.s@thestandard.co', outlet: 'POD', role: 'Producer',    position: 'Producer' },
]
