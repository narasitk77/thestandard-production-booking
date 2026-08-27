# Architecture overview

One-page mental model for new developers (or future-me). Last updated **v1.177.1** (2026-08-19).

## What this is

Internal tool for THE STANDARD's video production team. A producer books a
shoot, a coordinator approves it, crew get assigned and invited via Google
Calendar, Drive folders are created to receive the footage, and background
workers move/merge that footage into the right box and tick the delivery back
into the team's sheet. Replaces a Google Form + manual sheet entry, and by now
also the equipment spreadsheets and the OT paperwork.

Production URL: `https://probook.xtec9.xyz`
Repo: `narasitk77/thestandard-production-booking` (private)
Deploy: self-hosted Portainer on `thestandard.fortiddns.com:9000`, stack 125

Scale at the time of writing: 43 pages · 133 API routes · 12 supervised workers ·
27 Prisma models · 105 modules in `src/lib` · 483 tests.

## Stack

- **Next.js 14.2 (App Router)** + TypeScript + Tailwind CSS
- **Prisma 5** → Postgres 16 (same Docker stack)
- **NextAuth** for Google OAuth sign-in (`@thestandard.co` domain restricted)
- **`googleapis`** Node client for Sheets + Calendar + **Drive**
- **`pdf-lib`** + `@pdf-lib/fontkit` for the OT report and signatures
- **Recharts** for charts · **Lucide React** for icons
- **`node:test` via `tsx`** — `npm test` runs as the first step of `npm run build`,
  so a red suite cannot produce an image
- Container: `node:20-alpine` (see `Dockerfile`)

## Data sources (where state lives)

| Where | What |
|---|---|
| **Postgres** (27 models) | Source of truth for everything once submitted. `booking.calendarSyncStatus` (`PENDING`/`OK`/`FAILED`) is the canonical calendar sync state; the `drive*FolderId` columns (v1.114) are the canonical link to Drive. |
| **Producer Dashboard sheet** (Google Sheets) | Source of truth for Project IDs (`All Projects` tab), Episodes (`_EPs`), Producer/Director roster (`_Users`). Read-only from the app's perspective, except the `Bookings` tab which the app writes for CA bookings. Sheet id is env-driven — see `docs/runbook-sheet-swap.md`. |
| **Google Calendar** "THE STANDARD Production Bookings" | One event per approved booking. Source of truth for crew invites + RSVPs. |
| **Google Drive** — 4 roots | `DRIVE_FOOTAGE_ROOT` (the VIDEO 2026 box tree) · `DRIVE_PRODUCTION_TEAM_ROOT` (the flat landing/drop zone) · `DRIVE_PHOTO_ROOT` · `DRIVE_DOCS_ROOT` (rental/purchase/repair/loan paperwork). Folder **ids** are stored on the booking; names are repaired, never trusted. |
| **Footage log sheet** | Delivery tick target — the app writes the "ส่งงาน" column when a booking is delivered (v1.162). |
| **Hardcoded in `src/lib/data.ts`** | OUTLETS + programs master list (**11 outlets × 155 programs**). Rarely changes; seeded into Postgres on container start (upsert with `update: {}`, so a typo in the seed list survives a rename done only in the DB — fix both). |
| **Env vars (Portainer stack)** | Secrets + per-deploy config. A `${VAR:-x}` in compose is **not** the stack's value — read the stack, and remember `""` is not `unset` once it crosses that line (v1.176 and the SHOOT_MARKER mixup both cost a day to this). |

## Booking lifecycle

