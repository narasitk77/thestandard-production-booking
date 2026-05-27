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
      { code: '7TG', name: '7 Things I love about...', category: 'Recurring' },
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
    programs: [
      { code: 'LMF', name: 'KND ล่ามฟ้าพาแปล', category: 'Recurring' },
      { code: 'KNF', name: 'คำนี้ดี Featuring', category: 'Recurring' },
      { code: 'SUB', name: 'Subtitle', category: 'Recurring' },
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
]

// Universal Episode Type options (L / S / A / T) — injected into every outlet
// so the booking form shows one consistent picker regardless of outlet. The
// codes align with the Dashboard sheet's Episode Type column, so the same
// classification flows end-to-end (form → app → sheet). Existing outlet-
// specific show codes (DTW, MNW, EVT, etc.) stay in the data for backward
// compatibility with old bookings; they're hidden from the form by a
// code.length === 1 filter on the picker.
const EPISODE_TYPE_PROGRAMS: Program[] = [
  { code: 'L', name: 'Long-form · รายการ · ซีรีส์ · สัมภาษณ์ยาว', category: 'Long-form' },
  { code: 'S', name: 'Vertical Short · Reel · TikTok · Short clip', category: 'Short-form' },
  { code: 'A', name: 'Photo Album · ภาพถ่ายชุด', category: 'Album' },
  { code: 'T', name: 'Spot · Bumper · Promo · โฆษณา', category: 'Short-form' },
]
for (const outlet of OUTLETS) {
  for (const ep of EPISODE_TYPE_PROGRAMS) {
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

export const PRODUCERS = [
  'หวาน', 'พี่ตุ้ย', 'ปุ๊ก', 'Somchai', 'นัน', 'กบ', 'ปอ', 'แนน', 'บิ๊ก', 'ไก่',
  'ต้น', 'โบ', 'เจน', 'แอม', 'พลอย', 'ฝ้าย', 'มิ้น', 'ออ', 'บี', 'ปิ๊ก',
]

export const CREW_OPTIONS = ['Videographer', 'Sound', 'DIT', 'Lighting', 'Virtual Production', 'Art Director']

export const CATEGORY_OPTIONS = [
  { value: 'ORIGINAL_CONTENT', label: 'Original Content' },
  { value: 'ADVERTORIAL', label: 'Advertorial' },
  { value: 'EVENT', label: 'Event' },
  { value: 'INTERNAL', label: 'Internal' },
]

export const SHOOT_TYPE_OPTIONS = [
  { value: 'STUDIO', label: 'Studio' },
  { value: 'ON_LOCATION', label: 'On Location' },
  { value: 'REMOTE_ONLINE', label: 'Remote / Online' },
  { value: 'EVENT', label: 'Event' },
]
