# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.26.2] — 2026-05-22

### Fixed — re-assigning crew keeps the calendar guests in sync

Previously the calendar event's guests were set only at approve time; changing
the crew afterward updated the DB + sent new assignment emails but left the
event's guests stale. New `updateCalendarEventAttendees()` in
`src/lib/google-calendar.ts` is now called from the assign route whenever the
booking already has a `calendarEventId` — it replaces the event's attendees with
the current crew (added crew get an invite, removed crew a cancellation) via
`events.patch` + `sendUpdates: 'all'`. No-op without Domain-Wide Delegation (same
as the create path), so it's safe regardless.

---

## [1.26.1] — 2026-05-22

### Fixed — Producer Dashboard email match is case-insensitive

The producer-scoped views matched `producerEmail` against the (lowercased)
session email with a case-sensitive query — so a producer whose stored
`producerEmail` had different casing would see **zero** bookings. Now
case-insensitive in: `GET /api/bookings?scope=producer`,
`GET /api/bookings/export?scope=producer`, and the producer-message
authorization check.

---

## [1.26.0] — 2026-05-22

### Added — assigned crew added as Google Calendar guests (attendees)

The calendar event for a booking now adds the **assigned crew**
(`assignedEmails`) as event **guests** — Google sends them a real invite they
can accept/decline — instead of only listing them in the description.

- `src/lib/google-calendar.ts`: `getAuth()` impersonates
  `GOOGLE_IMPERSONATE_SUBJECT` (Domain-Wide Delegation); `createCalendarEvent`
  adds `attendees` + `sendUpdates: 'all'` when that env is set.
- **Graceful fallback**: if attendees are rejected (DWD not granted) or the env
  is unset, the event is created **without guests** (the "Assigned:" line stays
  in the description) — booking creation never breaks.

### Requires (ops) — to actually invite guests

A bare service account cannot invite attendees, so this needs **Domain-Wide
Delegation**:
1. Workspace Admin → Security → API controls → Domain-wide delegation → add the
   service account's Client ID with scope
   `https://www.googleapis.com/auth/calendar`.
2. Set `GOOGLE_IMPERSONATE_SUBJECT` (Portainer stack) to a `@thestandard.co`
   user who can manage the shared calendar.
3. Redeploy. Without these, crew stay in the description only (no error).

---

## [1.25.0] — 2026-05-22

### Added — Producer Dashboard (role-gated)

New **`/producer`** page for Producers / Co-Producers. Access is gated by the
user's `position` (an admin sets it on the Permissions page) — anyone whose
position contains "producer", plus admins. The **Producer** menu link appears
only for them (`canSeeProducer` computed in `layout.tsx`, mirroring `canSeeOT`).

Features:
- Lists the user's shoots — bookings where they are the **Producer**
  (`producerEmail`) — with status, an **"assigned yet?"** indicator, project,
  shoot date/time and episode IDs.
- Per booking: view the **audit history**; **send an update + email the admins**;
  **request a time change + email the admins** (admins apply the change via the
  normal edit flow — the request is recorded in the audit log, the booking is
  not auto-edited).
- **Export** the user's bookings as CSV (for reports).

Implementation — reuses existing pieces (audit log, history endpoint, `csv.ts`,
`sendEmail`):
- `getProducerAccess()` in `src/lib/session.ts`; gate wired through
  `layout.tsx` → `Nav.tsx`.
- `GET /api/bookings?scope=producer` (own producer shoots),
  `GET /api/bookings/export?scope=producer` (CSV),
  `POST /api/bookings/[id]/producer-message` (`type: update | time_change` →
  audit log + email active admins).
- `src/app/producer/page.tsx` (gate) + `ProducerDashboard.tsx` (client UI).

No schema change — gating reads the existing `User.position`.

---

## [1.24.1] — 2026-05-22

### Fixed — Bookings tab "Booking ID" shows the readable code

The "Booking ID" column in the Producer Dashboard **Bookings** tab now writes
`booking.bookingCode` (the human-readable code shown in the app — e.g. the
Production ID `AGN-260522-EVT-01`) instead of the internal CUID
(`clxyz…`). `src/lib/google-sheets.ts` — `BookingRow` gains `bookingCode`, and
`appendBookingRow` writes `bookingCode || id`.