```
            Producer/User                   Coordinator/Admin          Backend
                  │                                 │                      │
1. Submit ───────►│ /new wizard (5 steps)           │                      │
                  │   POST /api/bookings           ─┼─────────────────────►│ Insert booking + episodes
                  │   advisory load warning         │                      │ Status = REQUESTED
                  │   (cameras/crew already full)   │                      │ CA only: append to PD Sheet
                  │                                 │                      │
2. Triage ────────┼────────────────────────────────►│ /admin (REQUESTED)   │
                  │                                 │                      │
3. Approve ───────┼────────────────────────────────►│ /admin/[id]          │
                  │                                 │  POST …/approve     ►│ Status = CONFIRMED
                  │                                 │                      │ Background: Calendar event
                  │                                 │                      │   w/ guests (DWD impersonate)
                  │                                 │                      │ Landing folder if imminent
                  │                                 │                      │
4. Assign crew ───┼────────────────────────────────►│ /admin/[id] assign   │
                  │                                 │  POST …/assign      ►│ Update assignedEmails
                  │                                 │                      │ Sync calendar attendees (sync)
                  │                                 │                      │ Send assignment email
                  │                                 │                      │
5. Prep ──────────┼─────────────────────────────────┼──────────────────────│ prep-folders (hourly): the
                  │                                 │                      │   box tree + CAM slots
                  │                                 │                      │ landing (19:00): TOMORROW's
                  │                                 │                      │   drop folders only
                  │                                 │                      │
6. Shoot ─────────│ crew drop footage into the landing folder / NAS Cloud Sync does
                  │                                 │                      │
7. Merge ─────────┼─────────────────────────────────┼──────────────────────│ video-merge MOVEs footage
                  │                                 │                      │   landing → box (whole-folder
                  │                                 │                      │   fast path when it can)
                  │                                 │                      │ sound-merge → AUDIO
                  │                                 │                      │ folder-integrity repairs the
                  │                                 │                      │   structure (create/rename only)
                  │                                 │                      │
8. Deliver ───────┼────────────────────────────────►│ "ส่งงาน"            ►│ deliveredAt + tick the footage
                  │                                 │                      │   log sheet (v1.162)
                  │                                 │                      │
9. Reconcile ─────┼─────────────────────────────────┼──────────────────────│ calendar-reconcile every
                  │                                 │                      │   10 min patches guest drift
                  │                                 │                      │
10. Complete ─────┼─────────────────────────────────┼──────────────────────│ autoCompleteBookings() — lazy
                  │                                 │                      │   on read AND called by the
                  │                                 │                      │   review worker (v1.173)
                  │                                 │                      │
11. Review ───────│ anonymous post-shoot form (token link) → managers only
```

## Status enum (BookingStatus)

`REQUESTED → ASSIGNED → CONFIRMED → COMPLETED` (linear, except `CANCELLED`
which is a dead-end from any status; restorable via `/admin/[id]` Restore).

Approve goes straight to `CONFIRMED` regardless of whether crew is assigned.
Assigning crew on a `REQUESTED` booking bumps to `ASSIGNED`. Assigning more
crew to an already-`CONFIRMED` booking keeps `CONFIRMED`.

## Code map

`src/lib` has 105 modules; this groups them by what they own rather than
listing every file. `src/lib/__tests__/` holds all 483 tests, plus the
`FakeDrive` harness (`__tests__/helpers/fake-drive.ts`) that makes the Drive
logic testable without touching Google.

