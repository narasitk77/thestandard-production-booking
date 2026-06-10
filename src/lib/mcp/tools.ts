/**
 * MCP tool registry — what an external AI (Claude via claude.ai
 * connector / Claude Code / any MCP client) can do against Production
 * Booking. Read tools cover schedule/projects/reference data; write
 * tools (create_booking, cancel_booking) run the SAME shared logic as
 * the web app and are audit-logged with the MCP actor identity.
 *
 * Auth happens in the route (Bearer MCP_API_KEY) — by the time a tool
 * runs, the caller is trusted at "staff" level. Admin-only surfaces
 * (approve/assign/hard-delete/purge) are deliberately NOT exposed.
 */
import { prisma } from '@/lib/db'
import { OUTLETS } from '@/lib/data'
import { listProjects } from '@/lib/projects'
import { listProjectEpisodes } from '@/lib/dashboard-episodes'
import { bookingShowName } from '@/lib/display'
import { createBookingFromPayload } from '@/lib/create-booking'
import { logAudit } from '@/lib/audit'
import { deleteCalendarEvent } from '@/lib/google-calendar'
import { clearBookingOT } from '@/lib/ot-sync'
import { McpToolError, type McpRegistry } from './server'

export function mcpActorEmail(): string {
  return process.env.MCP_ACTOR_EMAIL?.trim() || 'mcp@probook'
}

const bookingInclude = {
  outlet: true,
  program: true,
  episodes: { orderBy: { sequence: 'asc' as const }, include: { program: { select: { code: true, name: true } } } },
}

function compactBooking(b: any) {
  return {
    bookingCode: b.bookingCode,
    show: bookingShowName(b),
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
    where: { OR: [{ bookingCode: c }, { id: c }] },
    include: bookingInclude,
  })
  if (!booking) throw new McpToolError(`Booking not found: ${c}`)
  return booking
}

export function buildMcpRegistry(): McpRegistry {
  return {
    defs: [
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
          'Always required: shootDate (YYYY-MM-DD), callTime (HH:MM), shootType (STUDIO | ON_LOCATION | EVENT), category (ORIGINAL_CONTENT | ADVERTORIAL), producer (name). Recommended: estimatedWrap (HH:MM), locationName, producerEmail, notes.',
        inputSchema: {
          type: 'object',
          properties: {
            outletCode: { type: 'string' },
            programCode: { type: 'string' },
            shootDate: { type: 'string' },
            callTime: { type: 'string' },
            estimatedWrap: { type: 'string' },
            shootType: { type: 'string', enum: ['STUDIO', 'ON_LOCATION', 'EVENT'] },
            category: { type: 'string', enum: ['ORIGINAL_CONTENT', 'ADVERTORIAL'] },
            producer: { type: 'string' },
            producerEmail: { type: 'string' },
            producerPhone: { type: 'string' },
            locationName: { type: 'string' },
            videoType: { type: 'string' },
            notes: { type: 'string' },
            videographerCount: { type: 'number' },
            cameraCount: { type: 'number' },
            micCount: { type: 'number' },
            needsVan: { type: 'boolean' },
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
    ],

    handlers: {
      async list_bookings(args) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200)
        const where: any = {}
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
          assignedEmails: b.assignedEmails,
          videographerCount: b.videographerCount,
          cameraCount: b.cameraCount,
          micCount: b.micCount,
          needsVan: b.needsVan,
          notes: b.notes,
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
        return { count: projects.length, projects }
      },

      async list_project_episodes(args) {
        const projectId = String(args.projectId || '').trim()
        const res = await listProjectEpisodes(projectId)
        if (!res.ok) throw new McpToolError(res.error)
        return { count: res.episodes.length, episodes: res.episodes }
      },

      async create_booking(args) {
        const requestedBy = typeof args.requestedBy === 'string' && args.requestedBy.includes('@')
          ? args.requestedBy.trim()
          : null
        const actor = requestedBy ? `${mcpActorEmail()} (for ${requestedBy})` : mcpActorEmail()
        const result = await createBookingFromPayload(args, actor)
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
    },
  }
}