Note: only affects rows appended from now on; existing rows keep their old CUID
value unless re-written.

---

## [1.24.0] — 2026-05-22

### Changed — booking = a Production that SELECTS existing episodes (3-level ID model)

Reworked the Content Agency flow around a 3-level ID hierarchy:

| Level | Example | Where it's created |
|---|---|---|
| Project | `PP-26-023` | "All Projects" tab (humans) |
| Episode | `PP-26-023-S01` | "_EPs" tab — producers create in the sheet |
| **Production** | `AGN-260423-EVT-01` | **this booking** |

The booking **no longer generates Episode IDs**. It now:

- Loads the chosen project's **existing** episodes from the "_EPs" tab,
  **excluding Published** ones — `GET /api/projects/:id/episodes` +
  `listProjectEpisodes()` in `src/lib/dashboard-episodes.ts`.
- Lets the user **multi-select** which episodes the shoot covers (form section
  after PROJECT ID, replacing the title inputs for Content Agency).
- Mints a **Production ID** `OUT-YYMMDD-SHOOTTYPE-NN` (e.g. `AGN-260423-EVT-01`;
  `EVT`/`STD`/`LOC`/`REM` from the shoot type) as the booking's `bookingCode`.
- Records the Production in the **DB + Bookings tab only** — it does **not**
  write back to the `_EPs` / `PD` / `Dir` episode rows.

Other outlets (non-AGN) keep the legacy flow: enter titles → local
`OUT-YYMMDD-PROG-NN` Episode IDs, `bookingCode` = first episode.

### Schema

- `Episode.episodeId` is **no longer `@unique`** — the same episode can be shot
  across multiple Productions. Applied via `prisma db push` on boot.

### Files

`src/app/page.tsx` (episode multi-select + fetch on project select),
`src/app/api/bookings/route.ts` (select + Production ID),
`src/app/api/projects/[id]/episodes/route.ts` (new),
`src/lib/dashboard-episodes.ts` (`listProjectEpisodes`), `prisma/schema.prisma`.

---

## [1.23.0] — 2026-05-22

### Added — in-app Changelog page

- New page **`/changelog`** ("อัปเดต" in the nav, next to "คู่มือ") renders this
  CHANGELOG.md with `react-markdown`, so anyone can see what changed in each
  version on the website. Single source of truth — the page reads the same
  CHANGELOG.md that's committed to the repo (`src/app/changelog/page.tsx`,
  mirroring the `/manual` pattern). Nav link added in
  `src/app/_components/Nav.tsx`.

---

## [1.22.2] — 2026-05-22

### Changed — "Agency Ref" → "Product code" (mapped to the sheet), PROJECT ID moved

- The **AGENCY REFERENCE** field is relabelled **PRODUCT CODE** on the booking
  form. Its value is now written to the "PD &lt;producer&gt;" tab's **Product
  Code column (F)** for each episode (previously left blank). Stored internally
  as `agencyRef` still — no schema change. `generateProjectEpisodeIds` takes a
  `productCode` arg (`src/lib/dashboard-episodes.ts`); `route.ts` passes
  `agencyRef` into it.
- **PROJECT ID** field moved to sit **right after Director** on the form
  (`src/app/page.tsx`); still required when the project list loads.

---

## [1.22.1] — 2026-05-22

### Fixed — Drive folder path + Director column

- **Drive / NAS folder path** now uses the booking's first Episode ID (e.g.
  `Production/2026/05/PP-26-006-T02/`) instead of the `OUT-YYMMDD-PROG` code
  (`AGN-260522-T`), so it matches the real Episode IDs. Updated in all three
  places: `src/app/booking/success/page.tsx`, `src/app/dashboard/[id]/page.tsx`,
  and the calendar packet in `src/lib/utils.ts`.
- **Director value** written to the "PD &lt;producer&gt;" column and used for the
  "Dir. &lt;director&gt;" tab name is now cleaned to the bare nickname. The
  "All Projects" Director cell can hold a composite like `PP-26-006-L01 — ท็อป`;
  `cleanDirectorName()` (in `src/lib/dashboard-episodes.ts`) keeps the segment
  after the last em-dash of the last line, so the sheet shows just `ท็อป`. A
  clean name passes through unchanged.

