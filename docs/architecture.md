# Architecture overview

One-page mental model for new developers (or future-me). Last updated **v1.233.1** (2026-09-23).

## What this is

Internal tool for THE STANDARD's video production team. A producer books a
shoot, a coordinator approves it, crew get assigned and invited via Google
Calendar, a room is reserved in the company's central booking system, Drive
folders are created to receive the footage, and background workers move/merge
that footage into the right box and tick the delivery back into the team's
sheet. Replaces a Google Form + manual sheet entry, and by now also the
equipment spreadsheets, the OT paperwork, the sound-mix requests and the
switcher's live-job log.

Production URL: `https://probook.xtec9.xyz`
Repo: `narasitk77/thestandard-production-booking` — **PUBLIC on GitHub**
(verified by unauthenticated API access, 2026-09-23).
Deploy: self-hosted Portainer on `thestandard.fortiddns.com:9000`, stack 125

> ⚠️ **The repo is public, so everything committed here is on the open
> internet.** Never commit a secret, token, password, service-account detail, or
> an internal notification destination (webhook URL, chat channel/group name or
> id). Those live in `CLAUDE.local.md`, which is gitignored for exactly this
> reason — when a fact cannot be written publicly, write
> "ดูไฟล์ CLAUDE.local.md (ไม่ commit)" instead of the value.

Scale measured at v1.233.1: 45 pages · 156 API routes · 15 supervised workers
(16 heartbeat keys) · 32 Prisma models · 139 modules in `src/lib` · 900 tests
across 100 files.

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
- No Sentry, no tracker, no analytics SDK. Usage measurement is one narrow table
  of our own (`PageEvent`, v1.190) — see **Usage analytics** below.

## Data sources (where state lives)

