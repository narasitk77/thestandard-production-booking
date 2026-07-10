// Shared shapes for the calendar page + its BookingDrawer (v1.129).
// Mirrors what GET /api/bookings?withCrew=1 returns per row — every Booking
// scalar column comes back (no `select`), plus assignedCrew/footage extras.

export interface Episode {
  id: string
  episodeId: string
  title: string
  program?: { code?: string; name: string } | null
}

export interface Booking {
  assignedCrew?: { email: string; name: string; isLead?: boolean }[]
  id: string
  bookingCode?: string | null
  shootDate: string
  callTime: string
  estimatedWrap?: string
  status: string
  shootType: string
  // v1.131 — 'ORIGINAL_CONTENT' | 'ADVERTORIAL' | 'EVENT' | 'INTERNAL' (Category enum).
  // Drives the AD/OG color dot + the conditional Agency Ref field in the drawer.
  category?: string | null
  locationName?: string
  producer: string
  producerEmail?: string | null
  vanCount?: number
  cameraCount?: number | null
  micCount?: number | null
  isBlockShot?: boolean
  projectName?: string | null
  specialEquipment?: string[]
  notes?: string | null
  // v1.129 — full-edit + assign + status surfaces in the drawer
  crewRequired?: string[]
  videographerCount?: number
  switcherCount?: number
  creative?: string[]
  equipmentNote?: string | null
  rentalGearNote?: string | null
  itinerary?: string | null
  agencyRef?: string | null
  adminNotes?: string | null
  assignedEmails?: string[]
  mainVideographerEmail?: string | null
  freelancers?: unknown
  footageFiles?: number | null
  footageSent?: boolean
  outlet: { code: string; name: string }
  program: { code: string; name: string }
  episodes: Episode[]
}