---

## [1.22.0] — 2026-05-22

### Changed — project Episode IDs minted in-app (Apps Script Web App removed)

The Apps Script Web App that minted `PP-YY-NNN-{type}NN` IDs was operationally
fragile — the deployment URL kept dying and the env vars kept getting lost
across redeploys. It's gone. The app now mints those IDs itself and writes the
Producer Dashboard tabs via the **same Google service account** it already uses
to read "All Projects" / "_Users" and write the "Bookings" tab.

- **New `src/lib/dashboard-episodes.ts`** — `generateProjectEpisodeIds()`:
  - looks up the project in "All Projects" (producer, director, project name);
  - numbers from the max `{projectId}-{type}NN` in the producer's
    "PD &lt;producer&gt;" tab (col C) — the complete record, so old projects
    continue correctly with no migration;
  - appends each episode to "PD &lt;producer&gt;" and (idempotently) to
    "Dir. &lt;director&gt;", mirroring the exact column layout the Apps Script used.
- `src/app/api/bookings/route.ts` — the project path calls
  `generateProjectEpisodeIds` instead of the Web App. Still **fails loud** (503)
  if the sheet can't be resolved — never a silent local ID.
- **Removed** `src/lib/booking-episode-api.ts` and the
  `BOOKING_EPISODE_WEBAPP_URL` / `_SECRET` env (compose + example).

### Requires (ops)

- The Google service account must have **edit** access to the Dashboard sheet
  (it already does — it writes the Bookings tab).
- **Turn OFF the sheet's onEdit episode auto-gen** so the app is the single
  numbering authority (booking is app-only now). Otherwise the sheet's `EP_SEQ`
  counter and the app's PD-tab numbering can diverge → duplicate numbers.
- The Apps Script project `booking-episode-endpoint.gs` can be retired.

---

## [1.21.0] — 2026-05-22

### Changed — simplified Episode-ID generation (removed over-engineering)

After review: the Apps Script Web App is **necessary** — the Producer Dashboard
sheet auto-generates Episode IDs via its own onEdit trigger, and the Web App
keeps booking-created IDs in that same shared `EP_SEQ` sequence (plus writes the
PD/Dir tabs). What was over-built was the resilience scaffolding around the
*local* path. Trimmed:

- **Removed `src/lib/episode-sequence.ts`** (`pg_advisory_xact_lock` +
  `withSequenceRetry`). Local (non-project) Episode IDs now use a plain
  `findFirst(max sequence) + 1`. A single booking is one transaction, so the
  "20 EPs at once" case never needed a lock; the `@unique` constraint still
  guards the rare concurrent-same-slot case.
- **Removed the redundant `prisma.$transaction` wrapper** — the nested
  `booking.create({ episodes: { create } })` is atomic on its own.
- **Removed the silent local-ID fallback for project bookings.** Previously, if
  the Web App was unreachable a project booking silently got a local `AGN-…` ID
  (wrong format, breaks the shared sequence — the source of recent confusion).
  It now returns a clear `503` ("ออก Project ID ไม่ได้ตอนนี้ … ลองใหม่อีกครั้ง")
  so the booking is retried rather than mis-numbered.
- **Kept** the Web App call's hard timeout (still prevents the POST hanging →
  NPM 502).

Net: fewer moving parts; a project Episode ID is now always either correct
(`PP-…`) or a clear error — never a silent wrong-format ID.

`src/app/api/bookings/route.ts`, removed `src/lib/episode-sequence.ts`.

---

## [1.20.0] — 2026-05-21

### Fixed — booking POST could hang → NPM 502 ("Unexpected token '<'")

Root cause: a project-linked Content Agency booking calls the Apps Script Web
App for Episode IDs. If that call wedged (the Docker host has documented
IPv6-egress issues with Google hosts, and `AbortController` does not reliably
interrupt a socket stuck in DNS/TCP connect), the `await` never resolved → the
POST never responded → Nginx Proxy Manager returned an HTML 502 page → the form
showed "Unexpected token '<'". The app itself never crashed or logged an error
(consistent with a silent hang).

**Two-part fix:**