```
src/
├── middleware.ts              Auth redirect + tier gate + ADMIN-hub gate (mirrors Nav.tsx)
├── app/
│   ├── page.tsx               Overview (KPI cards)
│   ├── new/                   5-step booking wizard (+ Routine mode)
│   ├── calendar/ my-bookings/ producer/ dashboard/
│   ├── upload/                Footage upload → Google Shared Drive
│   ├── ot/                    Overtime self-service + approval
│   ├── review/[token]/        Anonymous post-shoot form (token-only, never session)
│   ├── feedback/ manual/ changelog/ profile/signature/
│   ├── admin/                 Queue (/admin, /admin/[id]) + 20 back-office pages
│   │   └── production-space/  Hub for equipment · loans · repairs · rentals ·
│   │                            purchases · vendors · vendor-prices
│   └── api/                   133 routes — admin 65 · bookings 16 · internal 15 ·
│                                ot 8 · upload 7 · rest singletons
└── lib/
    ├── Booking core           create-booking · booking-status · booking-access ·
    │                          booking-complete · booking-overlap · resource-load ·
    │                          production-id · episode-id · regenerate-booking-id
    ├── Google                 google-calendar · google-sheets · google-drive ·
    │                          google-config · google-token · calendar-reconcile
    ├── Drive/footage          outlet-folders · footage-folders · prep-folders ·
    │                          video-merge · sound-merge · landing-lifecycle ·
    │                          landing-dedup · folder-integrity · shoot-marker ·
    │                          drive-links · delivery-tick · nas-sync
    ├── Reconciler (dormant)   reconciler/lease.ts · guards.ts (16 shared predicates) ·
    │                          drive-view.ts — nothing calls these yet
    ├── Gear                   equipment-status · rental-helpers · purchase-batch ·
    │                          purchase-drive · reminders
    ├── People/authz           auth · session · roles (5 DB roles) · tiers (5 UI
    │                          tiers) · team-roster · team-profiles · review-access ·
    │                          booking-history-visibility · internal-auth
    ├── Review/feedback        shoot-review · review-ops · feedback
    ├── OT                     ot-calc · ot-sync · ot-cleanup · ot-pdf
    ├── Ops                    heartbeat (worker specs) · audit · audit-retention ·
    │                          backup · app-env (staging fail-closed) · id-first-metrics
    └── mcp/                   server.ts · tools.ts — the 7 MCP tools
```

## Background work

12 supervised workers, all launched by `start.sh`. Every one of them is a
**thin HTTP scheduler**: it fires at its interval and calls
`/api/internal/...` with a shared secret — none of them touches Postgres or
Drive directly (except `backup`, which needs the DB). That is why relocating
them is just `APP_ROLE=worker` + `WORKER_APP_URL` (`docs/worker-service-split.md`).

| Worker | Default interval | Default state |
|---|---|---|
| `calendar-reconcile` | 10 min | ON always |
| `prep-folders` | 1 h (floored at 5 min) | ON |
| `folder-integrity` | 1 h | ON |
| `sound-merge` | 1 h | ON |
| `video-merge` | 6 h fallback (NAS sync-gated) | ON |
| `landing` | 24 h @ 19:00 BKK | ON |
| `footage-sheet-sync` | 10 min | OFF |
| `footage-ready` | 30 min | OFF |
| `reminders` | 24 h | OFF |
| `backup` | 24 h | OFF |
| `shoot-marker` | 24 h | OFF |
| `shoot-review` | 24 h | OFF |

Every worker writes a heartbeat (`SystemHeartbeat`); `evaluateWorkers()` in
`src/lib/heartbeat.ts` flags one stale at `interval + 2h` grace, and
`/api/health-summary` returns 503 when any enabled worker has gone quiet.
`scripts/lib/http.js` replaces `fetch` in all 12 — undici's 300s
`headersTimeout` was faking 48/48 failures on jobs that actually finished (v1.172).

Not worker-driven, but still background:

| Process | Spawned by | Purpose |
|---|---|---|
| Auto-complete past CONFIRMED | Lazy on read + explicitly by the review worker | Move past-shoot bookings to COMPLETED |
| Audit log purge | `start.sh` on container start | Delete `audit_logs` older than 90 days |
| Booking → PD Sheet sync | Fire-and-forget after `POST /api/bookings` | CA bookings only |
| Calendar event create | Fire-and-forget after approve | Create the event with guests |
| Assignment email + calendar patch | Synchronous inside assign | Invite mail + attendee update |
| Hermes cron (this Mac, outside the app) | `scripts/hermes/*.py` | worker-check · id-first monitor · landing cleanup |

## Auth model

- **Sign-in**: Google OAuth, `@thestandard.co` only (NextAuth callback in
  `src/lib/auth.ts`). `AUTH_DISABLED=1` is a dev/LAN bypass — never on prod.
- **DB roles** (`users.role`, `src/lib/roles.ts`) — 5 tiers ranked
  `ADMIN(0) > SUPPORT(1) > MANAGER(2) > COORDINATOR(3) > USER(4)`. Rank decides
  **who may edit whom** (strictly below you, and only with role-management
  capability); the capability helpers decide **what a role can do** (console /
  OT approve / role management). Managed at `/admin/permissions`.
