export interface Program {
  code: string
  name: string
  category: 'Recurring' | 'Short-form' | 'One-off/Event' | 'Long-form' | 'Album'
  notes?: string
}

export interface Outlet {
  code: string
  name: string
  description: string
  color: string
  bgColor: string
  borderColor: string
  sort: number
  programs: Program[]
}

export const OUTLETS: Outlet[] = [
  {
    code: 'NWS',
    name: 'News',
    description: 'ข่าว',
    color: 'text-blue-700',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    sort: 1,
    programs: [
      { code: 'DTW', name: 'Decoding the World (ถอดรหัสโลก)', category: 'Recurring' },
      { code: 'ENG', name: 'End Game', category: 'Recurring' },
      { code: 'GLF', name: 'Global Focus', category: 'Recurring' },
      { code: 'KYM', name: 'Key Message', category: 'Recurring' },
      { code: 'NDG', name: 'News Digest', category: 'Recurring' },
      { code: 'TSN', name: 'THE STANDARD NOW', category: 'Recurring' },
      { code: 'TWD', name: 'The World Dialogue', category: 'Recurring', notes: 'รายการใหม่' },
      { code: 'UNC', name: 'Uncover', category: 'Recurring' },
    ],
  },
  {
    code: 'WLT',
    name: 'Wealth',
    description: 'การเงิน การลงทุน',
    color: 'text-emerald-700',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
    sort: 2,
    programs: [
      { code: 'EXI', name: 'Exclusive Interview', category: 'Recurring' },
      { code: 'MNW', name: 'Morning Wealth', category: 'Recurring', notes: 'Daily flagship' },
      { code: 'NGI', name: 'New Gen Investor', category: 'Recurring' },
      { code: 'WHP', name: 'Wealth Happen', category: 'Recurring' },
      { code: 'WHS', name: 'Wealth History', category: 'Recurring' },
    ],
  },
  {
    code: 'SPT',
    name: 'Sport',
    description: 'กีฬา',
    color: 'text-orange-700',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
    sort: 3,
    programs: [
      { code: 'ICS', name: 'ICONSPEAK', category: 'Recurring', notes: 'รายการใหม่' },
      { code: 'IVA', name: 'Interview นักกีฬา', category: 'Recurring', notes: 'รายการใหม่' },
      { code: 'LFS', name: 'Lifestyle', category: 'Recurring', notes: 'รายการใหม่' },
      { code: 'SIC', name: 'Sport ICON', category: 'Recurring', notes: 'รายการใหม่' },
    ],
  },
  {
    code: 'POP',
    name: 'POP',
    description: 'บันเทิง ไลฟ์สไตล์ป๊อป',
    color: 'text-pink-700',
    bgColor: 'bg-pink-50',
    borderColor: 'border-pink-200',
    sort: 4,
    programs: [
      { code: '7TG', name: '7 THINGS WE LOVE ABOUT...', category: 'Recurring' },
      { code: 'CFM', name: 'Coffee Minute', category: 'Recurring' },
      { code: 'GTK', name: 'GET TO KNOW THEM', category: 'Recurring' },
      { code: 'PBZ', name: 'POP Buzz', category: 'Recurring' },
      { code: 'PQA', name: 'POP Q&A', category: 'Recurring' },
      { code: 'PRP', name: 'POP Report', category: 'Recurring' },
      { code: 'PIV', name: 'POP Interview', category: 'Recurring' },
      { code: 'SHC', name: 'Short Clip (Highlight)', category: 'Short-form' },
    ],
  },
  {
    code: 'POD',
    name: 'Podcast',
    description: 'รายการ Podcast',
    color: 'text-purple-700',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
    sort: 5,
    programs: [
      { code: '8MH', name: '8 Minutes History', category: 'Recurring' },
      { code: 'HMS', name: 'Human-ศาสตร์', category: 'Recurring' },
      { code: 'OPR', name: 'Open Relationship', category: 'Recurring' },
      { code: 'TTT', name: 'Top to Toe', category: 'Recurring' },
      { code: 'AVK', name: 'อวกาศคาดไม่ถึง', category: 'Recurring' },
    ],
  },
  {
    code: 'KND',
    name: 'KND (คำนี้ดี)',
    description: 'ภาษาอังกฤษและเนื้อหาการเรียนรู้',
    color: 'text-teal-700',
    bgColor: 'bg-teal-50',
    borderColor: 'border-teal-200',
    sort: 6,
    // Programs synced from the ops outlet-DB sheet (Program tab), 2026-06-30.
    programs: [
      { code: 'KNF', name: 'Featuring', category: 'Recurring' },
      { code: 'WKE', name: 'Walking English', category: 'Recurring' },
      { code: 'LSS', name: 'Long Story Short', category: 'Recurring' },
      { code: 'WOD', name: 'Word of The Day', category: 'Recurring' },
      { code: 'PLY', name: 'Play Along', category: 'Recurring' },
      { code: 'ENU', name: 'English Unlock', category: 'Recurring' },
      { code: 'SHF', name: 'Short Form', category: 'Recurring' },
    ],
  },
  {
    code: 'LIF',
    name: 'LIFE',
    description: 'ไลฟ์สไตล์ สุขภาพ ธรรมชาติ',
    color: 'text-green-700',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    sort: 7,
    programs: [
      { code: 'LGV', name: 'Longevity', category: 'Recurring' },
      { code: 'ECO', name: 'Eco-curious', category: 'Recurring' },
      { code: '4HR', name: '4Hours', category: 'Recurring' },
      { code: 'HDL', name: 'How do you live?', category: 'Recurring', notes: 'Photo-centric' },
      { code: 'PSC', name: 'Passion Calling (Short Clip)', category: 'Short-form' },
      { code: 'ART', name: 'Article', category: 'Recurring' },
    ],
  },
  {
    code: 'TSS',
    name: 'The Secret Sauce',
    description: 'ธุรกิจ ผู้บริหาร',
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    sort: 8,
    programs: [
      { code: 'CEO', name: 'CEO Priorities', category: 'Recurring' },
      { code: 'CLA', name: 'Climate Action', category: 'Recurring' },
      { code: 'EXE', name: 'Executive Espresso', category: 'Recurring' },
      { code: 'EXR', name: 'Expertise Room', category: 'Recurring', notes: 'รายการใหม่' },
      { code: 'GPB', name: 'Geopolitics for business', category: 'Recurring', notes: 'รายการใหม่' },
      { code: 'GEB', name: 'Global Economic Background', category: 'Recurring' },
      { code: 'HNW', name: 'Health Is The New Wealth', category: 'Recurring' },
      { code: 'OLS', name: 'Old school', category: 'Recurring', notes: 'รายการใหม่' },
      { code: 'ODK', name: 'One Day with Ken', category: 'Recurring' },
      { code: 'SCI', name: 'Secret Science', category: 'Recurring' },
      { code: 'STC', name: 'Strategy Clinic', category: 'Recurring' },
      { code: 'TSS', name: 'The Secret Sauce', category: 'Recurring', notes: 'Flagship' },
      { code: 'TSL', name: 'The Secret Sauce on Location', category: 'Recurring' },
      { code: 'TSC', name: 'The Secret Short Clip', category: 'Short-form' },
      { code: 'KDM', name: 'Kendom', category: 'Recurring' },
      { code: 'KSG', name: 'Kensight', category: 'Recurring' },
    ],
  },
  {
    code: 'AGN',
    name: 'Content Agency',
    description: 'งานลูกค้า / Agency',
    color: 'text-red-700',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    sort: 9,
    programs: [
      { code: 'EVT', name: 'Event / Forum', category: 'One-off/Event', notes: 'Link กับ Agency Ref' },
      { code: 'VAD', name: 'Video Advertorial', category: 'One-off/Event', notes: 'Link กับ Agency Ref' },
      { code: 'SHC', name: 'Short Clip (Highlight)', category: 'Short-form', notes: 'Agency short-form' },
      // Episode-type aliases. When a Content Agency booking is linked to a
      // sheet Project, the form sends the chosen Episode Type (L/S/A/T) as
      // the program code, so the backend lookup resolves to one of these.
      // Filtered out of the form's Program dropdown (single-char codes).
      { code: 'L', name: 'Long Form (project)', category: 'Long-form' },
      { code: 'S', name: 'Short Clip (project)', category: 'Short-form' },
      { code: 'A', name: 'Album / Photo (project)', category: 'Album' },
      { code: 'T', name: 'Spot / Teaser (project)', category: 'Short-form' },
    ],
  },
  // v1.99.0 — Event team (Production / Platform · "Event" department).
  {
    code: 'EVT',
    name: 'Event',
    description: 'ทีม Event / Forum',
    color: 'text-orange-700',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
    sort: 10,
    programs: [
      // v1.100.3 — "Event" Episode Type (single-char code → shows in the Episode
      // Type picker, for the Event team booking Staff for an event).
      { code: 'E', name: 'Event · งานอีเวนต์ / Staff', category: 'One-off/Event' },
      { code: 'EVF', name: 'Event / Forum', category: 'One-off/Event' },
      { code: 'EVS', name: 'Event Recap / Short Clip', category: 'Short-form' },
    ],
  },
  // v1.99.0 — Project Management Office ("PM").
  {
    code: 'PM',
    name: 'PM',
    description: 'Project Management Office',
    color: 'text-teal-700',
    bgColor: 'bg-teal-50',
    borderColor: 'border-teal-200',
    sort: 11,
    programs: [
      { code: 'PMG', name: 'Project / Production', category: 'One-off/Event' },
    ],
  },
]