1. **Bulletproof timeout** (`src/lib/booking-episode-api.ts`) — `requestEpisodeIds`
   now races the fetch against a hard 12s timer (`Promise.race`). Even if the
   underlying socket never settles, the function returns within 12s. Previously
   only an `AbortController` guarded it, which a wedged socket can ignore.

2. **Fallback instead of failure** (`src/app/api/bookings/route.ts`) — if the
   Web App is unreachable/slow/misconfigured, the booking no longer returns 502.
   It falls back to **local Episode ID generation** (the advisory-lock path) so
   the booking always succeeds. `projectId` / `projectName` are still saved, so
   the project link is preserved; only the Episode-ID format differs
   (`AGN-YYMMDD-T-NN` instead of `PP-YY-NNN-TNN`) for bookings created during a
   Web App outage. A server-side `console.warn` records each fallback.

Net effect: the booking queue stays up even when the Producer Dashboard Web App
is down. Combined with 1.19.1 (no-project escape) and 1.19.2 (clear non-JSON
error), a Dashboard/sheet outage can no longer block Content Agency bookings.

### Note

- This intentionally reverses the earlier "fail loud if the Web App is down"
  stance (booking-episode-api.ts header) in favour of availability. If strict
  ID-format consistency is required, watch the `console.warn` lines and re-issue
  affected episodes once the Web App is healthy.

---

## [1.19.2] — 2026-05-21

### Fixed — clearer error when the booking POST returns non-JSON

The form showed a cryptic `Unexpected token '<', "<!DOCTYPE "... is not valid
JSON` whenever `POST /api/bookings` replied with HTML instead of JSON (proxy
502/503/504 while the container restarts after a deploy, or any upstream error
page). The client now checks the response content-type first and shows the HTTP
status with guidance ("แอปอาจกำลังรีสตาร์ทหลัง deploy ลองใหม่ใน ~1 นาที").

### Hardened — Apps Script Web App call (Episode IDs)

- 15s `AbortController` timeout so a hanging Web App can't keep the booking POST
  open long enough to trigger an upstream proxy timeout (which is what produces
  the HTML 504 the client choked on).
- Parses the response via `text()` + `JSON.parse` so a 200-with-HTML answer
  (Apps Script login/error page) returns a clean error string instead of
  throwing.

`src/app/page.tsx`, `src/lib/booking-episode-api.ts`.

---

## [1.19.1] — 2026-05-21

### Fixed — PROJECT ID no longer hard-blocks Content Agency when the sheet is down

A sheet outage previously made every Content Agency booking impossible: the
PROJECT ID dropdown had no options to pick, yet it was `required`, so the form
could never submit. Now PROJECT ID is a **graceful-degradation** field:

- Required **only** when the Producer Dashboard sheet returned selectable
  projects (`visibleProjects.length > 0`). When the sheet is unreachable, or the
  selected producer has no projects, the field becomes optional.
- An amber notice explains the degraded mode and that booking can proceed
  without a Project ID.
- With no Project ID, the backend already falls back to a local `AGN-YYMMDD-…`
  Episode ID (the project-linked Web App path is skipped), so the queue keeps
  working through the outage. The project can be linked later.

`src/app/page.tsx` — added `projectSelectable` / `projectsUnavailable` flags;
label `*`, `<select required>`, and submit validation are now gated on
`projectSelectable`.

---

## [1.19.0] — 2026-05-21

### Added — Video Type field on the booking form

A new **Video Type** classification, independent of the existing business
`Category`. Added as a new field (Category is unchanged).

- New column `Booking.videoType` (`String?`, nullable). Stored verbatim as the
  selected label to mirror the Producer Dashboard sheet values. Additive —
  `prisma db push` adds a nullable column, existing bookings keep `null`.
- Booking form (`src/app/page.tsx`) — new required **VIDEO TYPE** radio group
  with 7 options: Teaser / Highlight, Vlog / On Location, Report (Host +
  Insert), Interview, Documentary, Commercial, Others. Submit validation
  rejects an empty value ("Please select a Video Type.").
- `POST /api/bookings` persists `videoType`.
- Google Sheets sync — appends a **Video Type** column to the right of
  "Updated At" (col 29), keeping the hardcoded `COL` partial-update indices
  valid.
- Booking detail (`/dashboard/[id]`) shows the Video Type next to Category.

### Changed — AGENCY REFERENCE always visible