- **UI tiers** (`src/lib/tiers.ts`, v1.90) collapse (role × position) into
  `admin · coordinator · producer · crew` (v1.210 removed `sound-mgmt`: it
  existed for one person and silently granted LESS than his COORDINATOR role). **One source of truth
  used by both `Nav.tsx` and `middleware.ts`**, so menu and access cannot drift.
  Pages whose own data layer authorizes by ownership (`/new`, `/producer`,
  `/ot`, `/review`, `/feedback`, `/dashboard/[id]`) are deliberately ALWAYS
  allowed — gating them at the tier trapped the exact people they were for.
- **Admin hub** (`/admin/production-space` and the equipment/system pages) is
  ADMIN-only, enforced in `middleware.ts`; console staff bounce back to `/admin`.
- **Review content** (`src/lib/review-access.ts`, v1.173.4) splits into
  `canReadReviewContent` (messages, scores, names — managers only) and
  `canSeeReviewActivity` (did it send, did anyone answer — managers + operator).
  Both fail closed: junk env falls back to the defaults, never to "everyone".
- **Producer dashboard** (`/producer`): the page scopes every query to the
  session's own producer email, so it opens for anyone and simply shows nothing.
- **OT** (`/ot`): admins + the `team-profiles.ts` roster + OT approvers,
  enforced in `ot/layout.tsx` so a direct URL is blocked too.
- **Worker → app** (`src/lib/internal-auth.ts`, v1.123): `/api/internal/*`
  accepts **any** configured secret rather than a precedence chain — a
  first-match chain caused silent hourly 401s when prod defined a var the
  worker did not send.

## Deploy flow

1. Push to `main` →
2. GHA `.github/workflows/docker-build.yml` builds + pushes to GHCR with tags
   `sha-<short>`, `<branch>`, `latest` (main only). `ci.yml` runs lint +
   `npm run build`, and build runs `npm test` first.
3. In Portainer stack 125: edit `IMAGE_TAG` → **Save settings** → **Pull and
   redeploy** with "Re-pull image" ON.
4. `start.sh` on container start, `APP_ROLE=web`:
   - Wait for Postgres; defensive `CREATE DATABASE` if missing
   - Pre-push SQL patches (Category enum rename, UploadStatus enum extension,
     OTApprovalStatus values, legacy PENDING → SUBMITTED)
   - `prisma db push --accept-data-loss`
   - Backfills: `bookingCode` from first episode · `calendarSyncStatus` for
     legacy CONFIRMED · `crewRequired` MUA → Virtual Production · `vanCount`
     from legacy `needsVan`
   - Purge `audit_logs` older than 90 days
   - `tsx prisma/seed.ts` (idempotent — outlets, programs, users, team)
   - Launch the 12 supervised workers (unless `RUN_WORKERS=0`)
   - `exec npm start`
5. `APP_ROLE=worker` skips **schema push, seed and Next.js entirely** and runs
   only the supervisor. It refuses to boot without `WORKER_APP_URL` — without
   that guard it would call itself and fail silently. **Only the web role
   touches the schema**: two containers running `db push` on one database is
   how a column disappears.

Compose files: `docker-compose.yml` (db + app + nginx, local) ·
`docker-compose.portainer.yml` (db + app + optional `worker` profile — prod) ·
`docker-compose.staging.yml` (the parallel staging stack).

## Diagnostic checklist (when something breaks)