// Universal Episode Type options (L / S / A / T) — injected into every outlet
// so the booking form shows one consistent picker regardless of outlet. The
// codes align with the Dashboard sheet's Episode Type column, so the same
// classification flows end-to-end (form → app → sheet). Existing outlet-
// specific show codes (DTW, MNW, EVT, etc.) stay in the data for backward
// compatibility with old bookings; they're hidden from the form by a
// code.length === 1 filter on the picker.
export const EPISODE_TYPE_PROGRAMS: Program[] = [
  { code: 'L', name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว', category: 'Long-form' },
  { code: 'S', name: 'Vertical Short · Reel · TikTok · Short clip', category: 'Short-form' },
  { code: 'A', name: 'Photo Album · ภาพถ่ายชุด', category: 'Album' },
  { code: 'T', name: 'Spot · Bumper · Promo · โฆษณา', category: 'Short-form' },
]

// v1.113 — universal SHOW types (Event / Special / Interview / Other) for jobs
// with no recurring show, injected into every outlet like the Episode Types.
// Multi-char codes on purpose: they flow into the EP/Production ID as a program
// segment ("TSS-EVT-260716-01") and the per-EP show picker lists codes with
// length > 1 automatically. An outlet that already defines the code keeps its
// own entry (e.g. AGN's EVT "Event / Forum" — same meaning, skip-injected).
export const UNIVERSAL_SHOW_TYPES: Program[] = [
  { code: 'EVT', name: 'Event · งานอีเวนต์', category: 'One-off/Event' },
  { code: 'SPC', name: 'Special · รายการพิเศษ', category: 'One-off/Event' },
  { code: 'ITV', name: 'Interview · สัมภาษณ์เดี่ยว', category: 'One-off/Event' },
  { code: 'OTH', name: 'Other · อื่นๆ', category: 'One-off/Event' },
]
for (const outlet of OUTLETS) {
  for (const ep of [...EPISODE_TYPE_PROGRAMS, ...UNIVERSAL_SHOW_TYPES]) {
    if (!outlet.programs.find(p => p.code === ep.code)) {
      outlet.programs.push({ ...ep })
    }
  }
}

export const OUTLET_MAP = Object.fromEntries(OUTLETS.map(o => [o.code, o]))

export function getOutlet(code: string): Outlet | undefined {
  return OUTLET_MAP[code]
}

export function getProgram(outletCode: string, programCode: string): Program | undefined {
  const outlet = OUTLET_MAP[outletCode]
  return outlet?.programs.find(p => p.code === programCode)
}

/** All programs (shows/รายการ) for an outlet — used by the admin reprogram picker. */
export function programsForOutlet(outletCode: string): Program[] {
  return OUTLET_MAP[outletCode]?.programs ?? []
}

// v1.53 — ordered to mirror the assign sections on /admin/[id]
// (ROLE_ORDER in src/lib/team-roster.ts): Photographer + Switcher have
// roster sections, so the form should let producers request them.
export const CREW_OPTIONS = ['Videographer', 'Sound', 'Photographer', 'Switcher', 'DIT', 'Lighting', 'Virtual Production', 'Art Director']

// v1.128 — single source for the booking "อุปกรณ์พิเศษ" checklist (was duplicated
// as literals in BookingWizard / producer edit / admin edit; + Projector).
export const SPECIAL_EQUIPMENT_OPTIONS = ['Gimbal/Ronin', 'Prompter', 'Clip-on Mic (DJI Mic)', 'ไฟดวงเล็ก', 'Projector']