- The AGENCY REFERENCE field is now shown on every booking (previously only
  when Category = Advertorial) and is **optional**. Removed the now-unused
  `isAdvertorial` gate.

### Notes

- `videoType` is a plain string, not an enum — no enum migration, and the
  option list can change without a schema change.
- Sheet column is appended rightmost; if the Dashboard sheet already has a
  Video Type column elsewhere, tell me and I'll map to that position instead.

---

## [1.18.1] — 2026-05-21

### Changed — PROJECT ID field is now Content-Agency-only and required

On the main booking form (`src/app/page.tsx`):

- The **PROJECT ID** dropdown now renders **only when the outlet is Content
  Agency** (`outletCode === 'AGN'`). Other outlets never see it.
- For Content Agency it is now **required** (was "optional but recommended").
  Label shows the red `*`; the `<select>` has `required`; submit validation
  rejects an empty Project ID with "Please select a Project ID."
- `projectId` / `projectName` are now sent as `null` for any non-Content-Agency
  booking, so switching outlets after picking a project can't leak a stale
  Project ID into the payload.

No schema or backend change — `projectId` remains nullable on `Booking` for
non-Content-Agency outlets. Backend does not hard-require it (the form is the
only entry point for project-linked bookings).

---

## [1.18.0] — 2026-05-21

### Added — Booking code + atomic episode sequence + audit log

The booking ↔ episode pair now shares one ID format, and every booking change
leaves a 90-day audit trail.

**Booking code**

- New field `Booking.bookingCode` (`String?` `@unique`) — set on create to
  `episodes[0].episodeId`, so a booking is identified by the same
  `[OUT]-[YYMMDD]-[PROG]-[EE]` (or `PP-YY-NNN-LNN`) string as its first
  episode. Immutable once set; never recomputed.
- Backfilled at startup for pre-existing bookings (see ops-log).

**Atomic episode sequence (local-generation path)**

- New `src/lib/episode-sequence.ts` — `allocateEpisodeSequence(tx, …)` takes a
  PostgreSQL `pg_advisory_xact_lock` on the `(outlet, date, program)` tuple
  inside the booking transaction, so concurrent bookings on the same slot can
  no longer read the same `max(sequence)`. The lock auto-releases on
  commit/rollback.
- `withSequenceRetry(fn, 3)` — defense-in-depth retry on `P2002` if the lock
  somehow fails to engage. Logs a console warning when a retry fires so any
  Layer-1 regression surfaces in prod logs.
- Project-linked bookings (`projectId` + `episodeType`) remain unchanged —
  the Producer Dashboard Web App still owns the `EP_SEQ_` counter and is
  collision-free by construction.

**Audit log**

- New model `AuditLog` (id, at, actorEmail, action, entityType, entityId,
  bookingCode, fromStatus, toStatus, changes JSON). Indexed on `at`,
  `bookingCode`, `(entityType, entityId)`, and `action`.
- Logged actions (fire-and-forget, written outside the booking transaction so
  audit failure never blocks a save):
  - `booking.create` — full episode-IDs + slot context
  - `booking.update` — field-level diff over the editable-field whitelist
  - `booking.status_change` — separate row, with `fromStatus` / `toStatus`
  - `booking.delete` — soft-delete (status → CANCELLED) row
  - `audit.auto_email_sent` / `audit.purge_run` — meta-rows used for throttle
    and post-incident analysis
- New whitelist `src/lib/booking-status.ts` — rejects illegal transitions
  (e.g. `COMPLETED → REQUESTED`) with HTTP 400.

**Retention + CSV reminder (90-day rolling window)**

- New `src/lib/audit-retention.ts` — policy constants (`RETENTION_DAYS=90`,
  `WARNING_DAYS=14`, `AUTO_EMAIL_THROTTLE_HOURS=24`) and helpers
  (`getPurgeWarning`, `canSendAutoEmail`, `iterateAuditLogs`).
- `start.sh` runs `DELETE FROM audit_logs WHERE at < now() - INTERVAL '90 days'`
  on every boot (non-fatal).
- New endpoint `GET /api/audit/purge-warning` — admin-only; returns banner
  data and fires the auto-email helper.