| Symptom | First look |
|---|---|
| Booking submit fails | Browser console + `POST /api/bookings` response. Likely validation. |
| Approve doesn't create Calendar event | `/admin/[id]` Confirmed card shows `Sync FAILED` with the error inline + a Re-sync button. Backstop: `/admin/health` → Calendar check. |
| Calendar event has no guests | `/admin/[id]` shows the assigned-vs-calendar diff. Click Re-sync; the worker also reconciles every 10 min. |
| A worker looks dead | `/api/health-summary` — 503 + which key is stale. Then the container log for `[<worker>]` lines. A worker can log failure every run while the job succeeds (that was v1.172); check the heartbeat age, not the log tone. |
| "Worker X is off" | **Read the stack env, not compose.** A `${VAR:-0}` default says nothing about the running value. Cross-check the audit log for real runs. |
| Folders missing for a shoot | `/admin/footage-tools`. Landing folders exist for **tomorrow only** (created 19:00 BKK) — a booking confirmed weeks out correctly has none. `merged=0` is not the same as broken. |
| Footage in the wrong place | Check `drive*FolderId` on the booking (id-first, v1.114). A renamed folder is not a break; a *missing id* is. |
| Drive calls suddenly 401/`unauthorized_client` | Intermittent Google auth flap — seen ~2×/24h. The tri-state guards hold; the Hermes log scan reports it. |
| `GOOGLE_IMPERSONATE_SUBJECT` issue | `/admin/health` Calendar section — `SOURCE` should be `env`. See `docs/runbook-impersonate-swap.md`. |
| Crew not in roster | `/admin/team` — possibly deactivated. Toggle "Show inactive". |
| PD Sheet read/write failing | `/admin/health` — reads and writes are separate checks with different auth models. |
| Email not sending | Container log for `[email]` lines + `EMAIL_PROVIDER` env. |
| A long admin POST returns 504 | The reverse proxy cuts at ~60s. **Do not re-fire** — the write is usually still running and a second call races into duplicates. Check the digest email or the audit log instead. |
| Container won't start | First 30 log lines → diagnostics + Postgres readiness. `APP_ROLE=worker` without `WORKER_APP_URL` is a deliberate FATAL. |
| Sync stuck in PENDING | A restart mid-approve orphaned the row; the reconciler's stale-PENDING clause picks it up within 10 min. |

`/api/health` runs 5 live checks: `db` · `googleCalendarDwd` ·
`producerDashboardSheetWrite` · `producerDashboardSheetRead` ·
`episodeTabsRead`. It returns 503 if any fails.

## Safety contracts worth knowing before you touch Drive code

- **No permanent deletion exists in this codebase, and none will.** Everything
  goes to Shared-Drive trash (recoverable ~30 days) via `trashDriveItem`.
- **Never delete on a cached read.** `DriveView` caches a listing for a whole
  pass (minutes); crew really do upload into an old day's folder mid-pass.
  `freshFiles`/`freshChildren` bypass the cache and are the only reads allowed
  before a delete — `assertNotForDeletion('cached')` throws so the rule shows
  up in the diff instead of hiding in a comment.
- **Today's and tomorrow's drop folders are a no-delete zone**, unconditionally
  (lesson of 2026-07-22).
- Folder lookups match by **exact name**, so a DB rename without the matching
  Drive rename splits a show's footage across two folders on the next prep run
  (v1.174.1).

## What's NOT done yet (deliberate, on the roadmap)

- **Proper Prisma migrations** — still `prisma db push --accept-data-loss`.
  Changes so far have been additive, but a real migration history would make
  rollback safer.
- **The reconciler** — collapsing ~10 Drive sweeps into one per-booking pass.
  Design reviewed (`docs/reconciler-design.md`), and lease + guards + DriveView
  have landed, but **nothing calls them yet** and `reconciler/phases/` is empty.
- **Sentry / structured logging** — still `console.log`. `AuditLog` covers
  business events, not application errors.
- **Multi-tenant DWD config** — hardcoded fallback in `google-calendar.ts`,
  visible as an amber warning on `/admin/health`.
- **Bulk + resumable footage upload**, **proxy workflow / MAM-native search**.
- **Outlets/Programs to DB-only** — still seeded from `src/lib/data.ts` on every
  container start, so adding a program is a code change + redeploy.
- **`/booking/[outlet]`** — an orphaned form, unlinked from any nav, that
  bypasses every recent improvement. Delete or redirect.

Done since this doc last claimed otherwise: automated tests (483, gating the
build) and a staging environment (`docs/staging-setup.md`).

See `CHANGELOG.md` for what shipped and `docs/ops-log.md` for deploy notes.
