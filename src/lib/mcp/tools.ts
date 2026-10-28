/**
 * MCP tool registry — what an external AI (Claude via claude.ai
 * connector / Claude Code / any MCP client) can do against Production
 * Booking. Read tools cover schedule/projects/reference data; write
 * tools (create_booking, cancel_booking, create_repair_ticket,
 * mark_rental_paid) run the SAME shared logic as the web app and are
 * audit-logged with the MCP actor identity.
 *
 * Auth happens in the route (Bearer MCP_API_KEY) — by the time a tool
 * runs, full-scope callers act at "staff" level. Read-only keys
 * (MCP_API_KEYS_READONLY, v1.212) never reach the write handlers at
 * all: the route filters this registry down to READ_ONLY_TOOLS
 * (@/lib/mcp/auth) before serving them — add a new READ tool there too
 * or read-only keys won't see it. Request keys (MCP_API_KEYS_REQUEST)
 * get REQUEST_TOOLS — reads + create_booking only. Admin-only surfaces
 * (approve/assign/hard-delete/purge) are deliberately NOT exposed.
 */
import { formatMixNumber, addDaysKey } from '@/lib/mix-jobs'
import { mcpActorEmail, mcpRequestActorEmail, mcpRequestDailyMax, type McpKeyScope } from '@/lib/mcp/auth'
import { prisma } from '@/lib/db'
import { OUTLETS } from '@/lib/data'
import { listProjects } from '@/lib/projects'
import { listProjectEpisodes } from '@/lib/dashboard-episodes'
import { bookingDisplayName } from '@/lib/display'
import { createBookingFromPayload } from '@/lib/create-booking'
import { logAudit } from '@/lib/audit'
import { deleteCalendarEvent } from '@/lib/google-calendar'
import { releaseRoomForBooking } from '@/lib/room-booking-sync'
import { clearBookingOT } from '@/lib/ot-sync'
import { McpToolError, type McpRegistry } from './server'

export { mcpActorEmail } from '@/lib/mcp/auth'

const bookingInclude = {
  outlet: true,
  program: true,
  episodes: { orderBy: { sequence: 'asc' as const }, include: { program: { select: { code: true, name: true } } } },
}

function compactBooking(b: any) {
  return {
    bookingCode: b.bookingCode,
    show: bookingDisplayName(b),
    outlet: b.outlet.code,
    status: b.status,
    shootDate: (b.shootDate instanceof Date ? b.shootDate.toISOString() : String(b.shootDate)).slice(0, 10),
    callTime: b.callTime,
    estimatedWrap: b.estimatedWrap || null,
    shootType: b.shootType,
    location: b.locationName || null,
    producer: b.producer,
    episodes: b.episodes.map((e: any) => ({ episodeId: e.episodeId, title: e.title })),
  }
}

async function findBookingByCode(code: string) {
  const c = String(code || '').trim()
  if (!c) throw new McpToolError('code is required')
  const booking = await prisma.booking.findFirst({
    // v1.51 — soft-deleted bookings are invisible to MCP clients too
    where: { OR: [{ bookingCode: c }, { id: c }], deletedAt: null },
    include: bookingInclude,
  })
  if (!booking) throw new McpToolError(`Booking not found: ${c}`)
  return booking
}