- New endpoint `GET /api/audit/export` — admin-only; streams a UTF-8 CSV
  (BOM-prefixed for Excel/Thai support), paginates 500 rows at a time so
  memory stays flat.
- New endpoint `POST /api/audit/purge` — admin-only manual purge trigger.
- New endpoint `GET /api/bookings/:id/history` — per-booking audit trail.
- New `src/lib/audit-auto-email.ts` + `src/app/_components/AdminAuditBanner.tsx`
  — yellow banner on every admin page during the warning window, and a
  throttled (≤1 per 24 h) auto-email to every active admin with the CSV link.

### Files changed

- `prisma/schema.prisma` — `Booking.bookingCode`, model `AuditLog`
- `start.sh` — backfill `bookingCode`, purge `audit_logs`
- `src/lib/episode-sequence.ts`, `src/lib/audit.ts`, `src/lib/booking-status.ts`,
  `src/lib/csv.ts`, `src/lib/audit-retention.ts`, `src/lib/audit-auto-email.ts`
- `src/app/api/bookings/route.ts`, `src/app/api/bookings/[id]/route.ts`
- `src/app/api/bookings/[id]/history/route.ts`,
  `src/app/api/audit/purge-warning/route.ts`,
  `src/app/api/audit/export/route.ts`, `src/app/api/audit/purge/route.ts`
- `src/app/_components/AdminAuditBanner.tsx`, `src/app/admin/layout.tsx`

### Notes

- Audit writes are best-effort. In a crash between booking commit and audit
  write a row may be lost; the booking record remains authoritative.
- Booking POST now hard-caps at **20 episodes per request** (was unbounded);
  matches the operational ceiling.
- `shootDate` is validated (`isNaN(parsedDate.getTime())`) before any DB work.

---

## [1.17.0] — 2026-05-20

### Changed — Booking Category renamed

Renamed the `Category` enum on bookings to better reflect how the team
classifies shoots:

| Old              | New                |
|------------------|--------------------|
| Recurring        | Original Content   |
| Agency Job       | Advertorial        |
| Service Job      | Event              |
| Internal         | Internal (unchanged) |

- `prisma/schema.prisma` — `Category` enum values updated: `ORIGINAL_CONTENT`,
  `ADVERTORIAL`, `EVENT`, `INTERNAL`
- `start.sh` — added idempotent pre-migration step (`ALTER TYPE ... RENAME VALUE`)
  that runs before `prisma db push`, so existing rows keep their data and the
  column doesn't get dropped/recreated. Safe to re-run.
- UI: `src/app/page.tsx`, `src/app/booking/[outlet]/page.tsx`, `src/lib/data.ts`,
  `src/lib/utils.ts` — all option lists, label maps, default-state strings,
  and conditional logic (`isAgency → isAdvertorial`) updated.

### Migration notes

- The `ALTER TYPE ... RENAME VALUE` in `start.sh` is in-place — no data loss.
- The Agency Reference field (formerly shown for "Agency Job") now shows for
  "Advertorial" with the same label.

---

## [1.16.0] — 2026-05-09

### Added — Project ID layer (per memo from ปุ๊ก, 2026-05-08)

Production Booking now consumes the **Project ID** dropdown owned by the Producer
Dashboard ("All Projects" tab), so every booking can be tagged with the upstream
`PP-YY-NNN` identifier instead of free-text project names.

- New columns `projectId`, `projectName` on `Booking` (nullable, immutable once set)
- New module `src/lib/projects.ts` — fetches the dropdown list from
  `Producer Dashboard!All Projects!A2:D` via service-account read-only auth.
  Strict gate: only rows matching `^PP-\d{2}-\d{3}$` are accepted.
  Cached server-side for 5 min.
- New endpoint `GET /api/projects[?refresh=1]` — returns the cached list
- Booking form — adds Project ID dropdown that auto-fills Project Name + Producer
- Booking POST persists `projectId` + `projectName`
- Google Sheets sync — appends two new columns ("Project ID", "Project Name")
  on the right (cols U, V) so existing column indices in `updateBookingRow`
  stay valid
- Booking success page + admin booking detail render the Project ID

### Configurable env vars (optional)

- `PRODUCER_DASHBOARD_SHEET_ID` — defaults to the Producer Dashboard sheet
  ID from the memo
- `PRODUCER_DASHBOARD_TAB` — defaults to `All Projects`