| Where | What |
|---|---|
| **Postgres** (32 models) | Source of truth for everything once submitted. `booking.calendarSyncStatus` (`PENDING`/`OK`/`FAILED`) is the canonical calendar sync state; the `drive*FolderId` columns (v1.114) are the canonical link to Drive; `roomBookingNo` (v1.206) is the canonical "we already hold this room". |
| **Producer Dashboard sheet** (Google Sheets) | Source of truth for Project IDs (`All Projects` tab), Episodes (`_EPs`), Producer/Director roster (`_Users`). Read-only from the app's perspective, except the `Bookings` tab which the app writes for CA bookings. Sheet id is env-driven — see `docs/runbook-sheet-swap.md`. |
| **Google Calendar** "THE STANDARD Production Bookings" | One event per approved booking. Source of truth for crew invites + RSVPs. |
| **Google Drive** — 4 roots | `DRIVE_FOOTAGE_ROOT` (the VIDEO 2026 box tree) · `DRIVE_PRODUCTION_TEAM_ROOT` (the flat landing/drop zone) · `DRIVE_PHOTO_ROOT` · `DRIVE_DOCS_ROOT` (rental/purchase/repair/loan paperwork). Folder **ids** are stored on the booking; names are repaired, never trusted. |
| **Footage log sheet** | Delivery tick target — the app writes the "ส่งงาน" column when a booking is delivered (v1.162). |
| **Central room booking** (`service.thestandard.co/booking`, IT's app) | Source of truth for who holds a meeting room. We are a *client*: read is open, write is key-gated. ~98% of the rows in it come from probook (Sept 2026: 50 bookings, 49 ours). See **Room booking** below. |
| **Lark** (v1.212–213) | Write-only archive. A daily gzipped JSON snapshot of every table + a Base mirror + an append-only "rows that disappeared" table. Nothing in the app ever reads it back — it exists for the day the DB does not. `docs/runbook-lark-export.md`. |
| **Hardcoded in `src/lib/data.ts`** | OUTLETS + programs master list (**11 outlets × 157 programs** after the Episode-Type / universal-show-type injection at the bottom of the file). Rarely changes; seeded into Postgres on container start (upsert with `update: {}`, so a typo in the seed list survives a rename done only in the DB — fix both). |
| **Env vars (Portainer stack)** | Secrets + per-deploy config. A `${VAR:-x}` in compose is **not** the stack's value — read the stack, and remember `""` is not `unset` once it crosses that line (v1.176 and the SHOOT_MARKER mixup both cost a day to this). Worse: a var the stack defines but compose never passes through **does not exist inside the container at all** — that was the real cause of the footage-ready 401s (v1.213, which also added a test that fails when compose drops a declared var). |

## Booking lifecycle

```
            Producer/User                   Coordinator/Admin          Backend
                  │                                 │                      │
1. Submit ───────►│ /new wizard (5 steps)           │                      │
                  │   POST /api/bookings           ─┼─────────────────────►│ Insert booking + episodes
                  │   advisory load warning         │                      │ Status = REQUESTED
                  │   (cameras/crew already full)   │                      │ CA only: append to PD Sheet
                  │   room-overlap warning (v1.223) │                      │
                  │                                 │                      │
    (or) Routine ─┼────────────────────────────────►│ /admin/routine       │ One REQUESTED booking per
                  │                                 │  generate a group   ►│   matching weekday, shared
                  │                                 │                      │   routineGroupId
                  │                                 │                      │
2. Triage ────────┼────────────────────────────────►│ /admin (REQUESTED)   │
                  │                                 │                      │
3. Approve ───────┼────────────────────────────────►│ /admin/[id]          │
                  │                                 │  POST …/approve     ►│ Status = CONFIRMED
                  │                                 │  or "อนุมัติทั้งชุด"  │ Background: Calendar event
                  │                                 │  (v1.229, 1.5s apart)│   w/ guests (DWD impersonate)
                  │                                 │                      │ Landing folder if imminent
                  │                                 │                      │
4. Assign crew ───┼────────────────────────────────►│ /admin/[id] assign   │ Update assignedEmails
                  │                                 │  or bulk-assign the  │ Sync calendar attendees (sync)
                  │                                 │  whole group (v1.230)│ Send assignment email
                  │                                 │                      │
5. Room ──────────┼─────────────────────────────────┼──────────────────────│ room-booking worker (hourly):
                  │                                 │                      │   at-most-once reserve in IT's
                  │                                 │                      │   system; edits/cancels resync
                  │                                 │                      │   inline from the mutation path
                  │                                 │                      │
6. Prep ──────────┼─────────────────────────────────┼──────────────────────│ prep-folders (hourly): the
                  │                                 │                      │   box tree + CAM slots
                  │                                 │                      │ landing (19:00): the next
                  │                                 │                      │   LANDING_CREATE_DAYS days
                  │                                 │                      │ landing prune (12:00)
                  │                                 │                      │
7. Shoot ─────────│ crew drop footage into the landing folder / NAS Cloud Sync does
                  │                                 │                      │
8. Merge ─────────┼─────────────────────────────────┼──────────────────────│ video-merge MOVEs footage
                  │                                 │                      │   landing → box (whole-folder
                  │                                 │                      │   fast path when it can)
                  │                                 │                      │ sound-merge → AUDIO
                  │                                 │                      │ folder-integrity repairs the
                  │                                 │                      │   structure (create/rename only)
                  │                                 │                      │ footage-integrity asks whether
                  │                                 │                      │   the FILES are usable (v1.221)
                  │                                 │                      │
9. Mix (optional)─┼────────────────────────────────►│ /mix queue           │ coordinator assigns, DONE needs
                  │  ask from /new or the booking   │                      │   a delivery link (v1.215–219)
                  │                                 │                      │
10. Deliver ──────┼────────────────────────────────►│ "ส่งงาน"            ►│ deliveredAt + tick the footage
                  │                                 │                      │   log sheet (v1.162)
                  │                                 │                      │
11. Reconcile ────┼─────────────────────────────────┼──────────────────────│ calendar-reconcile every
                  │                                 │                      │   10 min patches guest drift
                  │                                 │                      │
12. Complete ─────┼─────────────────────────────────┼──────────────────────│ autoCompleteBookings() — lazy
                  │                                 │                      │   on read AND called by the
                  │                                 │                      │   review worker (v1.173)
                  │                                 │                      │
13. Review ───────│ anonymous post-shoot form (token link) → managers only
```

## Status enum (BookingStatus)

`REQUESTED → ASSIGNED → CONFIRMED → COMPLETED` (linear, except `CANCELLED`
which is a dead-end from any status; restorable via `/admin/[id]` Restore).

Approve goes straight to `CONFIRMED` regardless of whether crew is assigned.
Assigning crew on a `REQUESTED` booking bumps to `ASSIGNED`. Assigning more
crew to an already-`CONFIRMED` booking keeps `CONFIRMED`.

## Production ID (`bookingCode`) — and the one rule that decides its shape

The Production / Episode ID is the identity of a shoot: it names the Drive box,
it goes in the `_SHOOT.txt` marker, the calendar title, the sheet row and every
conversation about the job. It is **immutable once created** (the only way to
change one is `regenerateBookingId`, deliberately an admin button with an audit
trail). Everything lives in `src/lib/episode-id.ts`.

```
[OUT]-[SHOW]-[YYMMDD]-[NN]     NWS-TSN-260922-01     with a show segment
[OUT]-[YYMMDD]-[NN]            AGN-260915-01         without one
```

- `[OUT]` = outlet code · `[YYMMDD]` = shoot date · `[NN]` = sequence, reset per
  outlet + show + date.
- The old `[TYPE]` segment (`L/S/A/T`, `STD/LOC/EVT`) was **dropped in v1.109**.
  Legacy IDs that still carry one stay valid and parseable — it is an optional
  group in the regexes, never re-minted.
- Live jobs use `LIV` as the show segment (v1.211), a code that deliberately
  exists in no outlet's program list, so the switcher's number series can never
  collide with a shoot's.

**The rule that decides whether `[SHOW]` appears is `progSegmentForId()`, and
that function is the only definition of it.** The data model is: the *booking*
carries the Episode Type (`L/S/A/T`), the *episode* carries the show
(`TSN`, `MNW`, …). If the two values are equal, the caller never separated them
— it just echoed the Episode Type back — so there is no show to put in the ID
and the function returns `null`.

```ts
progSegmentForId(code, bookingProgCode)   // src/lib/episode-id.ts
```

`create-booking.ts`, `move-outlet.ts` and `reprogram-booking.ts` all import that
one function. **Do not re-derive the rule anywhere.** Why this is written in
capital letters: `/admin/routine` had a single "Program" dropdown that fed the
same value into both fields, so `progSegmentForId` correctly returned `null` and
every Morning Wealth booking minted as `WLT-260923-01` with no `MNW` —
**135 bad bookings on 2026-09-22**, all deleted, fixed in v1.232. Worse, they
were unrepairable: `reprogram-booking` saw `code == bookingProgCode`, answered
"nothing changed", and the ID stayed wrong forever. v1.232.1 then found the rule
had quietly become *four* copies and collapsed them back to one, with six tests
pinned to it (`src/lib/__tests__/episode-program-segment.test.ts`).

## Code map

`src/lib` has 139 modules; this groups them by what they own rather than
listing every file. `src/lib/__tests__/` holds all 900 tests in 100 files, plus
the `FakeDrive` harness (`__tests__/helpers/fake-drive.ts`) that makes the Drive
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
│   ├── mix/                   Sound-mix request queue (MIX-001…)
│   ├── switcher/              Live-job log the booking flow never saw (LIV ids)
│   ├── review/[token]/        Anonymous post-shoot form (token-only, never session)
│   ├── feedback/ manual/ changelog/ profile/signature/
│   ├── admin/                 Queue (/admin, /admin/[id]) + 21 back-office pages,
│   │   │                        incl. routine · week-plan · room-schedule ·
│   │   │                        monitor · workspace · reviews · feedback
│   │   └── production-space/  Hub for equipment · loans · repairs · rentals ·
│   │                            purchases · vendors · vendor-prices
│   └── api/                   156 routes — admin 66 · internal 29 · bookings 16 ·
│                                ot 8 · upload 7 · rest singletons
└── lib/
    ├── Booking core           create-booking · booking-status · booking-access ·
    │                          booking-complete · booking-overlap · resource-load ·
    │                          production-id · episode-id · regenerate-booking-id ·
    │                          reprogram-booking · move-outlet · routine · shoot-window
    ├── Google                 google-calendar · google-sheets · google-drive ·
    │                          google-config · google-token · calendar-reconcile ·
    │                          calendar-attendees (the ONE guest-list builder)
    ├── Drive/footage          outlet-folders · footage-folders · prep-folders ·
    │                          video-merge · sound-merge · landing-lifecycle ·
    │                          landing-dedup · landing-duplicates · folder-integrity ·
    │                          footage-integrity · shoot-marker · drive-links ·
    │                          delivery-tick · nas-sync
    ├── Rooms                  room-booking (client + map) · room-booking-sync
    │                          (at-most-once) · room-booking-reconcile (worker) ·
    │                          room-availability (answers "who holds it") · room-badge
    ├── Reconciler (partial)   reconciler/lease.ts · guards.ts (16 shared predicates,
    │                          landing-lifecycle now uses landingMayBeTrashed) ·
    │                          drive-view.ts — no phase driver exists yet
    ├── Gear                   equipment-status · rental-helpers · purchase-batch ·
    │                          purchase-drive · reminders
    ├── People/authz           auth · session · roles (5 DB roles) · tiers (4 UI
    │                          tiers) · team-roster · team-profiles · review-access ·
    │                          booking-history-visibility · internal-auth ·
    │                          producer-edit-access · outlet-producers
    ├── Review/feedback        shoot-review · review-ops · feedback · notifications
    ├── Queues                 mix-jobs · mix-notify · switcher-jobs · switcher-mint
    ├── OT                     ot-calc · ot-sync · ot-cleanup · ot-pdf
    ├── Notify/archive         notify (Discord + Lark + email) · email ·
    │                          lark-client · lark-export · lark-export-policy ·
    │                          lark-base-mapping
    ├── Ops                    heartbeat (worker specs) · audit · audit-retention ·
    │                          backup · app-env (staging fail-closed) ·
    │                          id-first-metrics · page-events
    └── mcp/                   server.ts · tools.ts — 14 MCP tools
```

## Background work

15 supervised worker processes, all launched by `start.sh`, declaring
**16 heartbeat keys** (`landing-worker.js` runs two schedules: the 19:00 create
sweep and the 12:00 prune, and they are separate keys on purpose). Every worker
is a **thin HTTP scheduler**: it fires at its interval and calls
`/api/internal/...` with a shared secret — none of them touches Postgres or
Drive directly (except `backup`, which needs the DB). That is why relocating
them is just `APP_ROLE=worker` + `WORKER_APP_URL` (`docs/worker-service-split.md`).

| Worker | Default interval | Default state (code) |
|---|---|---|
| `calendar-reconcile` | 10 min | ON always |
| `prep-folders` | 1 h (floored at 5 min) | ON unless off |
| `folder-integrity` | 1 h | ON unless off |
| `sound-merge` | 1 h | ON unless off |
| `video-merge` | 6 h fallback (NAS sync-gated) | ON unless off |
| `landing` | 24 h @ 19:00 BKK | ON unless off |
| `landing-prune` | 24 h @ 12:00 BKK | ON unless off |
| `footage-integrity` | 24 h @ 13:00 BKK | ON unless off |
| `room-booking-reconcile` | 1 h | OFF (ON on prod) |
| `backup` | 24 h + once per boot | OFF (ON on prod) |
| `shoot-marker` | 24 h | OFF (ON on prod) |
| `shoot-review` | 24 h | OFF (ON on prod) |
| `footage-sheet-sync` (`footage`) | 10 min | OFF |
| `footage-ready` | 30 min | OFF |
| `reminders` | 24 h | OFF |
| `lark-export` | 24 h | OFF (dormant) |

**"Default state" is the code default, not the running value.** Read the stack
env (or the audit log for real runs) before telling anyone a worker is off —
that mistake has been made twice, both times about a worker that was running.
The four marked "ON on prod" are the ones with direct evidence in the log:
room-booking (49 of 50 September rooms in IT's system came from us),
backup (6 real dumps in Drive, newest 2026-09-22), shoot-marker (03:10 runs in
the audit log), shoot-review (invites sending since 2026-08-18).

Every worker writes a heartbeat (`SystemHeartbeat`); `evaluateWorkers()` in
`src/lib/heartbeat.ts` flags one stale at `interval + 2h` grace,
`maybeAlertStaleWorkers()` fires one throttled alert per 6h, and
`/api/health-summary` returns 503 when any enabled worker has gone quiet.
`scripts/lib/http.js` replaces `fetch` in all of them — undici's 300s
`headersTimeout` was faking 48/48 failures on jobs that actually finished (v1.172).

A worker spec that disagrees with its script is worse than no spec: it reports a
worker as healthy-because-disabled while it is actually dead. When you change an
enable flag or an interval in a worker script, change `workerSpecs()` in the
same commit.

Not worker-driven, but still background:

| Process | Spawned by | Purpose |
|---|---|---|
| Auto-complete past CONFIRMED | Lazy on read + explicitly by the review worker | Move past-shoot bookings to COMPLETED |
| Audit log purge | `start.sh` on container start | Delete `audit_logs` older than 90 days |
| Booking → PD Sheet sync | Fire-and-forget after `POST /api/bookings` | CA bookings only |
| Calendar event create | Fire-and-forget after approve | Create the event with guests |
| Assignment email + calendar patch | Synchronous inside assign | Invite mail + attendee update |
| Room release / resync | Fire-and-forget inside cancel, delete, admin PATCH, producer-edit | Give the room back before taking a new one |
| Hermes cron (this Mac, outside the app) | `scripts/hermes/*.py` | worker-check · id-first monitor · landing cleanup (the noon prune moved back in-container in v1.220 after the laptop copy 401'd silently for 13 days) |

## Room booking (the one system we do not own)

`service.thestandard.co/booking` is IT's app. Four things about it decide the
whole design, all of them learned the hard way:

1. **No idempotency.** Fire twice, book twice. So `syncRoomBooking()` is
   at-most-once by construction: already have `roomBookingNo` → stop · **read
   back first** and adopt a `[PB-<code>]` marker if a previous attempt landed
   without being recorded · only then POST · a timeout is recorded as `UNKNOWN`
   and resolved by the next read-back, never assumed to be a failure.
2. **A read failure is not an empty room.** `.catch(() => null)` once collapsed
   "cannot reach IT" into "no booking exists" and would have cleared
   `roomBookingNo` on rooms we still held — the classic *error-as-emptiness*
   bug (v1.222). Three states, always: `none` / `unknown` / `target`.
3. **Shared quota, 20 req / 5 min, company-wide.** That is why bulk approve
   sleeps 1.5s per booking and bulk-assign 2s, why a full room retries only
   every 6h, and why `room-availability.ts` answers from **our own DB first**
   (in Studio 1/2, 66 of 66 September bookings were ours) with IT's system as a
   cached, allowed-to-fail second layer.
4. **`check-conflict` returns `null` — meaning "free" — when you pass the wrong
   parameters.** It wants `startAt`/`endAt` as UTC ISO, not `startDate`+`startTime`.
   Getting it wrong fails silently in the most dangerous direction.

Consequences worth knowing: `room-availability` never says "ว่าง", only "no one
had booked it at the moment we checked" — a form check cannot promise anything
about the moment someone submits. Rooms are opened one at a time via
`ROOM_BOOKING_ROOMS`; a room that is mapped but not enabled, or not in IT's
system at all (Lounge 2/F), gets the **"ต้องจองห้องเอง"** badge rather than
silence — four War Room bookings had no room at all because "skipped" wrote
nothing to the DB and therefore showed nothing on screen (v1.227).
`findManualHold` recognises a room the booking's own people already grabbed by
hand, so we do not double-book against ourselves. Plan and endpoint notes:
`docs/room-booking-integration-plan.md`.

## Auth model

- **Sign-in**: Google OAuth, `@thestandard.co` only (NextAuth callback in
  `src/lib/auth.ts`). `AUTH_DISABLED=1` is a dev/LAN bypass — never on prod.
  Paired with `SEED_ADMIN_EMAIL` it is also how you test the app *as another
  person* with their real DB role, which is the only way to see the permission
  bugs that are invisible from an admin account.
- **DB roles** (`users.role`, `src/lib/roles.ts`) — 5 tiers ranked
  `ADMIN(0) > SUPPORT(1) > MANAGER(2) > COORDINATOR(3) > USER(4)`. Rank decides
  **who may edit whom** (strictly below you, and only with role-management
  capability); the capability helpers decide **what a role can do** (console /
  OT approve / role management). Managed at `/admin/permissions`.
- **UI tiers** (`src/lib/tiers.ts`, v1.90) collapse (role × position) into
  **4 tiers**: `admin · coordinator · producer · crew` (v1.210 removed
  `sound-mgmt`: it existed for one person and silently granted LESS than his
  COORDINATOR role — a position must never grant less than the role the
  permissions page shows). **One source of truth used by both `Nav.tsx` and
  `middleware.ts`**, so menu and access cannot drift. Pages whose own data layer
  authorizes by ownership (`/new`, `/producer`, `/ot`, `/review`, `/feedback`,
  `/dashboard/[id]`) are deliberately ALWAYS allowed — gating them at the tier
  trapped the exact people they were for.
- **Admin hub** (`/admin/production-space` and the equipment/system pages) is
  ADMIN-only, enforced in `middleware.ts`; console staff bounce back to `/admin`.
- **Review content** (`src/lib/review-access.ts`, v1.173.4) splits into
  `canReadReviewContent` (messages, scores, names — managers only) and
  `canSeeReviewActivity` (did it send, did anyone answer — managers + operator).
  Both fail closed: junk env falls back to the defaults, never to "everyone".
- **Booking history** (`src/lib/booking-history-visibility.ts`, v1.166) is a
  fail-closed allowlist. Before it, the history endpoint returned *any*
  Booking-typed audit row raw to every signed-in user — the audit-leak bug class.
- **Producer dashboard** (`/producer`): the page scopes every query to the
  session's own producer email, so it opens for anyone and simply shows nothing.
- **OT** (`/ot`): admins + the `team-profiles.ts` roster + OT approvers,
  enforced in `ot/layout.tsx` so a direct URL is blocked too.
- **Worker → app** (`src/lib/internal-auth.ts`, v1.123): `/api/internal/*`
  accepts **any** configured secret rather than a precedence chain — a
  first-match chain caused silent hourly 401s when prod defined a var the
  worker did not send.
- **MCP** (`/api/mcp`, 14 tools): API-key auth, with `MCP_API_KEYS_READONLY` for
  keys that may read but not write (v1.212).

## Deploy flow

1. Push to `main` →
2. GHA `.github/workflows/docker-build.yml` builds + pushes to GHCR with tags
   `sha-<short>`, `<branch>`, `latest` (main only). `ci.yml` runs lint +
   `npm run build`, and build runs `npm test` first. Gate the deploy on the CI
   **conclusion**, not on whether your pull command errored.
3. `scripts/ops/deploy.py <sha>` (v1.233.1) does the five steps in the only
   order that is safe: record the current `IMAGE_TAG` to `~/.probook/deploy-state.json`
   **before touching anything** → warn if this release changes
   `prisma/schema.prisma` → take a backup and **verify a real file came out**
   (name + driveFileId + size > 0, not just HTTP 200) → change the tag and
   redeploy → verify all three agree (stack env == container image == tag, and
   the app answers 200). `scripts/ops/rollback.py [sha]` reads the state file
   when you do not pass one.
   Manual route, when you need it: in Portainer stack 125 edit `IMAGE_TAG` →
   **Save settings** → **Pull and redeploy** with "Re-pull image" ON.
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
   - Launch the supervised workers (unless `RUN_WORKERS=0`)
   - `exec npm start`
5. `APP_ROLE=worker` skips **schema push, seed and Next.js entirely** and runs
   only the supervisor. It refuses to boot without `WORKER_APP_URL` — without
   that guard it would call itself and fail silently. **Only the web role
   touches the schema**: two containers running `db push` on one database is
   how a column disappears.

> 🔴 **Rolling back an image rolls back the schema.** `prisma db push
> --accept-data-loss` runs on every boot, so deploying an older image **DROPs
> the columns it does not know about, with their data** — roll back past v1.231
> and every booking's 2nd and 3rd director is gone. `deploy.py` records which
> releases touched the schema and `rollback.py` stops and asks first.
> DB restore steps that have actually been executed (tested locally with
> `DROP SCHEMA public CASCADE`, recovered 32 tables / 10 bookings / 31 users)
> are in `docs/runbook-deploy-rollback.md`.

Compose files: `docker-compose.yml` (db + app + nginx, local) ·
`docker-compose.portainer.yml` (db + app + optional `worker` profile — prod) ·
`docker-compose.staging.yml` (the parallel staging stack). Services use
`restart: always`, not `unless-stopped` — a host-wide stop on 2026-09-02 left
21 of 23 containers down because `unless-stopped` remembers being stopped
(v1.214). There is a test that fails when compose stops passing through a
declared env var; keep it green.

## Usage analytics

`PageEvent` (v1.190) records email + normalized path + time for an **allowlist**
of pages, nothing else — no IP, no user-agent, no referrer, no query string, no
external tracker, no extra cookie. It exists because "why does nobody use this
feature" was unanswerable: `audit_logs` records what people *did*, never what
they *opened and gave up on*. Tracked today: `/ot`, `/ot/admin`, `/new`,
`/upload`, `/mix`. Add a path when there is a real question you cannot answer,
not speculatively — data nobody intends to read is a liability. Funnels count
**people**, and a shared mailbox is not a person (`shared-mailboxes.ts`; do not
guess from the local-part).

## Diagnostic checklist (when something breaks)

| Symptom | First look |
|---|---|
| Booking submit fails | Browser console + `POST /api/bookings` response. Likely validation. |
| Production ID has no show segment | `progSegmentForId()` returned null because the caller sent the same value as both Episode Type and show. Check the form, not the ID. It cannot be repaired after the fact. |
| Approve doesn't create Calendar event | `/admin/[id]` Confirmed card shows `Sync FAILED` with the error inline + a Re-sync button. Backstop: `/admin/health` → Calendar check. |
| Calendar event has no guests | `/admin/[id]` shows the assigned-vs-calendar diff. Click Re-sync; the worker also reconciles every 10 min. A `skipped` re-sync now answers 409, not a green toast (v1.233). |
| Routine booking CONFIRMED but no event | Routine bookings are born with empty `assignedEmails`; the reconciler used to skip them for that reason. It now decides on `calendarAttendees` (which always has the producer). `/admin/routine` → expand the group, the Calendar column shows exactly these. |
| A worker looks dead | `/api/health-summary` — 503 + which key is stale. Then the container log for `[<worker>]` lines. A worker can log failure every run while the job succeeds (that was v1.172); check the heartbeat age, not the log tone. |
| "Worker X is off" | **Read the stack env, not compose.** A `${VAR:-0}` default says nothing about the running value, and a var compose never passes through does not exist in the container at all. Cross-check the audit log for real runs. |
| A worker runs but never reaches some rows | Look for a cursor or a `take`. Three separate cases: folder-integrity's cursor never advanced, footage-integrity ordered `desc` with only a lower date bound (so it scanned only future shoots), calendar-reconcile's `take: 50`. All v1.233 / v1.185.2. |
| Folders missing for a shoot | `/admin/footage-tools`. Landing folders are created for `[+1 .. +LANDING_CREATE_DAYS]` days at 19:00 BKK (prod: 3); a booking confirmed further out correctly has none yet. `merged=0` is not the same as broken. |
| Landing folder never goes away | An empty folder is not a delivered one, and a folder video-merge left a duplicate in is never empty. `?prune=today` after 19:00 BKK deletes **tomorrow's** folders — there is a future-shoot guard now, but read the day window before firing it. |
| Footage in the wrong place | Check `drive*FolderId` on the booking (id-first, v1.114). A renamed folder is not a break; a *missing id* is. |
| Footage arrived but is unusable | `footage-integrity` (daily 13:00) reports 0-byte files, duplicate names in one folder, audio with no picture. `SONY/SONYCARD.IND` at 0 bytes is normal and allowlisted. |
| Drive calls suddenly 401/`unauthorized_client` | Intermittent Google auth flap — seen ~2×/24h. The tri-state guards hold; the Hermes log scan reports it. |
| Room not booked / booked twice | `roomBookingStatus` + `roomBookingError` on the booking, then `/admin/room-schedule`. `SKIPPED` with `room-not-enabled` / `no-room-mapping` means a human must book it — that is what the "ต้องจองห้องเอง" badge says. Never re-fire a create by hand; the worker reads back first, you would not. |
| A dry-run says one thing and the real run another | Read the code for `if (dryRun) { push; continue }`. A preview that takes a different branch than the real path is a preview that lies — this has been shipped three times. |
| `GOOGLE_IMPERSONATE_SUBJECT` issue | `/admin/health` Calendar section — `SOURCE` should be `env`. See `docs/runbook-impersonate-swap.md`. |
| Crew not in roster | `/admin/team` — possibly deactivated. Toggle "Show inactive". |
| PD Sheet read/write failing, or 429 | `/admin/health` — reads and writes are separate checks with different auth models. Bulk anything that touches the sheet must batch and space itself out; per-row writes hit the rate limit. |
| Email not sending | Container log for `[email]` lines + `EMAIL_PROVIDER` env. A background worker has no logged-in user, so Gmail OAuth is unavailable there — a non-interactive provider must be configured or worker email silently does not send. |
| A long admin POST returns 504 | The reverse proxy cuts at ~60s. **Do not re-fire** — the write is usually still running and a second call races into duplicates. Check the digest email or the audit log instead. |
| Container won't start | First 30 log lines → diagnostics + Postgres readiness. `APP_ROLE=worker` without `WORKER_APP_URL` is a deliberate FATAL. |
| Sync stuck in PENDING | A restart mid-approve orphaned the row; the reconciler's stale-PENDING clause picks it up within 10 min. |

`/api/health` runs 5 live checks: `db` · `googleCalendarDwd` ·
`producerDashboardSheetWrite` · `producerDashboardSheetRead` ·
`episodeTabsRead`. It returns 503 if any fails.

## Safety contracts worth knowing before you touch Drive code

- **No permanent deletion exists in this codebase, and none will.** Everything
  goes to Shared-Drive trash (recoverable ~30 days) via `trashDriveItem`.
  Application rows soft-delete (`deletedAt`) for the same reason.
- **Never delete on a cached read.** `DriveView` caches a listing for a whole
  pass (minutes); crew really do upload into an old day's folder mid-pass.
  `freshFiles`/`freshChildren` bypass the cache and are the only reads allowed
  before a delete — `assertNotForDeletion('cached')` throws so the rule shows
  up in the diff instead of hiding in a comment.
- **Today's and tomorrow's drop folders are a no-delete zone**, unconditionally
  (lesson of 2026-07-22).
- **An empty folder is not a delivered shoot.** The NAS was down and the prune
  read "empty" as "done", throwing away drop folders for shoots whose footage
  had never arrived (v1.225). Delivery is a fact in the DB, not an inference
  from Drive.
- Folder lookups match by **exact name**, so a DB rename without the matching
  Drive rename splits a show's footage across two folders on the next prep run
  (v1.174.1).

## Bug classes this codebase keeps re-learning

Worth reading before writing anything here; each has cost a day or more, and
most of the odd-looking defensive code exists because of one of them.

1. **Error as emptiness.** `r.ok ? r.json() : []` and `.catch(() => null)` turn
   "we could not find out" into "there is nothing". Three states, always.
2. **A record is not delivery.** The footage-ready audit reported 85/85
   notifications sent while nobody received one. Measure the outcome, not the
   attempt.
3. **A permission is not an affordance; an affordance is not a sighting.**
   Being allowed to edit with no button to press, or a page with no nav entry,
   is not shipped. 59 bookings were invisible to their own producers because
   `scope=mine` did not consider `producerEmail`.
4. **One rule, one place.** Duplicated predicates (shoot window, edit rights,
   guest lists, the Production ID show segment) always drift, and the copy that
   drifts is the one nobody tested.
5. **The dry run must take the real path.** `if (dryRun) { push; continue }`
   ships a preview that cannot be wrong and therefore cannot be trusted.
6. **Derived data gets deleted.** A `notIn` cleanup wiped future-month OT drafts
   every time someone opened `/ot`. Know what a sweep considers garbage.
7. **The stack value is not the compose default.** And a stack value compose
   never references does not exist inside the container.

## What's NOT done yet (deliberate, on the roadmap)

- **Proper Prisma migrations** — still `prisma db push --accept-data-loss`.
  Changes so far have been additive, but a real migration history would make
  rollback safer (see the rollback warning above — today it is the single
  sharpest edge in the deploy).
- **The reconciler** — collapsing ~10 Drive sweeps into one per-booking pass.
  Design reviewed (`docs/reconciler-design.md`); lease, guards and DriveView
  have landed and `landing-lifecycle` now uses `landingMayBeTrashed` from
  guards, but **no phase driver exists** — there is still nothing that runs a
  pass.
- **Sentry / structured logging** — still `console.log`. `AuditLog` covers
  business events, not application errors.
- **LINE notifications** — the seam is in `notify.ts` (one `notifyLine`
  function); LINE Notify shut down in Mar 2025 so it needs a Messaging-API bot.
- **Lark as a live channel** — the daily archive runs; the Base is write-only
  and one-way on purpose. Discord cannot be retired until the team actually
  moves.
- **Multi-tenant DWD config** — hardcoded fallback in `google-calendar.ts`,
  visible as an amber warning on `/admin/health`.
- **Bulk + resumable footage upload**, **proxy workflow / MAM-native search**.
- **Outlets/Programs to DB-only** — still seeded from `src/lib/data.ts` on every
  container start, so adding a program is a code change + redeploy.
- **`/booking/[outlet]`** — an orphaned form, unlinked from any nav, that
  bypasses every recent improvement. Delete or redirect.

Done since this doc last claimed otherwise: automated tests (900, gating the
build), a staging environment (`docs/staging-setup.md`), and a deploy/rollback
procedure that has actually been rehearsed (`docs/runbook-deploy-rollback.md`).

## Where to read next

- `CHANGELOG.md` — what shipped and **why**, newest first. The single best
  source for the reasoning behind a piece of code. It currently runs ahead of
  this doc in detail and behind `git log` in coverage (v1.223–v1.233 are in the
  log and the commit bodies, not yet written up here).
- `docs/ops-log.md` — the incident journal (3,000+ lines, newest first). Read
  this before you conclude something is a new bug.
- `docs/runbook-*.md` — deploy/rollback · backup · sheet swap · impersonate
  swap · GHCR pull denied · Lark export.
- `docs/landing-folder-policy.md` · `docs/reconciler-design.md` ·
  `docs/worker-service-split.md` · `docs/room-booking-integration-plan.md` ·
  `docs/staging-setup.md` · `docs/mcp.md`.
- `CLAUDE.local.md` — **not committed** (gitignored, because this repo is
  public). It holds the machine-local working rules and every internal
  notification destination. If you are a fresh session and it is not on disk,
  those facts are simply not available to you; ask, do not guess a destination.
