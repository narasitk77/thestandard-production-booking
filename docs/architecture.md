# Architecture overview

One-page mental model for new developers (or future-me). Last updated v1.31.

## What this is

Internal tool for THE STANDARD's video production team to book a shoot,
have it approved by a coordinator, get crew assigned, and end up with a
Google Calendar event that everyone receives an invite for. Replaces a
Google Form + manual sheet entry.

Production URL: `https://probook.xtec9.xyz`
Repo: `narasitk77/thestandard-production-booking` (private)
Deploy: self-hosted Portainer on `thestandard.fortiddns.com:9000`

## Stack

- **Next.js 14 (App Router)** + TypeScript + Tailwind CSS
- **Prisma 5** → Postgres 16 (in the same Docker stack)
- **NextAuth** for Google OAuth sign-in (`@thestandard.co` domain
  restricted)
- **`googleapis`** Node client for Sheets + Calendar
- **Recharts** for admin dashboard charts
- **Lucide React** for icons
- Container: `node:20-alpine` (see `Dockerfile`)

## Data sources (where state lives)

| Where | What |
|---|---|
| **Postgres** (`booking`, `episode`, `outlet`, `program`, `user`, `team_members`, `ot_records`, `audit_logs`, `uploads`) | Source of truth for everything once submitted |
| **Producer Dashboard sheet** (Google Sheets) | Source of truth for Project IDs (`All Projects` tab), Episodes (`_EPs` tab), Producer/Director roster (`_Users` tab). Read-only from the app's perspective, except the `Bookings` tab which the app writes for CA bookings only. Sheet id is env-driven — see `docs/runbook-sheet-swap.md`. |
| **Google Calendar** "THE STANDARD Production Bookings" | One event per approved booking. Source of truth for crew invites + RSVPs. |
| **Hardcoded in `src/lib/data.ts`** | OUTLETS + programs master list (9 outlets × 56 programs). Rarely changes; seeded into Postgres on container start. |
| **Env vars (Portainer stack)** | Secrets + per-deploy config (which sheet, calendar id, DWD impersonate user, SMTP, etc.) |

## Booking lifecycle

```
            Producer/User                      Coordinator/Admin           Backend
                  │                                    │                       │
1. Submit ───────►│ /new wizard (5 steps)              │                       │
                  │   POST /api/bookings              ─┼──────────────────────►│ Insert booking + episodes
                  │                                    │                       │ Status = REQUESTED
                  │                                    │                       │ CA only: append to PD Sheet
                  │                                    │                       │
2. Triage ────────┼───────────────────────────────────►│ /admin (REQUESTED tab)│
                  │                                    │                       │
3. Approve ───────┼───────────────────────────────────►│ /admin/[id]           │
                  │                                    │   POST /admin/.../approve
                  │                                    │                      ►│ Status = CONFIRMED
                  │                                    │                       │ Background: create Google
                  │                                    │                       │   Calendar event w/ guests
                  │                                    │                       │   (uses DWD impersonate)
                  │                                    │                       │
4. Assign crew ───┼───────────────────────────────────►│ /admin/[id] assign UI │
                  │                                    │   POST /admin/.../assign
                  │                                    │                      ►│ Update assignedEmails
                  │                                    │                       │ Sync calendar attendees
                  │                                    │                       │   (sync, not background)
                  │                                    │                       │ Send assignment email
                  │                                    │                       │
5. Reconcile ─────┼────────────────────────────────────┼───────────────────────│ Background worker every
                  │                                    │                       │   10 min — scripts/
                  │                                    │                       │   calendar-reconcile-worker.js
                  │                                    │                       │ Checks confirmed bookings
                  │                                    │                       │ Patches/recreates events
                  │                                    │                       │ that lost their guests
                  │                                    │                       │
6. Auto-complete ─┼────────────────────────────────────┼───────────────────────│ Lazy fire-and-forget on
                  │                                    │                       │   GET /api/bookings
                  │                                    │                       │ Past CONFIRMED → COMPLETED
```

## Status enum (BookingStatus)

`REQUESTED → ASSIGNED → CONFIRMED → COMPLETED` (linear, except `CANCELLED` which is a dead-end from any status; restorable via `/admin/[id]` Restore button).

Approve goes straight to `CONFIRMED` regardless of whether crew is
assigned. Assigning crew on a `REQUESTED` booking bumps to `ASSIGNED`.
Assigning more crew to an already-`CONFIRMED` booking keeps `CONFIRMED`.

## Code map (the parts you'll touch most)