The existing `GOOGLE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_SERVICE_ACCOUNT_EMAIL` +
`GOOGLE_PRIVATE_KEY`) must have read access to the Producer Dashboard sheet.

### Notes

- `projectId` is **optional** — existing bookings remain valid; new bookings
  can be submitted without it (form falls back gracefully if the sheet is
  unreachable)
- Migration is non-destructive — `prisma db push` adds two nullable columns
  on next boot

---

## [1.15.2] — 2026-05-09

### Fixed — Email send fails after ~1 hour of session age

Root cause: `getToken()` from `next-auth/jwt` only **decodes** the JWT cookie;
it does NOT trigger the `jwt` callback that contains the access-token refresh
logic. Result: any assignment / test-email call >1h after sign-in hit Gmail
with a stale access token and got 401.

- New `src/lib/google-token.ts` exports `getValidGoogleAccessToken(token)`
  that refreshes against `oauth2.googleapis.com/token` on demand
- Both assign and test-email routes now go through this helper
- Assign route is no longer fire-and-forget — emails are awaited and the
  response includes per-recipient `{ requested, sent, failed[{email,error,hint}] }`
- Admin UI surfaces real per-recipient errors with actionable hints

### Added — Portainer deployment alternative

- `docker-compose.portainer.yml` — Portainer-ready stack (Repository deploy)
- `.env.portainer.example` — env template
- `PORTAINER_DEPLOY.md` — step-by-step guide

---

## [1.5.0] — 2026-04-27

### Changed
- **Authentication: Google OAuth (NextAuth.js)** replaces email-only login
  - Google provider with `hd=thestandard.co` (Google Workspace hosted-domain hint)
  - Server-side `signIn` callback rejects any non-`@thestandard.co` email
  - JWT-based session strategy, 7-day expiry
  - Sign-in page: single "Sign in with Google" button
- **User auto-provisioning**: first sign-in creates a `User` row; `narasit.k@thestandard.co` is auto-promoted to ADMIN
- Disabled accounts (`User.active = false`) blocked from sign-in
- Middleware switched to `next-auth/jwt`'s `getToken`
- All custom auth API routes (`/api/auth/login`, `/logout`, `/me`) replaced by `/api/auth/[...nextauth]`
- `LogoutButton` now uses NextAuth's `signOut`

### Required env vars (new)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth 2.0 web client from Google Cloud Console
- `NEXTAUTH_SECRET` — random 48+ char string
- `NEXTAUTH_URL` — `https://production-booking-app.onrender.com`

### Dependencies
- `next-auth ^4.24.7`

---

## [1.4.0] — 2026-04-27

### Added
- **Authentication system** — email-based login with signed cookie session (HMAC-SHA256, 7-day expiry); only `@thestandard.co` accounts allowed
- **Role-based access control**: `USER` and `ADMIN` roles in DB
- **Initial admin bootstrap**: `narasit.k@thestandard.co` auto-promoted on first login
- **Admin-only routes**: `/dashboard` and `/admin` now require `ADMIN` role (server-side guard)
- **`/my-bookings`** — per-user view: bookings they requested or are assigned to + all CONFIRMED bookings, with tabs
- **`/admin/permissions`** — list users, promote/demote between USER/ADMIN, enable/disable accounts, add users by email; self-demotion lockout protection
- **Login page** at `/login` with `next=` redirect param
- **Layout**: shows logged-in email + Sign out button; admin-only nav links hidden for non-admins
- **Booking ownership**: `Booking.createdByEmail` captured from session; users see their own + assigned + confirmed
- API: `POST/PATCH/GET /api/admin/users`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- Edge middleware redirects unauthenticated requests to `/login`

### Fixed
- **Dashboard detail page crash** — replaced legacy `card`/`btn-primary`/`text-brand-*` classes (removed in v1.2.0) with current `gf-*` design system
- **BigInt JSON serialization** — `Upload.fileSize` now serialized as string in `GET /api/bookings/[id]` (Next.js `JSON.stringify` cannot serialize BigInt)
- **Dashboard list status filter** — replaced obsolete `PENDING` option with `REQUESTED` / `ASSIGNED` (matches new BookingStatus enum)

