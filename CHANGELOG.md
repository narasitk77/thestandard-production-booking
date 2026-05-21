# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