```
src/
├── app/                       Next.js 14 App Router pages + API routes
│   ├── page.tsx               Home / Overview (KPI cards)
│   ├── new/page.tsx           5-step booking wizard
│   ├── calendar/              Month + agenda views w/ detail drawer
│   ├── my-bookings/           Inbox-style 6 tabs
│   ├── admin/
│   │   ├── page.tsx           Admin Console — REQUESTED/CONFIRMED/Completed/Cancelled tabs
│   │   ├── [id]/page.tsx      Booking detail — edit, approve, assign crew, Re-sync calendar
│   │   ├── team/page.tsx      Crew roster CRUD (v1.31)
│   │   ├── health/page.tsx    Runtime config + live health checks (v1.30)
│   │   └── permissions/       USER ↔ ADMIN role mgmt
│   ├── dashboard/page.tsx     Charts + workload + CSV export
│   ├── producer/              Per-producer dashboard
│   ├── ot/                    Overtime module (team members only)
│   └── api/                   All API routes
│       ├── bookings/          CRUD + export
│       ├── admin/[id]/        approve, assign, restore, calendar-resync
│       ├── admin/team/        Roster CRUD
│       ├── health/            Diagnostic endpoint
│       └── internal/calendar/reconcile/   Worker entry point
├── lib/
│   ├── google-config.ts       Sheet id + tab name resolver (v1.30)
│   ├── google-calendar.ts     Calendar create/patch/delete + DWD impersonate
│   ├── google-sheets.ts       Bookings tab writer (CA only)
│   ├── projects.ts            Read "All Projects" + "_EPs"
│   ├── people.ts              Read "_Users" (producers/directors)
│   ├── dashboard-episodes.ts  Episode ID generator via PD web app
│   ├── team-roster.ts         Crew roles + seed data + groupByRole helper (v1.31)
│   ├── calendar-reconcile.ts  Bulk + single-booking reconciler logic
│   ├── booking-status.ts      Status transition whitelist
│   ├── booking-complete.ts    Lazy auto-complete on GET /api/bookings
│   ├── ot-*.ts                Overtime calc + sync + cleanup
│   ├── audit.ts               logAudit + retention
│   ├── email.ts               Gmail OAuth + SMTP fallback
│   ├── data.ts                Hardcoded OUTLETS + programs
│   ├── locations.ts           Hardcoded physical rooms
│   ├── utils.ts               Date formatters, status colors, calendar packet builder
│   ├── auth.ts                NextAuth config
│   ├── session.ts             getSession, requireAdmin, getProducerAccess
│   └── db.ts                  Prisma singleton
└── app/_components/
    ├── Nav.tsx                Top nav w/ + New CTA + role-gated links
    ├── StatusPill.tsx         Canonical status visual (v1.28)
    └── booking/BookingWizard.tsx   The 5-step wizard
```

## Background work

| Process | Spawned by | Cadence | Purpose |
|---|---|---|---|
| Calendar reconciler worker | `start.sh` (supervised restart loop) | Every 10 min | Fix calendar guest drift on confirmed bookings |
| Auto-complete past CONFIRMED | Lazy on `GET /api/bookings` | Per request | Move bookings past their shoot date to COMPLETED |
| Audit log purge | `start.sh` on container start | Once per container start | Delete `audit_logs` older than 90 days |
| Booking → PD Sheet sync | Fire-and-forget after `POST /api/bookings` | Per request | CA bookings only — append to PD sheet "Bookings" tab |
| Calendar event create | Fire-and-forget after `POST /admin/[id]/approve` | Per request | Create the Google Calendar event |
| Assignment email + calendar patch | Sync inside `POST /admin/[id]/assign` | Per request | Send invite email + update calendar attendees |

## Auth model

- Sign-in: Google OAuth, `@thestandard.co` domain only (enforced by
  NextAuth callback in `src/lib/auth.ts`).
- Role: stored in `users.role` (USER | ADMIN). Set via
  `/admin/permissions` UI.
- Producer dashboard access (`/producer`): gated by Producer role in
  the PD sheet's `_Users` tab — see `getProducerAccess` in
  `src/lib/session.ts`.
- OT module (`/ot`): admins + team members (the `TEAM_PROFILES`
  whitelist in `src/lib/team-profiles.ts`).

## Deploy flow

1. Push commit to `main` or `fix/assign-email-real-results` →
2. GHA workflow `.github/workflows/docker-build.yml` builds + pushes to
   GHCR with tags `sha-<short>`, `<branch>`, `latest` (main only)
3. In Portainer stack: edit `IMAGE_TAG` env to the new sha → Save
   settings → Pull and redeploy (with "Re-pull image" toggled ON)
4. `start.sh` runs on container start:
   - Wait for Postgres ready
   - Defensive `CREATE DATABASE` if missing
   - Pre-migration SQL patches (e.g. Category enum rename)
   - `prisma db push --accept-data-loss`
   - Backfill missing `bookingCode` on existing bookings
   - Purge `audit_logs` older than 90 days
   - `tsx prisma/seed.ts` (idempotent — outlets, programs, users, team)
   - Start the reconciler worker (supervised)
   - `exec npm start` (Next.js production server)

## Diagnostic checklist (when something breaks)

| Symptom | First look |
|---|---|
| Booking submit fails | Browser console + `POST /api/bookings` response. Likely validation. |
| Approve doesn't create Calendar event | `/admin/health` → Google Calendar check. Re-sync button on the card. |
| Calendar event has no guests | `/admin/[id]` Re-sync chip. If "GOOGLE_IMPERSONATE_SUBJECT not set" → check `/admin/health` config section. |
| Crew not in roster | `/admin/team` — possibly deactivated. Toggle "Show inactive". |
| PD Sheet writes failing | `/admin/health` → Producer Dashboard sheet check. Verify sheet is shared with service account. |
| Email not sending | Container log for `[email]` lines. Check `EMAIL_PROVIDER` env + Gmail OAuth token state. |
| Container won't start | Container log first 30 lines → diagnostics section + Postgres readiness check. |

## What's NOT done yet (deliberate, on the roadmap)

- **Proper Prisma migrations** (currently `prisma db push --accept-data-loss`)
- **Automated tests** (no test runner configured)
- **Sentry / structured logging** (just console.log)
- **Multi-tenant config** (hardcoded `narasit.k@thestandard.co` fallback for DWD)
- **Staging environment** (push → prod direct via Portainer)
- **Outlets/Programs to DB-only** (currently DB seeded from hardcoded `src/lib/data.ts`)

See `CHANGELOG.md` for what's actually shipped and ops-log.md for deploy notes.