/** วันที่แบบ YYYY-MM-DD เท่านั้น — รูปแบบอื่น (ไม่เติม 0 · มีเวลา/โซน) เลื่อนวันได้เงียบ ๆ จึงปฏิเสธ */
export function dateKeyArg(v: unknown, name: string): string {
  const s = String(v).trim()
  // round-trip: V8 rolls 2026-02-30 over to 03-02 instead of failing — a real date must survive toISOString
  const d = new Date(`${s}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new McpToolError(`${name} must be a real date YYYY-MM-DD`)
  }
  const y = Number(s.slice(0, 4))
  if (y < 2000 || y > 2100) throw new McpToolError(`${name}: use the Gregorian year (ค.ศ.), e.g. 2026 not 2569`)
  return s
}

/** Status filter: case-insensitive, unknown value = error (a typo must not read as "nothing found"). */
function statusArg(v: unknown, allowed: readonly string[]): string {
  const s = String(v).trim().toUpperCase()
  if (!allowed.includes(s)) throw new McpToolError(`status must be one of ${allowed.join(', ')}`)
  return s
}

/** Emails are stored lower-case (session.email) — compare the same way. */
const emailArg = (v: unknown) => String(v).trim().toLowerCase()

/**
 * Fields a request key (Veela) may send to create_booking — the documented schema
 * plus agencyRef. Everything else (isRoutine, routineGroupId, locationId,
 * shootEndDate, director/co-producer emails, virtualProduction, …) is dropped and
 * reported back, never silently applied.
 */
export const REQUEST_CREATE_FIELDS: readonly string[] = [
  'outletCode', 'programCode', 'shootDate', 'callTime', 'estimatedWrap', 'shootType', 'category',
  'producer', 'producerEmail', 'producerPhone', 'locationName', 'videoType', 'notes',
  'videographerCount', 'switcherCount', 'cameraCount', 'micCount', 'isBlockShot', 'vanCount',
  'episodes', 'projectId', 'projectName', 'selectedEpisodeIds', 'agencyRef', 'requestedBy',
]

/** Same request twice (LINE resend, LLM retry) → same key → return the first booking instead of a second one. */
export function requestDedupeKey(x: { shootDate?: unknown; callTime?: unknown; outletCode?: unknown; programCode?: unknown; projectId?: unknown; producer?: unknown }): string {
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const day = x.shootDate instanceof Date ? x.shootDate.toISOString().slice(0, 10) : String(x.shootDate ?? '').trim().slice(0, 10)
  return [day, norm(x.callTime), norm(x.outletCode).toUpperCase(), norm(x.programCode).toUpperCase(), norm(x.projectId), norm(x.producer)].join('|')
}

function limitArg(v: unknown): number {
  return Math.min(Math.max(1, Math.trunc(Number(v)) || 50), 200)
}

export function buildMcpRegistry(ctx: { scope?: McpKeyScope; label?: string } = {}): McpRegistry {
  return {
    defs: [
      {
        name: 'list_switcher_jobs',
        description: 'List switcher jobs, newest work date first. Dates are inclusive Bangkok calendar dates.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Earliest date, YYYY-MM-DD (inclusive)' },
            to: { type: 'string', description: 'Latest date, YYYY-MM-DD (inclusive)' },
            outlet: { type: 'string', description: 'Outlet code' },
            status: { type: 'string', enum: ['DRAFT', 'LOGGED'] },
            switcherEmail: { type: 'string' },
            limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
          },
        },
      },
      {
        name: 'list_mix_jobs',
        description: 'List sound-mix queue jobs, newest created first. from/to filter the date the request was CREATED; dueFrom/dueTo filter the due date (what is due when). Dates are inclusive Bangkok calendar dates.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Created on/after, YYYY-MM-DD (inclusive)' },
            to: { type: 'string', description: 'Created on/before, YYYY-MM-DD (inclusive)' },
            dueFrom: { type: 'string', description: 'Due on/after, YYYY-MM-DD (inclusive)' },
            dueTo: { type: 'string', description: 'Due on/before, YYYY-MM-DD (inclusive)' },
            status: { type: 'string', enum: ['QUEUED', 'IN_PROGRESS', 'DONE', 'CANCELLED'] },
            assigneeEmail: { type: 'string' },
            limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
          },
        },
      },
      {
        name: 'list_bookings',
        description:
          'List production bookings (shoots), newest shoot date first. Filter by date range, status, or outlet. Returns compact rows with bookingCode, show name, status, date/time, and episode IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Earliest shoot date, YYYY-MM-DD (inclusive)' },
            to: { type: 'string', description: 'Latest shoot date, YYYY-MM-DD (inclusive)' },
            status: { type: 'string', enum: ['REQUESTED', 'ASSIGNED', 'CONFIRMED', 'COMPLETED', 'CANCELLED'], description: 'Filter by booking status' },
            outlet: { type: 'string', description: 'Outlet code, e.g. AGN, NWS, WLT, TSS, KND, POP, PDC, LIF' },
            limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
          },
        },
      },
      {
        name: 'get_booking',
        description:
          'Get one booking in full detail by its booking code (e.g. AGN-260615-LOC-01 or NWS-KYM-260616-L-01). Includes episodes, crew, equipment, notes, and calendar sync state.',
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string', description: 'Booking code (Production ID) or internal id' } },
          required: ['code'],
        },
      },
      {
        name: 'list_outlets_and_programs',
        description:
          'Reference data needed before creating a booking: every outlet code with its program codes/names. Content Agency (AGN) has no program list here — it books by project instead (see list_projects).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_projects',
        description:
          'List Content Agency projects (from the Producer Dashboard sheet) that still have bookable episodes. Use the projectId with list_project_episodes, then create_booking.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_project_episodes',
        description:
          'List a Content Agency project\'s episodes that can still be booked (everything except Published). Returns episodeId, status, and the EP label.',
        inputSchema: {
          type: 'object',
          properties: { projectId: { type: 'string', description: 'Project ID, format PP-YY-NNN (e.g. PP-26-025)' } },
          required: ['projectId'],
        },
      },
      {
        name: 'create_booking',
        description:
          'Create a new booking request (status REQUESTED — an admin approves it later; nothing is put on the calendar yet). ' +
          'Two modes. (1) Outlet booking: pass outletCode (e.g. NWS), programCode = the Episode Type bucket (L=long-form, S=short-form, A=album/photo, T=teaser/spot), and episodes = [{programCode: <show code from list_outlets_and_programs, e.g. KYM>, title: <episode title>}]. ' +
          '(2) Content Agency: pass outletCode AGN, programCode = one of AGN-LF/AGN-SC/AGN-ST/AGN-AP/AGN-EVT/AGN-VAD, projectId + projectName from list_projects, and selectedEpisodeIds from list_project_episodes. ' +
          'Always required: shootDate (YYYY-MM-DD), callTime (HH:MM), shootType (STUDIO | ON_LOCATION | EVENT), category (ORIGINAL_CONTENT | ADVERTORIAL), producer (name). Also required UNLESS isBlockShot=true: cameraCount (0 if none), micCount (0 if none). Recommended: estimatedWrap (HH:MM), locationName, producerEmail, notes.',
        inputSchema: {
          type: 'object',
          properties: {
            outletCode: { type: 'string' },
            programCode: { type: 'string' },
            shootDate: { type: 'string' },
            callTime: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: '24h HH:MM, zero-padded (e.g. 09:00)' },
            estimatedWrap: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: '24h HH:MM, zero-padded (e.g. 18:00)' },
            shootType: { type: 'string', enum: ['STUDIO', 'ON_LOCATION', 'EVENT'] },
            category: { type: 'string', enum: ['ORIGINAL_CONTENT', 'ADVERTORIAL'] },
            producer: { type: 'string' },
            producerEmail: { type: 'string' },
            producerPhone: { type: 'string' },
            locationName: { type: 'string' },
            videoType: { type: 'string' },
            notes: { type: 'string' },
            videographerCount: { type: 'number' },
            switcherCount: { type: 'number' },
            cameraCount: { type: 'number', description: 'Required unless isBlockShot — number of cameras needed (0 if none)' },
            micCount: { type: 'number', description: 'Required unless isBlockShot — number of mics needed (0 if none)' },
            isBlockShot: { type: 'boolean', description: 'Block Shot booking — flexible-queue shoot; when true, cameraCount/micCount are not required' },
            vanCount: { type: 'number', description: 'Number of company vans needed (0 = none)' },
            episodes: {
              type: 'array',
              description: 'Outlet bookings only: one entry per episode',
              items: {
                type: 'object',
                properties: {
                  programCode: { type: 'string', description: 'Show code, e.g. KYM' },
                  title: { type: 'string' },
                  contentType: { type: 'string', enum: ['ORIGINAL_CONTENT', 'ADVERTORIAL'] },
                },
                required: ['programCode', 'title'],
              },
            },
            projectId: { type: 'string', description: 'Content Agency only' },
            projectName: { type: 'string', description: 'Content Agency only' },
            selectedEpisodeIds: { type: 'array', items: { type: 'string' }, description: 'Content Agency only' },
            agencyRef: { type: 'string', description: 'Quotation no. (QU-xxxx) — required for ADVERTORIAL; QU-1234TBC if not known yet' },
            requestedBy: { type: 'string', description: 'Email of the human who asked for this booking (recorded in the audit trail)' },
          },
          required: ['outletCode', 'programCode', 'shootDate', 'callTime', 'shootType', 'category', 'producer'],
        },
      },
      {
        name: 'cancel_booking',
        description:
          'Cancel a booking (soft — status becomes CANCELLED; the record stays). Also removes its Google Calendar event and auto-generated OT rows. Give a reason for the audit trail.',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Booking code (Production ID)' },
            reason: { type: 'string' },
          },
          required: ['code'],
        },
      },
      {
        name: 'list_reminders',
        description: 'List open anti-forget reminders (loans/rentals/invoices/repairs/upcoming shoots/warranties). Ask "what is overdue / needs attention?".',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_overdue_loans',
        description: 'List equipment loans that are still out and past (or near) their due date.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_unpaid_rentals',
        description: 'List rental jobs whose payment is still วางบิล (INVOICED) or รอจ่าย (PENDING).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_open_repairs',
        description: 'List repair tickets still open (REPORTED or SENT to the vendor).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_equipment',
        description: 'Search the equipment inventory by free text (name/serial/itemId) and/or status.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search name / serial / itemId' },
            status: { type: 'string', enum: ['AVAILABLE', 'ON_LOAN', 'IN_REPAIR', 'RETIRED'] },
            limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
          },
        },
      },
      {
        name: 'create_repair_ticket',
        description: 'Open a repair ticket for a piece of gear (status REPORTED). itemLabel is free text; optionally name the vendor (matched by name).',
        inputSchema: {
          type: 'object',
          properties: {
            itemLabel: { type: 'string', description: 'What needs repair, e.g. "Sony FX3 No.1 — shutter"' },
            issue: { type: 'string', description: 'Description of the fault' },
            vendorName: { type: 'string', description: 'Repair shop name (matched to an existing vendor)' },
          },
          required: ['itemLabel'],
        },
      },
      {
        name: 'mark_rental_paid',
        description: 'Mark a rental job as PAID (จ่ายแล้ว). Identify it by id, invoiceNo, or quoteNo.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            invoiceNo: { type: 'string' },
            quoteNo: { type: 'string' },
          },
        },
      },
    ],

    handlers: {
      async list_switcher_jobs(args) {
        const limit = limitArg(args.limit)
        const where: any = { deletedAt: null }
        if (args.status) where.status = statusArg(args.status, ['DRAFT', 'LOGGED'])
        if (args.switcherEmail) where.switcherEmail = emailArg(args.switcherEmail)
        if (args.outlet) where.outletCode = String(args.outlet).toUpperCase()
        if (args.from || args.to) {
          where.workDate = {}
          if (args.from) where.workDate.gte = new Date(`${dateKeyArg(args.from, 'from')}T00:00:00Z`)
          if (args.to) where.workDate.lte = new Date(`${dateKeyArg(args.to, 'to')}T00:00:00Z`)
        }
        const rows = await prisma.switcherJob.findMany({
          where,
          select: { productionId: true, outletCode: true, jobName: true, workDate: true, startTime: true, endTime: true, endDayOffset: true, links: true, requestedBy: true, switcherEmail: true, source: true, status: true, createdAt: true, updatedAt: true },
          orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }],
          take: limit,
        })
        return { count: rows.length, jobs: rows }
      },

      async list_mix_jobs(args) {
        const limit = limitArg(args.limit)
        const where: any = { deletedAt: null }
        if (args.status) where.status = statusArg(args.status, ['QUEUED', 'IN_PROGRESS', 'DONE', 'CANCELLED'])
        if (args.assigneeEmail) where.assigneeEmail = emailArg(args.assigneeEmail)
        // dueDate is the date the mix queue runs on ("what is due tomorrow"); from/to stay on createdAt
        if (args.dueFrom || args.dueTo) {
          where.dueDate = {}
          if (args.dueFrom) where.dueDate.gte = new Date(`${dateKeyArg(args.dueFrom, 'dueFrom')}T00:00:00Z`)
          if (args.dueTo) where.dueDate.lte = new Date(`${dateKeyArg(args.dueTo, 'dueTo')}T00:00:00Z`)
        }
        if (args.from || args.to) {
          where.createdAt = {}
          // createdAt มีเวลา: รวมทั้งวันกรุงเทพด้วยขอบบนวันถัดไปแบบ exclusive
          if (args.from) where.createdAt.gte = new Date(`${dateKeyArg(args.from, 'from')}T00:00:00+07:00`)
          if (args.to) where.createdAt.lt = new Date(`${addDaysKey(dateKeyArg(args.to, 'to'), 1)}T00:00:00+07:00`)
        }
        const rows = await prisma.mixJob.findMany({
          where,
          select: { number: true, title: true, bookingCode: true, episodeCode: true, requesterEmail: true, assigneeEmail: true, assignedByEmail: true, claimedAt: true, dueDate: true, deliveredAt: true, status: true, createdAt: true, updatedAt: true, sourceLink: true, deliveryLink: true },
          orderBy: [{ createdAt: 'desc' }],
          take: limit,
        })
        return { count: rows.length, jobs: rows.map(r => ({ ...r, number: formatMixNumber(r.number) })) }
      },

      async list_bookings(args) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200)
        // v1.51 — soft-deleted bookings are hidden from MCP listings
        const where: any = { deletedAt: null }
        if (args.status) where.status = String(args.status)
        if (args.outlet) where.outlet = { code: String(args.outlet).toUpperCase() }
        if (args.from || args.to) {
          where.shootDate = {}
          if (args.from) where.shootDate.gte = new Date(String(args.from))
          if (args.to) where.shootDate.lte = new Date(String(args.to))
        }
        const rows = await prisma.booking.findMany({
          where,
          include: bookingInclude,
          orderBy: [{ shootDate: 'desc' }, { createdAt: 'desc' }],
          take: limit,
        })
        return { count: rows.length, bookings: rows.map(compactBooking) }
      },

      async get_booking(args) {
        const b = await findBookingByCode(String(args.code))
        return {
          ...compactBooking(b),
          id: b.id,
          program: { code: b.program.code, name: b.program.name },
          projectId: b.projectId,
          projectName: b.projectName,
          category: b.category,
          videoType: b.videoType,
          producerEmail: b.producerEmail,
          director: b.director,
          crewRequired: b.crewRequired,
          ...(ctx.scope === 'request' ? {} : { assignedEmails: b.assignedEmails }),
          videographerCount: b.videographerCount,
          switcherCount: b.switcherCount,
          cameraCount: b.cameraCount,
          micCount: b.micCount,
          vanCount: b.vanCount,
          // request keys: no free-text notes / crew e-mail list for an unauthenticated chat
          ...(ctx.scope === 'request' ? {} : { notes: b.notes }),
          calendarSyncStatus: b.calendarSyncStatus,
          createdByEmail: b.createdByEmail,
          createdAt: b.createdAt,
        }
      },

      async list_outlets_and_programs() {
        return OUTLETS.map(o => ({
          code: o.code,
          name: o.name,
          description: o.description,
          programs: o.programs.map(p => ({ code: p.code, name: p.name, category: p.category })),
        }))
      },

      async list_projects() {
        const projects = await listProjects()
        // request keys (chat users probook never authenticated) need only id/name to book — not client/director
        const out = ctx.scope === 'request' ? projects.map((p: any) => ({ projectId: p.projectId, projectName: p.projectName })) : projects
        return { count: out.length, projects: out }
      },

      async list_project_episodes(args) {
        const projectId = String(args.projectId || '').trim()
        const res = await listProjectEpisodes(projectId)
        if (!res.ok) throw new McpToolError(res.error)
        return { count: res.episodes.length, episodes: res.episodes }
      },

      async create_booking(args) {
        if (ctx.scope === 'request') return serialRequest(() => createRequestedBooking(args, ctx.label || 'unnamed'))
        const requestedBy = typeof args.requestedBy === 'string' && args.requestedBy.includes('@')
          ? args.requestedBy.trim().toLowerCase()
          : null
        // v1.146 review fix — requestedBy is attributed as the booking's real
        // creator ONLY when it matches a known User row (so owner checks and
        // the approve confirmation email work for the human who asked);
        // otherwise the MCP actor stays the creator and requestedBy is
        // recorded in the audit trail only. Never concatenate it into the
        // identity string — that corrupted createdByEmail for every
        // MCP-created booking.
        let createdByEmail: string | undefined
        if (requestedBy) {
          const u = await prisma.user.findFirst({
            where: { email: { equals: requestedBy, mode: 'insensitive' } },
            select: { email: true },
          })
          if (u) createdByEmail = u.email
        }
        const result = await createBookingFromPayload(args, mcpActorEmail(), { createdByEmail, requestedBy })
        if (!result.ok) throw new McpToolError(result.error)
        return {
          created: true,
          status: result.booking.status,
          note: 'Booking is REQUESTED — an admin must approve it before it lands on the calendar.',
          booking: compactBooking(result.booking),
        }
      },

      async cancel_booking(args) {
        const b = await findBookingByCode(String(args.code))
        if (b.status === 'CANCELLED') return { cancelled: false, note: 'Already cancelled', bookingCode: b.bookingCode }
        await prisma.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } })
        if (b.calendarEventId) {
          deleteCalendarEvent(b.calendarEventId).catch(e =>
            console.warn(`[mcp cancel] calendar event delete failed: ${e?.message || e}`))
        }
        clearBookingOT(b.id).catch(() => {})
        // v1.222 — ยกเลิกทางไหนก็ต้องคืนห้อง ไม่งั้นห้องค้างโดยไม่มีใครรู้
        releaseRoomForBooking(b.id, 'mcp-cancel')
        logAudit({
          actorEmail: mcpActorEmail(),
          action: 'booking.delete',
          entityType: 'Booking',
          entityId: b.id,
          bookingCode: b.bookingCode,
          fromStatus: b.status,
          toStatus: 'CANCELLED',
          changes: { via: 'mcp', reason: args.reason ?? null },
        })
        return { cancelled: true, bookingCode: b.bookingCode, previousStatus: b.status }
      },

      async list_reminders() {
        const rows = await prisma.reminder.findMany({
          where: { status: { in: ['PENDING', 'SENT'] } },
          orderBy: [{ dueDate: 'asc' }],
          take: 200,
        })
        return { count: rows.length, reminders: rows.map(r => ({ type: r.type, title: r.title, detail: r.body, dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null })) }
      },

      async list_overdue_loans() {
        const today = new Date(); today.setUTCHours(0, 0, 0, 0)
        const rows = await prisma.equipmentLoan.findMany({
          where: { status: 'ACTIVE', dueDate: { not: null, lte: today } },
          orderBy: { dueDate: 'asc' },
          include: { items: { select: { nameSnapshot: true } } },
        })
        return { count: rows.length, loans: rows.map(l => ({ loanCode: l.loanCode, photographer: l.photographer, jobName: l.jobName, dueDate: l.dueDate?.toISOString().slice(0, 10), items: l.items.map(i => i.nameSnapshot) })) }
      },

      async list_unpaid_rentals() {
        const rows = await prisma.rentalJob.findMany({
          where: { status: { not: 'ARCHIVED' }, paymentStatus: { in: ['INVOICED', 'PENDING'] } },
          orderBy: { rentalDate: 'asc' },
          include: { vendor: { select: { name: true } } },
        })
        return { count: rows.length, rentals: rows.map(r => ({ id: r.id, jobName: r.jobName, quoteNo: r.quoteNo, invoiceNo: r.invoiceNo, vendor: r.vendor?.name || null, amount: r.amount ? r.amount.toString() : null, paymentStatus: r.paymentStatus, rentalDate: r.rentalDate?.toISOString().slice(0, 10) })) }
      },

      async list_open_repairs() {
        const rows = await prisma.repairTicket.findMany({
          where: { status: { in: ['REPORTED', 'SENT'] } },
          orderBy: { createdAt: 'asc' },
          include: { vendor: { select: { name: true } } },
        })
        return { count: rows.length, repairs: rows.map(t => ({ id: t.id, item: t.itemLabel, status: t.status, vendor: t.vendor?.name || null, sentDate: t.sentDate?.toISOString().slice(0, 10), cost: t.cost ? t.cost.toString() : null })) }
      },

      async list_equipment(args) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200)
        const where: any = {}
        if (args.status) where.status = String(args.status)
        const q = String(args.q || '').trim()
        if (q) where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { serialNumber: { contains: q, mode: 'insensitive' } },
          { itemId: { contains: q, mode: 'insensitive' } },
        ]
        const rows = await prisma.equipment.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }], take: limit })
        return { count: rows.length, equipment: rows.map(e => ({ itemId: e.itemId, name: e.name, category: e.category, serialNumber: e.serialNumber, status: e.status, location: e.location })) }
      },

      async create_repair_ticket(args) {
        const itemLabel = String(args.itemLabel || '').trim()
        if (!itemLabel) throw new McpToolError('itemLabel is required')
        let vendorId: string | null = null
        const vendorName = String(args.vendorName || '').trim()
        if (vendorName) {
          const v = await prisma.vendor.findFirst({ where: { name: { equals: vendorName, mode: 'insensitive' } }, select: { id: true } })
          vendorId = v?.id || null
        }
        const ticket = await prisma.repairTicket.create({ data: { itemLabel, issue: String(args.issue || '').trim() || null, vendorId, status: 'REPORTED' } })
        logAudit({ actorEmail: mcpActorEmail(), action: 'repair.create', entityType: 'RepairTicket', entityId: ticket.id, changes: { via: 'mcp', itemLabel } })
        return { created: true, id: ticket.id, itemLabel, status: ticket.status }
      },

      async mark_rental_paid(args) {
        const id = String(args.id || '').trim()
        const invoiceNo = String(args.invoiceNo || '').trim()
        const quoteNo = String(args.quoteNo || '').trim()
        if (!id && !invoiceNo && !quoteNo) throw new McpToolError('provide id, invoiceNo, or quoteNo')
        const rental = await prisma.rentalJob.findFirst({ where: { OR: [...(id ? [{ id }] : []), ...(invoiceNo ? [{ invoiceNo }] : []), ...(quoteNo ? [{ quoteNo }] : [])] } })
        if (!rental) throw new McpToolError('Rental not found')
        if (rental.status === 'ARCHIVED') throw new McpToolError('Rental is archived (legacy sheet-import) — its source of truth is the Google Sheet, not editable here')
        if (rental.paymentStatus === 'PAID') return { updated: false, note: 'Already PAID', id: rental.id }
        await prisma.rentalJob.update({ where: { id: rental.id }, data: { paymentStatus: 'PAID' } })
        logAudit({ actorEmail: mcpActorEmail(), action: 'rental.update', entityType: 'RentalJob', entityId: rental.id, fromStatus: rental.paymentStatus, toStatus: 'PAID', changes: { via: 'mcp' } })
        return { updated: true, id: rental.id, jobName: rental.jobName }
      },
    },
  }
}

/**
 * create_booking for a REQUEST key (v1.276 — review of PR #21). The caller is a
 * chat bot whose users probook never authenticated, so compared with a full key:
 * - only REQUEST_CREATE_FIELDS pass; anything else is dropped and listed back
 * - requestedBy is recorded in the audit, never promoted to the booking's owner
 * - producerEmail must be an active probook user (no outside addresses that would
 *   later get calendar invites / QU reminders)
 * - shootDate must be a real date, today or later; one day only (no shootEndDate)
 * - at most mcpRequestDailyMax() bookings per 24 h, and the same request repeated
 *   within 15 min returns the first booking instead of burning a second Episode ID
 * - created as mcpRequestActorEmail(): the room reconciler leaves these without a
 *   room until an admin approves them (roomEligibleWhere)
 */
// ponytail: one in-process queue for every request-scope create, so the dedupe and the daily cap
// (read, then create) cannot race with a concurrent resend. Single web container, same as
// merge-lock.ts; a second web replica would need this under a DB lock.
const gq = globalThis as unknown as { __probookMcpRequestQueue?: Promise<unknown> }
function serialRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = (gq.__probookMcpRequestQueue ?? Promise.resolve()).then(fn)
  gq.__probookMcpRequestQueue = run.catch(() => undefined)
  return run
}

async function createRequestedBooking(args: Record<string, any>, label: string) {
  const body: Record<string, any> = {}
  const ignoredFields: string[] = []
  for (const [k, v] of Object.entries(args || {})) {
    if (REQUEST_CREATE_FIELDS.includes(k)) body[k] = v
    else ignoredFields.push(k)
  }
  body.shootDate = dateKeyArg(body.shootDate, 'shootDate')
  const todayBkk = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)
  if (body.shootDate < todayBkk) throw new McpToolError(`shootDate ${body.shootDate} is in the past`)

  if (body.producerEmail) {
    const email = emailArg(body.producerEmail)
    const u = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, active: true }, select: { email: true } })
    if (!u) throw new McpToolError(`producerEmail ${email} is not an active probook user — ask the producer, or leave it empty`)
    body.producerEmail = u.email
  }
  const requestedBy = typeof body.requestedBy === 'string' && body.requestedBy.includes('@') ? emailArg(body.requestedBy) : null

  const actor = mcpRequestActorEmail()
  const now = Date.now()
  const key = requestDedupeKey(body)
  const recent = await prisma.booking.findMany({
    where: { createdByEmail: actor, deletedAt: null, status: { not: 'CANCELLED' }, createdAt: { gte: new Date(now - 15 * 60_000) } },
    include: bookingInclude,
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  const dup = recent.find((b: any) => requestDedupeKey({ shootDate: b.shootDate, callTime: b.callTime, outletCode: b.outlet?.code, programCode: b.program?.code, projectId: b.projectId, producer: b.producer }) === key)
  if (dup) {
    return { created: false, duplicate: true, note: 'Same request was made in the last 15 minutes — returning that booking instead of creating another.', booking: compactBooking(dup) }
  }
  // cap on EPISODES, not bookings: each one burns an Episode ID for good (one booking may carry 20)
  const incoming = Array.isArray(body.episodes) ? body.episodes.length : Array.isArray(body.selectedEpisodeIds) ? body.selectedEpisodeIds.length : 1
  const eps24h = await prisma.episode.count({ where: { booking: { createdByEmail: actor, createdAt: { gte: new Date(now - 24 * 3_600_000) } } } })
  if (eps24h + incoming > mcpRequestDailyMax()) {
    throw new McpToolError(`request limit reached (${eps24h} episodes in 24 h, max ${mcpRequestDailyMax()}) — book in the web app or ask an admin`)
  }

  const result = await createBookingFromPayload(body, actor, { requestedBy, via: `mcp:${label}` })
  if (!result.ok) throw new McpToolError(result.error)
  return {
    created: true,
    status: result.booking.status,
    note: 'Request recorded as REQUESTED — an admin must approve it; a studio/room is reserved only after approval.',
    ...(ignoredFields.length ? { ignoredFields } : {}),
    booking: compactBooking(result.booking),
  }
}