### Schema
- New `User` model + `UserRole` enum
- `Booking.createdByEmail String?` (new)

### Dependencies
- No new packages — auth uses Node's built-in `crypto.createHmac`

---

## [1.3.1] — 2026-04-27

### Added
- Admin assign panel: full team list (videographers, directors, sound, photographer, switcher) loaded from THE STANDARD employee directory
- Freelance section: name + contract no. + optional email, supports unlimited freelancers per booking; saved into Admin Notes

---

## [1.3.0] — 2026-04-27

### Added
- **Admin Console** (`/admin`) — tab-filtered view of all bookings by status (REQUESTED / ASSIGNED / CONFIRMED / CANCELLED / COMPLETED)
- **Admin Edit page** (`/admin/[id]`) — assign team members (videographers) by email with preset checkboxes + custom email input; admin notes; "Save & Send Email" sends Nodemailer assignment notifications
- **Approve action** — creates a Google Calendar event (Bangkok timezone) and confirms the booking; event ID stored back to DB
- **Google Sheets logging** — every new booking is appended to the master sheet (20 columns: IDs, dates, crew, status, calendar event ID); row index stored for later status updates
- **Google Calendar embedding** (`/calendar`) — full-width iframe of the production calendar (Asia/Bangkok)
- **Email notifications** — assignment email to crew + approval notification to producer via SMTP
- **New booking status flow**: REQUESTED → ASSIGNED → CONFIRMED (CANCELLED / COMPLETED also supported)
- Navigation links: Calendar, Dashboard, Upload, Admin added to top nav

### Changed
- Bookings now created with `status: REQUESTED` (was implicitly undefined)
- `statusLabel()` and `statusColor()` updated for all 5 statuses

### Dependencies added
- `googleapis ^140.0.1` — Google Sheets + Calendar API
- `nodemailer ^6.9.14` — SMTP email

---

## [1.2.0] — 2026-04-27

### Changed
- **UI redesign**: replaced outlet-card grid with a single Google Form-style booking page
- Outlet and Program are now cascade dropdowns on one page (no more per-outlet subpages)
- Removed Episode ID explainer section from homepage
- Dashboard re-styled to match Google Form aesthetic (clean white tables)
- Navigation simplified to top bar with Dashboard + Upload Footage links

### Removed
- Multi-card outlet selection landing page
- Step-by-step Episode ID decoder block
- Heavy brand-color card grid

---

## [1.1.0] — 2026-04-27

### Fixed
- Dockerfile: switched from multi-stage standalone to single-stage build (`npm install` instead of `npm ci --frozen-lockfile`) — resolves build failure due to missing `package-lock.json`
- Removed `output: 'standalone'` from `next.config.js` — simplifies server startup
- Removed Thai locale import from `date-fns` — resolves build-time module error
- `start.sh`: use `prisma db push` + `tsx seed` before `npm start`

### Added
- `start.sh`: auto-runs DB schema sync + seed on every container boot (idempotent)
- Dockerfile copies Prisma CLI + tsx into image for runtime migrations

---

## [1.0.0] — 2026-04-27

### Added
- Initial release: THE STANDARD Production Booking Platform
- **Menu page** with 9 outlet cards (NWS, WLT, SPT, POP, POD, KND, LIF, TSS, AGN)
- **Booking form** — 16 fields, conditional logic (location if not studio, agency ref if agency job)
- **Episode ID auto-generation** — format `[OUT]-[YYMMDD]-[PROG]-[EE]`, immutable, folder-only policy
- **Confirmation page** with Calendar Packet copy-paste ready for Production Coordinator (พี่ตุ้ย)
- **Dashboard** — list all bookings, filter by outlet/status, search by Episode ID
- **Booking detail** — status management (Pending → Confirmed → Completed), calendar packet, Drive folder path
- **Upload platform MVP** — footage logging by Episode ID + camera slot (Cam1–Cam4, Sound, Drone, BTS)
- **PostgreSQL + Prisma** schema: Outlet, Program, Booking, Episode, Upload models
- **Seed data**: 9 outlets × 56 programs from master spreadsheet
- **Docker + docker-compose**: app + PostgreSQL + Nginx reverse proxy, Portainer-ready
- **Render deployment**: web service + PostgreSQL, Singapore region, auto-deploy from GitHub
