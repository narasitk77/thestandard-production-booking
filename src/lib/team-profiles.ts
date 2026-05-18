// THE STANDARD Production team — used to seed User profiles for OT module
// Source: HR roster (รายชื่อ Production Team) + OT cover sheet 02/2026

export interface TeamProfile {
  email: string
  thaiName: string
  employeeId: string
  position: string
}

export const TEAM_PROFILES: TeamProfile[] = [
  { email: 'songpol.c@thestandard.co',     thaiName: 'ทรงพล จั่นลา',         employeeId: 'TSD00036', position: 'Creative Specialist' },
  { email: 'aomtian.t@thestandard.co',     thaiName: 'อ้อมเทียน ทาระมัด',     employeeId: 'TSD00037', position: 'Producer' },
  { email: 'panu.w@thestandard.co',        thaiName: 'ภาณุ วิวัฒฑนาภา',       employeeId: 'TSD00039', position: 'Head of Video Director' },
  { email: 'chonlathorn.j@thestandard.co', thaiName: 'ชลธร จารุสุวรรณวงค์',   employeeId: 'TSD00052', position: 'Video Production Manager' },
  { email: 'tossapol.b@thestandard.co',    thaiName: 'ทศพล บุญคง',           employeeId: 'TSD00054', position: 'Production Coordinator' },
  { email: 'saluk.k@thestandard.co',       thaiName: 'สลัก แก้วเชื้อ',          employeeId: 'TSD00058', position: 'Photographer' },
  { email: 'krittapon.j@thestandard.co',   thaiName: 'กฤตพล จียะเกียรติ',     employeeId: 'TSD00065', position: 'Senior Sound Engineer' },
  { email: 'assawapol.t@thestandard.co',   thaiName: 'อัศวพล ตุลานนท์',       employeeId: 'TSD00066', position: 'Virtual Production Developer' },
  { email: 'nuttapong.k@thestandard.co',   thaiName: 'ณัฐพงษ์ กุลพันธ์',       employeeId: 'TSD00067', position: 'Videographer' },
  { email: 'daejarnat.d@thestandard.co',   thaiName: 'เดชาณัฏฐ์ ธีรดุริยสฤษฏ์', employeeId: 'TSD00074', position: 'Sound Engineer' },
  { email: 'sakdipat.p@thestandard.co',    thaiName: 'ศักดิภัท ประพันธ์วรคุณ',  employeeId: 'TSD00083', position: 'Videographer' },
  { email: 'thanakorn.s@thestandard.co',   thaiName: 'ธนกร ศักดิ์มณีกุล',       employeeId: 'TSD00092', position: 'Videographer' },
  { email: 'kamonwan.l@thestandard.co',    thaiName: 'กมลวรรณ ลาภบุญอุดม',   employeeId: 'TSD00095', position: 'Switcher' },
  { email: 'tanapak.I@thestandard.co',     thaiName: 'ธนภาคย์ อิทธิชัยพล',     employeeId: 'TSD00113', position: 'Video Director' },
  { email: 'thaphat.t@thestandard.co',     thaiName: 'ธภัทร ตั้งวงษ์ไชย',      employeeId: 'TSD00118', position: 'Sound Recorder' },
  { email: 'phuridej.p@thestandard.co',    thaiName: 'ภูริเดช พันธ์วิบูลย์',     employeeId: 'TSD00129', position: 'Videographer' },
  { email: 'onticha.t@thestandard.co',     thaiName: 'อรทิชา ตั้งวรรณสิทธิ์',  employeeId: 'TSD00131', position: 'Producer' },
  { email: 'narasit.k@thestandard.co',     thaiName: 'นราสิทธิ์ เกษาประสิทธิ์',  employeeId: 'TSD00142', position: 'Production Administrator' },
  { email: 'panathorn.c@thestandard.co',   thaiName: 'พนาธร ไชยกุล',         employeeId: 'TSD00152', position: 'Videographer' },
  { email: 'worased.p@thestandard.co',     thaiName: 'วรเศรษฐ์ ผลเจริญพงศ์',  employeeId: 'TSD00202', position: 'Video Director' },
  { email: 'kitti.k@thestandard.co',       thaiName: 'กิตติ คล้ายเกิด',         employeeId: 'TSD00233', position: 'Video Editor' },
  { email: 'ratchaseth.c@thestandard.co',  thaiName: 'รัชเศรษฐ์ ชวัลปัญญวัฒน์', employeeId: 'TSD00240', position: 'Videographer' },
  { email: 'panyapohn.s@thestandard.co',   thaiName: 'ปัญญาภรณ์ สมบัตินิมิตร', employeeId: 'TSD00255', position: 'Video Director' },
  { email: 'natchaya.k@thestandard.co',    thaiName: 'ณัฐชยา กาฬสิงห์',       employeeId: 'TSD00271', position: 'Producer' },
  { email: 'jaruwan.k@thestandard.co',     thaiName: 'จารุวรรณ ไกรลาศ',       employeeId: 'TSD00272', position: 'Switcher' },
  { email: 'wachirawit.t@thestandard.co',  thaiName: 'วชิรวิทย์ เตมียกุล',      employeeId: 'TSD00286', position: 'Video Editor' },
  { email: 'date.p@thestandard.co',        thaiName: 'เดช พันธุ์ประเสริฐ',     employeeId: 'TSD00287', position: 'Video Editor' },
  { email: 'nuthkitta.c@thestandard.co',   thaiName: 'ณัฏฐ์กฤตา ฉิมบุญ',      employeeId: 'TSD00291', position: 'Sound Recorder' },
  { email: 'chaiyaphat.t@thestandard.co',  thaiName: 'ชัยภัทร ทศภักดี',        employeeId: 'TSD00299', position: 'Videographer' },
  { email: 'natheephat.s@thestandard.co',  thaiName: 'ณธีพัฒน์ สุขธนาวิเชาว์', employeeId: 'TSD00307', position: 'Media Asset Management Officer' },
  { email: 'watcharapol.c@thestandard.co', thaiName: 'วัชรพล ชัยมงคล',        employeeId: 'TSD00308', position: 'Videographer' },
]

export function findProfileByEmail(email: string): TeamProfile | undefined {
  return TEAM_PROFILES.find(p => p.email.toLowerCase() === email.toLowerCase())
}

// True if the email belongs to the Production team roster — used to gate the
// OT module (menu + /ot pages) to team members only.
export function isTeamMember(email: string | null | undefined): boolean {
  if (!email) return false
  const lower = email.toLowerCase()
  return TEAM_PROFILES.some(p => p.email.toLowerCase() === lower)
}
