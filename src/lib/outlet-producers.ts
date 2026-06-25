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
//   Event→EVT · Project Management Office→PM   (v1.99.0)

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
  { employeeId: 'TSD00256', thaiName: 'นางสาวปภัสรา เพ็ชร์ณรงค์',   nickname: 'พีช',    email: 'papassara.p@thestandard.co', outlet: 'NWS', role: 'Producer',    position: 'Content Creator' },
  { employeeId: 'TSD00037', thaiName: 'นางสาวอ้อมเทียน ทาระมัด',   nickname: 'อ้อม',  email: 'aomtian.t@thestandard.co',   outlet: 'AGN', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00131', thaiName: 'นางสาวอรทิชา ตั้งวรรณสิทธิ์', nickname: 'ซัง',   email: 'onticha.t@thestandard.co',   outlet: 'AGN', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00271', thaiName: 'นางสาวณัฐชยา กาฬสิงห์',     nickname: 'ไนซ์',  email: 'natchaya.k@thestandard.co',  outlet: 'AGN', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00095', thaiName: 'นางสาวกมลวรรณ ลาภบุญอุดม',  nickname: 'ดรีม',  email: 'kamonwan.l@thestandard.co',  outlet: 'AGN', role: 'Other',       position: 'Switcher' },
  { employeeId: 'TSD00318', thaiName: 'นายอธิษฐาน กาญจนะพงศ์',     nickname: 'ฝัน',   email: 'atisthan.k@thestandard.co',  outlet: 'POD', role: 'Producer',    position: 'Producer' },
  { employeeId: 'TSD00123', thaiName: 'นายพันธวัฒน์ เศรษฐวิไล',    nickname: 'ใหญ่',  email: 'phantawat.s@thestandard.co', outlet: 'POD', role: 'Producer',    position: 'Producer' },
  // v1.99.0 — Event team (outlet EVT) from the ops outlet-DB sheet (2026-06-25).
  { employeeId: 'TSD00190', thaiName: 'นายรัชชานนท์ คงเนตร',     nickname: 'ลูกหมู',  email: 'ratchanon.k@thestandard.co',     outlet: 'EVT', role: 'Producer',    position: 'Event Producer' },
  { employeeId: 'TSD00199', thaiName: 'นางสาวภัทรวดี อ่อนสำลี',   nickname: 'มุก',     email: 'phattarawadee.o@thestandard.co', outlet: 'EVT', role: 'Producer',    position: 'Event Producer' },
  { employeeId: 'TSD00309', thaiName: 'นายภคิน อออิปก',          nickname: 'อาร์ม',   email: 'pakin.o@thestandard.co',         outlet: 'EVT', role: 'Producer',    position: 'Event Producer' },
  { employeeId: 'TSD00237', thaiName: 'นางสาวฐิตาพร ด่านวันดี',   nickname: 'พลอยดี',  email: 'thitaporn.d@thestandard.co',     outlet: 'EVT', role: 'Co-Producer', position: 'Co-Producer' },
  { employeeId: 'TSD00241', thaiName: 'นางสาวธนัชพร นาสา',       nickname: 'นาเดียร์', email: 'thanutchaporn.n@thestandard.co', outlet: 'EVT', role: 'Co-Producer', position: 'Co-Producer' },
  { employeeId: 'TSD00285', thaiName: 'นางสาวอารียา นิระภัย',     nickname: 'แอม',     email: 'areeya.n@thestandard.co',        outlet: 'EVT', role: 'Co-Producer', position: 'Co-Producer' },
  { employeeId: 'TSD00305', thaiName: 'นายพีรพัฒน์ หมอเก่ง',     nickname: 'มิกซ์',   email: 'peeraphat.m@thestandard.co',     outlet: 'EVT', role: 'Co-Producer', position: 'Co-Producer' },
  // v1.99.0 — Project Management Office (outlet PM). Managers→Producer, Coordinators→Co-Producer.
  { employeeId: 'TSD00112', thaiName: 'นางสาวศุภวษา ศรีหนองโคตร', nickname: 'วิว',     email: 'supawasa.s@thestandard.co',      outlet: 'PM', role: 'Producer',    position: 'Project Manager' },
  { employeeId: 'TSD00205', thaiName: 'นางสาวนนทกร ธุวะชาวสวน',   nickname: 'ใบเฟิร์น', email: 'nonthakorn.t@thestandard.co',    outlet: 'PM', role: 'Producer',    position: 'Project Manager' },
  { employeeId: 'TSD00230', thaiName: 'นางสาวภัทรธิดา สุวรรณประทีป', nickname: 'รวงข้าว', email: 'phattharatida.s@thestandard.co', outlet: 'PM', role: 'Producer',    position: 'Project Manager' },
  { employeeId: 'TSD00266', thaiName: 'นายบริพัฒน์ เยาวพันธ์',    nickname: 'บอริ',    email: 'boriphat.y@thestandard.co',      outlet: 'PM', role: 'Producer',    position: 'Project Manager' },
  { employeeId: 'TSD00278', thaiName: 'นายธีรพงษ์ ศิริวิทย์ภักดีกุล', nickname: 'เอ',    email: 'theeraphong.s@thestandard.co',   outlet: 'PM', role: 'Producer',    position: 'Project Manager' },
  { employeeId: 'TSD00322', thaiName: 'นายโอฬาร อุ่ยพัฒน์',      nickname: 'ขิม',     email: 'olan.a@thestandard.co',          outlet: 'PM', role: 'Producer',    position: 'Project Manager' },
  { employeeId: 'TSD00117', thaiName: 'นางสาวอาทิตยา อิสสรานุสรณ์', nickname: 'ต้นอ้อ', email: 'artitaya.i@thestandard.co',      outlet: 'PM', role: 'Co-Producer', position: 'Project Coordinator' },
  { employeeId: 'TSD00284', thaiName: 'นางสาวพัชร์ณิษา เอกหิรัญวรพงษ์', nickname: 'เพิรล', email: 'phatnisa.a@thestandard.co',  outlet: 'PM', role: 'Co-Producer', position: 'Project Coordinator' },
  { employeeId: 'TSD00296', thaiName: 'นางสาวธนัชพร ใจหวัง',     nickname: 'ใยไหม',   email: 'tanatchaporn.j@thestandard.co',  outlet: 'PM', role: 'Co-Producer', position: 'Project Coordinator' },
  { employeeId: 'TSD00298', thaiName: 'นางสาววรปรีย์ คร้ามสมอ',  nickname: 'มะเหมี่ยว', email: 'worrapree.k@thestandard.co',   outlet: 'PM', role: 'Co-Producer', position: 'Project Coordinator' },
]
