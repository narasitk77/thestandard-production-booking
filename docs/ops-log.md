# Operations Log — Production Booking

A running journal of infrastructure events, fixes, and operator actions on
the self-hosted Portainer deployment at `probook.xtec9.xyz`. Newest first.

---

## 2026-05-24 · Proposed GHA post-build smoke test (v1.32.0) — needs manual apply

**Scope:** Proposed `smoke-test` job for
`.github/workflows/docker-build.yml` that boots the just-built image
against a throwaway Postgres and polls `/login` until ready. Catches
startup-time regressions before operator pulls in Portainer.

**⚠ Not yet applied to the workflow file:** the agent's GitHub PAT
lacks `workflow` scope, so direct edits to `.github/workflows/*.yml`
are rejected. Full YAML is at `docs/gha-smoke-test.yml.proposed`
with copy-paste-into-GitHub-UI instructions. Apply once via the
web UI (one-time, ~2 min) and it's done.

**Portainer redeploy notes:** none — this is a CI change only. The
running stack is unaffected.

**Files changed:**

- `docs/gha-smoke-test.yml.proposed` (new — full job YAML to paste).
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-24 · Cleanup + docs (v1.31.1) — no infra change, hygiene only

**Scope:** ESLint config so `npm run lint` works, new
`docs/architecture.md` + `docs/runbook-backup.md` for onboarding +
disaster recovery, legacy `/booking/[outlet]` route converted to a
redirect. No app behavior change.

**Portainer redeploy notes:** purely additive. Stack env unchanged.
Pull `sha-<this-commit>` if you want the cleanup; nothing breaks if
you don't.

**Files changed:**

- `.eslintrc.json` (new).
- `docs/architecture.md` (new — read this first when onboarding).
- `docs/runbook-backup.md` (new — backup PLAN; action items at the
  bottom for the human to actually wire up).
- `src/app/booking/[outlet]/page.tsx` — 400 lines → 10-line redirect
  to `/new`.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-24 · TEAM roster → DB + /admin/team CRUD (v1.31.0) — schema change (additive)

**Scope:** Move crew assignment roster from hardcoded `TEAM` constant
in `src/app/admin/[id]/page.tsx` to a new Prisma table `team_members`,
with a CRUD admin page at `/admin/team`. Adds 1 new table; no changes
to existing tables. Calendar / booking / approve / assign flows
unchanged.

**Heads-up — schema change:**

- New table `team_members` added via `prisma db push` (run
  automatically by `start.sh` on container start). No data loss
  because the table is new; existing tables untouched.
- `prisma/seed.ts` inserts 26 initial members from
  `src/lib/team-roster.ts` (matches the old hardcoded `TEAM` constant
  exactly) — only inserts rows missing from the DB, so subsequent
  seed runs preserve admin edits.

**Portainer redeploy notes:**

- Pull image `sha-<this-commit>`. Stack env unchanged from v1.30.0.
- After redeploy:
  1. Container log should show
     `==> Syncing database schema...` (db push) → new table created.
  2. Then `==> Seeding database (idempotent)...` →
     `✓ team_members: 26 inserted, 0 already present` on the first run.
     Subsequent runs print `0 inserted, 26 already present`.
- `/admin/team` should show 7 role sections (Producer / Coordinator,
  Videographer, Video Director, Sound Team, Photographer, Switcher,
  Virtual Production) with the seeded members.

**Verification after redeploy:**

1. Open `/admin/team`. 7 sections render with 26 total members.
2. Click Edit on any member → change display name → Save. Page
   refreshes; new name visible.
3. Open `/admin/[id]` for any REQUESTED booking. The "Assign crew"
   section shows the same roster, including your edited name.
4. Deactivate a member at `/admin/team`. Re-open `/admin/[id]`. The
   deactivated member no longer appears in assign UI; historical
   bookings that already had them assigned still show their email.
5. Toggle "Show inactive" on `/admin/team` → deactivated member
   reappears with an amber `inactive` chip and a Re-activate button.

**Rollback trigger:** if `/admin/team` or `/admin/[id]` assign UI
breaks. Revert to `sha-631292f` (v1.30.0); the `team_members` table
stays in the DB (harmless), the code reverts to reading the hardcoded
`TEAM` constant.

**Files changed:**

- `prisma/schema.prisma` — added `TeamMember` model.
- `prisma/seed.ts` — added team_members seed loop.
- `src/lib/team-roster.ts` (new) — RosterRole type, ROLE_ORDER,
  ROLE_LABEL, INITIAL_TEAM_ROSTER seed data, groupByRole helper.
- `src/app/api/admin/team/route.ts` (new) — GET list, POST create.
- `src/app/api/admin/team/[id]/route.ts` (new) — PATCH update, DELETE soft-delete.
- `src/app/admin/team/page.tsx` (new) — CRUD UI.
- `src/app/admin/[id]/page.tsx` — removed hardcoded TEAM, fetches from
  API with INITIAL_TEAM_ROSTER fallback.
- `src/app/admin/page.tsx` — added Team link in header.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-24 · Sheet config consolidation + /admin/health (v1.30.0) — no infra change, infrastructure for sandbox↔prod sheet swap

**Scope:** Internal-tooling release that paves the way for switching
the Producer Dashboard sheet from sandbox to a real production sheet
without code changes or surprises.

**What admins gain:**

- `/admin/health` — new page (linked from `/admin` header next to
  Permissions). Shows runtime config (sheet ids masked) plus live
  round-trip checks to the DB, Google Calendar, and Producer Dashboard
  sheet. Use it after every deploy / env change to confirm the
  container is actually pointed where you intended.
- Big amber **SANDBOX** banner on `/admin/health` when the deploy is
  using the fallback sheet id — impossible to miss before going live.
- `docs/runbook-sheet-swap.md` — checklist for the swap.

**What changed internally:**

- `src/lib/google-config.ts` — new single source of truth for the
  Producer Dashboard sheet id. The previously-duplicated
  `DEFAULT_DASHBOARD_SHEET_ID` in google-sheets.ts / projects.ts /
  people.ts / dashboard-episodes.ts is gone; all four now call
  `getProducerDashboardSheetId()`.
- `GET /api/health` — admin-only diagnostic endpoint that the
  `/admin/health` page consumes.

**Portainer redeploy notes:**

- Pull image `sha-<this-commit>`. Stack env unchanged from v1.29.4.
- No DB migration, no port change, no worker change.
- After deploy, hit `/admin/health` — confirm sheet section shows
  current config (masked) and live checks are green.

**Verification:**

1. Open `/admin/health` while signed in as admin. Page renders.
2. Top-line status reads "All systems operational" (green check).
3. Producer Dashboard sheet section shows:
   - Sheet ID (masked, e.g. `1rMLmQ…lARw`).
   - Source: `env`.
   - Mode: `✓ Production` (or `⚠ SANDBOX` if env unset — that's the
     banner up top).
4. Live checks all green:
   - Database — returns booking count.
   - Google Calendar — returns calendar title.
   - Producer Dashboard sheet — returns sheet title + tab list.
5. Click Re-check button — same response in ~200–500ms.

**Production sheet swap procedure** (when ready): see
`docs/runbook-sheet-swap.md`. Summary:

1. Share new sheet with service account
   `production-booking@production-booking-494605.iam.gserviceaccount.com`
   (Editor).
2. In Portainer stack env, set `PRODUCER_DASHBOARD_SHEET_ID` to the
   new id, Save settings, Pull and redeploy.
3. Verify on `/admin/health`: amber SANDBOX warning gone, sheet title
   updated, live check green.
4. Smoke-test with a CA booking.

**Rollback trigger:** none expected — this release is purely additive.
If `/admin/health` itself misbehaves, revert to `sha-4a9b5a9`
(v1.29.4); the underlying calendar fix stays.

**Files changed:**

- `src/lib/google-config.ts` (new) — sheet config helpers.
- `src/lib/google-sheets.ts`, `src/lib/projects.ts`, `src/lib/people.ts`,
  `src/lib/dashboard-episodes.ts` — switched to shared helpers.
- `src/app/api/health/route.ts` (new) — admin-only diagnostic endpoint.
- `src/app/admin/health/page.tsx` (new) — UI dashboard.
- `src/app/admin/page.tsx` — added Health link in header.
- `docs/runbook-sheet-swap.md` (new) — swap procedure.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-24 · Hardcoded impersonate fallback (v1.29.4) — fix for stale-compose deploy

**Scope:** Defensive bug fix for the long-running "calendar guests not
added" issue. After v1.29.3 made the real error message visible, live
diagnosis via Portainer + Google Admin confirmed:

1. ✓ Service account creds set in stack env.
2. ✓ Google Admin DWD granted for client `106117530552798836735` with
   `https://www.googleapis.com/auth/calendar` (full r/w).
3. ✓ Shared calendar "THE STANDARD Production Bookings" shared with
   `narasit.k@thestandard.co` with "Make changes and manage sharing".
4. ✓ Stack env editor shows `GOOGLE_IMPERSONATE_SUBJECT=
   narasit.k@thestandard.co`.
5. ❌ **Running container `process.env.GOOGLE_IMPERSONATE_SUBJECT`
   is undefined.**

Root cause: Portainer is Repository-mode, and the box's git fetch has
been failing intermittently — Portainer keeps reusing a stale cached
`docker-compose.portainer.yml` that pre-dates v1.26.4's
`${GOOGLE_IMPERSONATE_SUBJECT:-narasit.k@thestandard.co}` default. Stack
env edits never reach the container because the cached compose has no
`GOOGLE_IMPERSONATE_SUBJECT:` line under the `environment:` block at all.

**Fix:** code-level fallback in `src/lib/google-calendar.ts`. The
`getCalendarImpersonateSubject()` helper now returns
`narasit.k@thestandard.co` (the same default that's already in the
Portainer compose) when the env var is missing/empty, with a
one-time-per-process warning logged to the container log. Env var still
wins when set.

**Portainer redeploy notes:**

- Pull image `sha-<this-commit>`. Stack env unchanged.
- No DB migration. No worker change.
- After deploy:
  1. Container log's first calendar-related line should be
     `[calendar] GOOGLE_IMPERSONATE_SUBJECT env not set — using built-in
     fallback "narasit.k@thestandard.co" so DWD still works.` (or no
     line at all if a future Portainer redeploy successfully sets the
     env var — in which case the line is silenced, also fine.)
  2. On `/admin`, Re-sync the two known-bad bookings
     (PP-26-001-L01, PP-26-006-L01) — chips must turn green
     "✓ event created with N guests".
  3. Open the THE STANDARD Production Bookings calendar in Google
     Calendar — the new events should appear with the assigned crew
     as guests.

**Follow-up — fix Portainer's stale compose (separately):**

- Investigate why `Failed to fetch latest commit id of the stack 125`
  appeared in Portainer Notifications. Likely DNS or outbound network
  issue from the Portainer host to github.com. Verify with
  `docker exec portainer wget -O- https://github.com/narasitk77/thestandard-production-booking`.
- Once git fetch works, "Pull and redeploy" will refresh the compose
  and the env var will flow naturally. The code-level fallback can
  stay as a safety net.

**Rollback trigger:** none expected. The fallback only activates when
the env is missing, which currently is the only known state. Reverting
to `sha-9041ff5` (v1.29.3) brings back the diagnostic surface but not
the fix.

**Files changed:**

- `src/lib/google-calendar.ts` — `DEFAULT_IMPERSONATE_SUBJECT` constant,
  `getCalendarImpersonateSubject()` falls back with a one-time warning.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-23 · Surface real createCalendarEvent reason (v1.29.3) — diagnostic fix

**Scope:** Bug fix. v1.29.2 added the Re-sync button + result chip, but
the chip read "createCalendarEvent returned null" on the two affected
bookings — useful only insofar as it confirmed the call failed.
v1.29.3 changes `createCalendarEvent` to throw specific errors instead
of silently returning null, so the chip carries the *actual* reason.

**What admins will see after redeploy:**

- Re-sync on the same booking now returns one of:
  - `⚠ GOOGLE_IMPERSONATE_SUBJECT not set (or env value is empty after
    trim) — Domain-Wide Delegation is required …` → fix the Portainer
    env var.
  - `⚠ Google Calendar rejected event create with attendees: <upstream
    Google error>` → DWD scope drift / impersonated user lost calendar
    access / quota — investigate based on the upstream text.
  - `⚠ Google service account not configured — set
    GOOGLE_SERVICE_ACCOUNT_JSON …` → missing creds in the stack env.
  - `✓ event created with N guests` → it worked this time; the prior
    failure was transient.

**Portainer redeploy notes:**

- Pull `sha-<this-commit>`. Stack env unchanged. No DB migration.
- After deploy, Re-sync the two affected bookings (Content Agency
  Short Clip PP-26-001-L01, Content Agency Long Form PP-26-006-L01).
  The new chip will tell you exactly what's wrong. Most likely
  candidate based on the symptom: `GOOGLE_IMPERSONATE_SUBJECT` is set
  but has a trailing newline OR is set to a user that no longer has
  calendar access OR DWD was revoked.

**Verification:**

1. Re-sync the two known-bad bookings → chip carries a specific reason
   (not "returned null").
2. Fix the reason in Portainer env → redeploy → Re-sync again → chip
   turns green with `✓ event created with N guests`.
3. `AuditLog action='calendar.invite_failed'` rows for these bookings
   now include the same human-readable message in the `changes.error`
   field.

**Rollback trigger:** none expected — purely improves error messages.
Revert to `sha-196fd68` (v1.29.2) if anything regresses.

**Files changed:**

- `src/lib/google-calendar.ts` — throw with specific message instead
  of silent `return null` on known failure paths; re-throw in the
  outer catch.
- `src/lib/calendar-reconcile.ts` — friendlier message on the
  defensive null fallback.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-23 · Calendar status + Re-sync button on /admin (v1.29.2) — visibility fix

**Scope:** UI + endpoint for admins. No background worker / approve /
assign behavior change. Reaction to an ops report that a CONFIRMED
booking had no Google Calendar event and the admin had no way to see
*why* from inside the app.

**What changed for ops:**

1. Each CONFIRMED (and COMPLETED) booking card on `/admin` now shows
   either a blue "📅 Open in Calendar" link (when an event exists) or
   a red "⚠ No calendar event" chip (when it doesn't). No more guessing.
2. Every such card also gets a "Re-sync" button. Clicking it runs the
   exact same reconcile logic the background worker runs, but scoped to
   one booking and synchronous so the result appears inline:
   `✓ event created with 1 guest`, `✓ guests updated (3)`,
   `✓ already in sync`, or `⚠ <reason>`. No more waiting up to 10
   minutes for the worker tick.
3. The on-screen reason for a calendar failure (DWD off, Google API
   rejected, etc.) is now the *first place* admins see the diagnostic,
   instead of having to SSH in to read container logs or query
   `AuditLog`.

**Portainer redeploy notes:**

- Pull image tagged `sha-<this-commit>`. Stack env vars unchanged.
- No DB migration, no port change, no new worker process (still the
  one from v1.29.0).
- After deploy, re-open `/admin`, filter `CONFIRMED`, find the affected
  booking, click **Re-sync**. The inline result tells you what's wrong.

**Verification after redeploy:**

1. The Content Agency · Long Form booking from the ops report now shows
   a calendar chip + Re-sync button. Clicking Re-sync either turns the
   chip green ("📅 Open in Calendar" + `✓ event created with 1 guest`)
   or shows the failure reason inline.
2. New entry under `AuditLog action='calendar.reconcile_*'` for that
   booking confirms the run executed.
3. Re-sync on a booking that's already in sync returns
   `✓ already in sync` and writes a `calendar.reconcile_patched`
   row (no-op patch, dryRun=false).

**Rollback trigger:** none expected — this is additive. If the
`calendar-resync` endpoint misbehaves, revert to `sha-106ab50`
(v1.29.1); the rest of the calendar fix chain stays.

**Files changed:**

- `src/lib/calendar-reconcile.ts` — extracted per-booking
  `processBooking()` + added `reconcileSingleBooking(bookingId)`
  export. Existing bulk worker behavior unchanged.
- `src/app/api/admin/[id]/calendar-resync/route.ts` (new) — admin-auth
  endpoint that triggers the per-booking reconcile.
- `src/app/admin/page.tsx` — new `<CalendarStatus>` component on
  CONFIRMED/COMPLETED cards.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-23 · Reconciler hardening + Docker hygiene (v1.29.1) — operational fix, no behavior change

**Scope:** Dev-audit pass on v1.29.0's reconciler. Same feature surface —
the auto-reconciler still runs every 10 minutes, the strict
`requireAttendees` create path is unchanged, all AuditLog rows are
identical. This release hardens the worker against silent failure modes
and tightens the Docker build.

**What changed for ops:**

1. **Worker restarts itself.** `start.sh` now wraps
   `node scripts/calendar-reconcile-worker.js` in
   `while true; do …; sleep 5; done &`. A crash in the worker no longer
   leaves it dead for the container's lifetime.
2. **Worker logs config on boot.** First log line now reads e.g.
   `[calendar-reconcile] worker started; interval=600000ms;
   baseUrl=http://127.0.0.1:3000; secret=set`. If `secret=MISSING`
   that's the smoking gun — the endpoint will 401 every poll.
3. **Worker exits cleanly on SIGTERM.** Container stop now takes
   ~instant instead of waiting for the SIGKILL grace period.
4. **NaN interval bug fixed.** A non-numeric value in
   `CALENDAR_RECONCILE_INTERVAL_MS` (e.g. someone typing `"10min"`)
   used to silently turn into NaN → setInterval clamped to ~1ms → busy
   loop hammering the internal endpoint. Now falls back to 600000.
5. **`/changelog` no longer breaks if `.dockerignore` evolves.** New
   inline comment in `.dockerignore` explicitly notes that
   `CHANGELOG.md` and `USER_MANUAL_TH.md` are read at runtime by the
   app and MUST stay in the image. Codex's draft had silently excluded
   them.

**Portainer redeploy notes:**

- Pull image tagged `sha-<this-commit>` from GHCR. Stack env vars
  unchanged from v1.29.0 — no compose edit required.
- After deploy, the container log's first reconcile-related line should
  be `[calendar-reconcile] worker started; interval=600000ms;
  baseUrl=http://127.0.0.1:3000; secret=set`. If `secret=MISSING`,
  set `CALENDAR_RECONCILE_SECRET` (or just `NEXTAUTH_SECRET`) in the
  stack env and redeploy.

**Verification after redeploy:**

1. `docker logs <container>` shows the new worker startup line with
   `secret=set` and a non-NaN interval.
2. Kill the worker process inside the container (`docker exec ...
   pkill -f calendar-reconcile-worker`) — supervisor logs
   `supervisor: worker exited, restarting in 5s` and the new worker
   logs its startup line ~5s later. Web server stays up the whole time.
3. `docker stop <container>` exits in well under the 10-second default
   grace period (was previously stretching toward SIGKILL because the
   worker ignored SIGTERM).
4. `/changelog` page still renders the full CHANGELOG (regression
   check on the `.dockerignore` invariant).

**Rollback trigger:** none expected — this is purely defensive. If
needed, revert to `sha-c0c3e2f` (v1.29.0).

**Files changed:**

- `scripts/calendar-reconcile-worker.js` — NaN guard, startup log,
  SIGTERM handler, missing-secret warn.
- `start.sh` — supervisor loop around the worker.
- `.dockerignore` (NEW — committed; CHANGELOG.md and USER_MANUAL_TH.md
  deliberately stay in context).
- `.gitignore` — ignore `/backups`, `*.sql`, `*.dump`.
- `docker-compose.yml`, `docker-compose.portainer.yml` — document the
  `CALENDAR_RECONCILE_URL` override knob.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-23 · Calendar guest auto-reconciler (v1.29.0) — **infra change: new background worker**

**Scope:** Layered on top of v1.28.2's synchronous-on-assign fix. After
v1.28.2 deployed, ops still observed transient guest-loss (DWD blip,
patch rejected mid-flight, etc.). This release adds an **automated
reconciliation loop** so guests heal without manual re-assign, plus a
stricter create path that refuses to ship a guest-less event when the
booking already has assigned crew.

**Heads-up — this release CHANGES THE CONTAINER:**

1. `start.sh` now spawns a second process inside the container —
   `node scripts/calendar-reconcile-worker.js &` — that runs every
   `CALENDAR_RECONCILE_INTERVAL_MS` (default 600000 = 10 min). It hits
   the new internal endpoint `GET /api/internal/calendar/reconcile`,
   which pulls confirmed bookings and reconciles guest drift.
2. The worker authenticates with a shared secret read from
   `CALENDAR_RECONCILE_SECRET` → `NEXTAUTH_SECRET` → `AUTH_SECRET`.
   The Portainer compose now sets both `CALENDAR_RECONCILE_SECRET` and
   `CALENDAR_RECONCILE_INTERVAL_MS` (with sensible defaults), so the
   stack works without explicitly setting either.
3. Background worker logs only when it actually changes something
   (e.g. `[calendar-reconcile] checked=23 ok=22 patched=1 created=0
   failed=0`). Silent runs by design.

**Portainer redeploy notes:**

- Pull image `sha-452857f` (Codex's build) or whatever the latest GHCR
  tag is after this commit, **plus** redeploy the stack so the new env
  vars from `docker-compose.portainer.yml` get applied. The container
  needs the new `CALENDAR_RECONCILE_*` env vars for the worker to auth
  against the internal endpoint.
- No DB migration. No new mounts. No port changes.
- Existing `GOOGLE_IMPERSONATE_SUBJECT` env value should be checked —
  v1.29.0's `getCalendarImpersonateSubject()` trims trailing whitespace
  (which was silently disabling DWD before), but it doesn't fix a wrong
  value. If guests still don't appear after deploy, that's the first
  thing to inspect.

**Verification after redeploy:**

1. Container logs on startup should include
   `[calendar-reconcile] worker started; interval=600000ms`.
2. ~30 seconds after start, the first reconcile fires. With no drift
   the log stays silent; with drift the worker logs one line per pass
   and writes `calendar.reconcile_*` rows to `AuditLog`.
3. **Force a drift test:** open a CONFIRMED booking in the DB, set its
   `calendarEventId` to NULL (or to a known-bad id) by hand, wait ~10
   min (or hit `GET /api/internal/calendar/reconcile?limit=10` directly
   while signed in as admin). Booking should get a new event with the
   right guests; `AuditLog action='calendar.reconcile_created'` (or
   `_recreated`) row should appear.
4. **Manual one-off run** (admin browser):
   `https://probook.xtec9.xyz/api/internal/calendar/reconcile?limit=50`
   returns JSON `{success, checked, ok, patched, created, failed,
   items}`. Use `dryRun=1` first if you want to preview without
   touching Google.
5. **Strict-create test:** approve a booking that has crew assigned
   while DWD is intentionally broken (temporarily change
   `GOOGLE_IMPERSONATE_SUBJECT` to nonsense + restart). Approve should
   NOT create an empty event; admin UI should warn; `AuditLog
   action='calendar.invite_failed'` row should appear with
   `fallbackCreated: false`. Restore the env, redeploy.

**Rollback trigger:** if the reconciler creates duplicate events,
deletes legitimate guests, or thrashes Google API quotas — revert image
tag in Portainer to `sha-455b1af` (v1.28.2). The worker process simply
won't exist in the older image.

**Files changed:**

- `src/lib/calendar-reconcile.ts` (new) — reconciler core.
- `src/app/api/internal/calendar/reconcile/route.ts` (new) — worker
  endpoint.
- `scripts/calendar-reconcile-worker.js` (new) — background poller.
- `src/lib/google-calendar.ts` — strict `requireAttendees`, trimmed
  impersonation, Bangkok-aware datetime, `getCalendarEventAttendees`,
  improved `deleteCalendarEvent`.
- `src/app/api/admin/[id]/approve/route.ts`,
  `src/app/api/admin/[id]/assign/route.ts` — pass `requireAttendees`
  when crew is present, use `getCalendarImpersonateSubject()`.
- `start.sh` — spawn the worker.
- `docker-compose.portainer.yml` — new env vars.
- `docker-compose.yml` — parity with portainer compose (dev runs the
  same path).
- `CHANGELOG.md`, `package.json` — version bump 1.28.2 → 1.29.0.

---

## 2026-05-23 · Calendar guest sync fix (v1.28.2) — no infra change, behavior fix

**Scope:** Bug fix for the "assigned crew not showing as Google Calendar
guests" regression. Touches one API route + one admin UI surface. No
schema migration, no env-var change, no other API breakage.

**Why this matters:** assign-without-guests is a silent failure mode that
crew only notice when they don't get the invite. Ops requested an
"automation" that adds guests immediately on assign and tells the admin
when it didn't work. That's now wired.

**What's different after redeploy:**

- `/admin/[id]` Assign action now BLOCKS for ~0.5–2s while the calendar
  guest patch (or auto-create) happens, instead of returning instantly
  and dropping the result. Admins should expect a slightly longer "Save"
  click on assign — that's the calendar sync running.
- Toast message after Save Assign now includes calendar status:
  `· calendar guests updated (N)` (existing event), `· calendar event
  auto-created with N guests` (race-recover), or `· ⚠ calendar guests
  NOT added (<reason>)`. Last form means follow-up needed.
- If `GOOGLE_IMPERSONATE_SUBJECT` is missing/wrong (DWD off), the toast
  says so directly instead of going green. Was previously silently green.

**Verification after redeploy:**

1. Approve any REQUESTED booking. Within 5 seconds, click Assign with 2+
   crew → toast must read `calendar event auto-created with N guests`.
   Open the event in Google Calendar → guests visible.
2. Assign on a CONFIRMED booking that already has a calendar event → toast
   reads `calendar guests updated (N)`. Event guest list reflects the new
   list (added crew get invite, removed crew get cancellation — same as
   v1.26.x behavior, just now reported in the UI).
3. Re-assign with same crew list → no-op patch, toast still `updated (N)`.
4. (Negative path) If you intentionally unset `GOOGLE_IMPERSONATE_SUBJECT`
   in Portainer env and redeploy → assign toast reads `⚠ calendar guests
   NOT added (GOOGLE_IMPERSONATE_SUBJECT not set — cannot add calendar
   guests without Domain-Wide Delegation)`. Restore the env, redeploy.
5. Confirm `AuditLog` still gets `calendar.attendees_update_failed` rows
   on Google API errors — query `SELECT * FROM "AuditLog" WHERE action
   LIKE 'calendar.%' ORDER BY at DESC LIMIT 5`.

**Rollback trigger:** any regression in (a) the booking POST payload,
(b) approve's calendar event creation, (c) assignment email send, or
(d) Producer Dashboard sheet writes — revert image tag in Portainer to
`sha-46cf7ba` (v1.28.1).

**Files changed:**

- `src/app/api/admin/[id]/assign/route.ts` — sync calendar patch +
  auto-recover create branch + `calendarSync` in response.
- `src/app/admin/[id]/page.tsx` — toast includes calendar guest result;
  failed sync downgrades tone to warning.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-23 · Booking wizard step 4 reorder (v1.28.1) — no infra change

UI-only follow-up to v1.28.0: in the CA flow's Step 4 (People & Crew),
Project ID and Episodes now sit between Producer and Director so the
cascade reads top-to-bottom (Producer → Project → Episodes → Director →
Crew → Notes). No API/payload changes — pure JSX reorder.

**Files changed:**
- `src/app/_components/booking/BookingWizard.tsx`

---

## 2026-05-23 · Operations-console UI redesign (v1.28.0) — no infra change

**Scope:** UI/UX-only refactor across the user-facing surfaces. No schema
migration, no env-var change, no API breakage. Same Postgres rows, same
Google Calendar behavior, same email triggers, same Producer Dashboard
sync as v1.27.0. Safe to roll forward via the usual GHCR auto-build on
push to `fix/assign-email-real-results` / `main`; rollback is a plain
image revert in Portainer.

**What deploys can expect to see:**

- **`/` is no longer the booking form.** It is now an Overview page with
  KPI cards (Today / This week / Needs attention) and three lists
  (Today's schedule, My upcoming, Needs attention). The booking form
  moved to `/new`.
- A persistent **`+ New Booking`** button in the nav goes to `/new` from
  anywhere.
- The booking form is now a **5-step wizard** (Project → Schedule →
  Location → People & Crew → Review) with a sticky live summary on the
  right (desktop) and a fixed bottom action bar with collapsible summary
  (mobile). Submit only fires on the Review step's *Confirm & Submit*
  button — first-time returning users will likely notice the new flow.
- `/calendar` gets a Month/Agenda view toggle (auto-switches to Agenda
  on narrow viewports) and a slide-in detail drawer replaces the hover
  tooltip. Clicking any event opens the drawer.
- `/my-bookings` is now an inbox with **6 tabs** (Upcoming · Requested ·
  Assigned · Confirmed · Completed · Cancelled) and full-text search.
- App background is `#F6F7F9` (cool neutral) instead of `#F0EBF8` (light
  purple). Status pills, buttons, cards, and inputs all use the new
  8px-radius `.ops-*` primitives.

**Verification after redeploy:**

1. Open `/` while signed in → Overview page renders 3 KPI cards + 3 panels.
   Click *New Booking* → routes to `/new` (the wizard).
2. On `/new`:
   - Try to click *Next* on step 1 with nothing filled → red inline errors
     under each required field.
   - Pick a CA outlet (AGN) → Project ID + Episodes UI appears in step 4
     (was step 4 previously, location unchanged).
   - Walk through to step 5 (Review) → values populate; click *Edit* on
     any block → jumps back to the matching step.
   - *Confirm & Submit* on step 5 → existing success page; calendar invite
     fires with guests; Producer Dashboard sheet row appears (CA only).
   - On a phone-sized viewport: bottom action bar visible; tap *Summary*
     → expanded summary panel; tap *Next* → advances step.
3. `/calendar` → Month view loads by default on desktop; on mobile, Agenda
   view auto-selected. Click any event chip → drawer slides in
   (right-side on desktop, bottom sheet on mobile). Press Esc → drawer
   closes.
4. `/my-bookings` → 6 tabs with count chips. *Requested* tab is the queue
   for items awaiting coordinator action.
5. `/dashboard` (admin) → status colors match the rest of the app; donut
   includes ASSIGNED slice; status column in the table renders the new
   pill.
6. Confirm legacy pages still work: `/manual`, `/changelog`, `/login`,
   `/admin/*`, `/ot/*`, `/booking/success`. These deliberately still use
   the legacy `.gf-*` look — no visual regression intended there.

**Rollback trigger:** any regression in booking POST payload, calendar
event creation, Producer Dashboard sheet writes, or assignment email —
revert image tag in Portainer to v1.27.0.

**Files changed (UI only):**

- `tailwind.config.ts` — added `status-*` palette + `app` bg + `card`
  radius alias; safelisted dynamic status classes for purge.
- `src/app/globals.css` — added `.ops-*` primitives (card, input, label,
  button, tab, choice, table, empty). Legacy `.gf-*` kept.
- `src/app/layout.tsx` — unchanged behavior; visual changes inherit
  through globals.css.
- `src/app/_components/Nav.tsx` — primary/secondary split, More
  dropdown, compact brand, active-route chip, new CTA destination
  (`/new`).
- `src/app/_components/StatusPill.tsx` — new shared component.
- `src/app/_components/booking/BookingWizard.tsx` — new wizard.
- `src/app/page.tsx` — replaced legacy booking-form-as-home with
  Overview.
- `src/app/new/page.tsx` — new route renders the wizard.
- `src/app/calendar/page.tsx` — view toggle, agenda list, detail drawer.
- `src/app/my-bookings/page.tsx` — inbox-style multi-tab.
- `src/app/dashboard/page.tsx` — refined chrome, status palette alignment,
  StatusPill in table.
- `CHANGELOG.md`, `package.json` — version bump.

---

## 2026-05-23 · Booking flow UX overhaul (v1.27.0) — no infra change

**Scope:** UI/UX-only refactor of the booking surfaces. No schema migration,
no env-var change, no API breakage. Same Postgres rows, same Google Calendar
behavior, same email triggers as v1.26.5. Safe to roll forward via the usual
GHCR auto-build on push to `fix/assign-email-real-results` / `main`; rollback
is a plain image revert in Portainer.

**What deploys can expect to see:**

- `/` now shows a stepped booking form (6 sections, then a Review step) and a
  step indicator (Fill → Review). Submit only fires on the Review step's
  *Confirm & Submit* button — first-time users will likely notice this.
- `/calendar` event labels now read like `10:00 · AGN · Talk Show` instead of
  `10:00 AGN·T`. Hover preview unchanged.
- Top nav has a persistent `+ New Booking` CTA + reordered links (Calendar,
  My Bookings, Producer, Dashboard, Admin). Secondary items (OT, คู่มือ,
  อัปเดต, Upload [DEV]) sit behind a divider.
- `/dashboard` is renamed *Admin Dashboard* with three labelled sections.
  Still admin-only (route gating unchanged).

**Verification after redeploy:**

1. Open `/`, click *Review* without filling anything → field-level red errors
   appear under each empty required field (no top-of-form-only error).
2. Fill a Content Agency booking → step 2 *Review* shows all values
   correctly → *Confirm & Submit* creates the booking → calendar invite still
   fires with guests (regression check on v1.26.5 monitoring).
3. Open `/calendar` → confirm event chips show the full program name and
   truncate gracefully on narrow days.
4. Verify nav: non-admins should see *Calendar · My Bookings* (+ Producer if
   they have a Producer role); admins additionally see *Dashboard · Admin*.

**Rollback trigger:** any regression in booking POST payload, calendar event
creation, or assignment email — revert image tag in Portainer to v1.26.5.

**Files changed (UI only):**

- `src/app/page.tsx` — booking form refactor + Review step.
- `src/app/calendar/page.tsx` — event chip readability.
- `src/app/_components/Nav.tsx` — primary/secondary nav split + persistent CTA.
- `src/app/dashboard/page.tsx` — admin dashboard sectioning.

---

## 2026-05-23 · Calendar invite failures now observable (v1.26.5)

**Background:** v1.26.4 made calendar guests work by defaulting
`GOOGLE_IMPERSONATE_SUBJECT` in compose. But the failure mode is still silent:
if DWD is revoked, the impersonate user loses calendar access, or the account
is disabled, `createCalendarEvent` falls back to creating the event WITHOUT
guests and only emits a `console.warn`. Operators would only notice once crew
started missing invites in the wild.

**What v1.26.5 adds (app-only, no compose change required):**

- AuditLog rows on every failure — queryable from the admin audit page, kept
  for 90 days. Actions: `calendar.invite_failed` (insert fallback) and
  `calendar.attendees_update_failed` (patch failure on re-assign). Payload
  includes `eventId`, attendees, error, and current `GOOGLE_IMPERSONATE_SUBJECT`.
- Email alert to an admin, using the existing `sendEmail` infra. Recipient
  resolves to `CALENDAR_ALERT_EMAIL` (new optional env var) → falls back to
  `GOOGLE_IMPERSONATE_SUBJECT` → no-op if neither is set or no email provider
  is configured.

**New optional env var: `CALENDAR_ALERT_EMAIL`**

- **Default behavior (unset):** alerts go to `GOOGLE_IMPERSONATE_SUBJECT`
  (`narasit.k@thestandard.co`). No action needed.
- **Override:** set in the Portainer stack env if a different on-call address
  should receive alerts. Not added to `docker-compose.portainer.yml` because
  the fallback already covers the common case.

**How to verify post-deploy:**

1. Confirm the next confirmed booking with assigned crew still adds guests
   (regular success path — no AuditLog row, no email).
2. To exercise the alert path safely: temporarily set
   `GOOGLE_IMPERSONATE_SUBJECT` to a real Workspace user **without** calendar
   access in a staging stack, approve a booking, then check `audit_logs` for
   `action = 'calendar.invite_failed'` and the admin inbox for the alert.

**Files changed:**

- `src/lib/google-calendar.ts` — new `notifyCalendarAlert` helper; wired into
  both failure points.
- `src/app/api/admin/[id]/approve/route.ts`,
  `src/app/api/admin/[id]/assign/route.ts` — pass `bookingCode` through so
  alerts identify the booking by its readable code.

---

## 2026-05-23 · Calendar guests FIXED — `GOOGLE_IMPERSONATE_SUBJECT` was unset

**Symptom:** Approved bookings appear on the shared Google Calendar, but the
assigned crew are NOT added as guests (attendees) — only listed in the
description's "Assigned:" line.

**Root cause:** `GOOGLE_IMPERSONATE_SUBJECT` is unset in the deployment env, so
`createCalendarEvent` computes `canInvite = false` and creates the event with an
empty attendee list. (A bare service account can't invite attendees — see the
v1.26.0 entry below.) The DWD grant from v1.26.0 was done, but the env var that
turns it on was never set, so the code silently skipped attendees. No error.

**Diagnosis (local DWD probe, service account creds from `.env`):**
- Bare service account + attendee → `403 forbiddenForServiceAccounts`
  ("Service accounts cannot invite attendees without Domain-Wide Delegation").
- Impersonating `narasit.k@thestandard.co` + attendee → **SUCCESS** (event
  created with the guest, then deleted). ⇒ DWD is already granted in Workspace
  and this subject has access to the shared calendar.

**Why the first idea (set a stack env var) didn't take:** `docker-compose.portainer.yml`
interpolated `GOOGLE_IMPERSONATE_SUBJECT` from a *stack-level* env var
(`${GOOGLE_IMPERSONATE_SUBJECT:-}`). If it isn't added to the stack's
"Environment variables" — or the stack wasn't actually re-deployed — the
container gets an empty value and guests are silently skipped. A test redeploy
produced **no** calendar activity (no new event, no attendee update), confirming
the var never reached the container.

**Fix shipped (v1.26.4, deploy config — no app code change):**
1. **`docker-compose.portainer.yml`** → `GOOGLE_IMPERSONATE_SUBJECT` now defaults
   to `narasit.k@thestandard.co`
   (`${GOOGLE_IMPERSONATE_SUBJECT:-narasit.k@thestandard.co}`), so a redeploy
   enables guests with no stack env var to remember. A stack env var still
   overrides it.
2. Added the same line to local `.env` for parity.
3. **Retroactive backfill:** added guests to the 5 existing confirmed bookings
   that had crew in the "Assigned:" line but no attendees — impersonated
   `events.patch`, `sendUpdates:'none'` (no invite blast). Done from a local
   script using the SA key; no redeploy required for these.

Service account Client ID for DWD reference: `106117530552798836735`, scope
`https://www.googleapis.com/auth/calendar`.

**Remaining step (operator):** redeploy the Portainer stack so it picks up the
updated compose (pull `fix/assign-email-real-results` / the v1.26.4 image, then
**Update the stack**). After that, **new** approvals add guests automatically.

**Verify:** approve a booking that has assigned crew → the crew appear as guests
on the event (organizer becomes `narasit.k@thestandard.co`) and get an invite.

---

## 2026-05-22 · Calendar guests — Domain-Wide Delegation setup (v1.26.0)

To add assigned crew as real event guests (not just a description line), the
service account must impersonate a Workspace user (DWD) — a bare service account
can't invite attendees.

1. **GCP** → the service account → copy its **Client ID** ("Unique ID", a long
   number).
2. **Workspace Admin** → Security → Access and data control → **API controls** →
   **Domain-wide delegation** → Add new → Client ID = that ID, OAuth scope =
   `https://www.googleapis.com/auth/calendar`.
3. **Portainer stack env** → set `GOOGLE_IMPERSONATE_SUBJECT` = a
   `@thestandard.co` user who can manage the shared calendar (e.g. the calendar
   owner / an admin). The service account acts as them → becomes the event
   organizer → can invite guests + send invites.
4. Redeploy.

**Without these:** the app logs a warning and creates the event **without**
guests (crew remain in the "Assigned:" description line) — no error, bookings
still work. So this is safe to ship before DWD is configured.

**Verify:** confirm a booking → the assigned crew should receive a Google
Calendar invite and appear as guests on the event.

---

## 2026-05-22 · Booking = Production (select existing episodes) + drop Episode @unique (v1.24.0)

Content Agency bookings no longer GENERATE episodes — they SELECT existing ones
(from the "_EPs" tab, Published excluded) and mint a **Production ID**
(`AGN-260423-EVT-01`). See CHANGELOG [1.24.0] for the full model.

**Schema change:** `Episode.episodeId` dropped its `@unique` constraint (an
episode can be shot in multiple Productions). `prisma db push --accept-data-loss`
on boot applies it — dropping a unique index is non-destructive (no data loss).

**No new env / no migration data step.** Episodes are read live from the sheet
(`_EPs`), so nothing to backfill. Nothing is written back to the `_EPs`/`PD`/`Dir`
episode rows — only the Bookings tab + DB.

**Verify after deploy:** book Content Agency → select project (e.g. Yamaha
`PP-26-006`) → the form lists `PP-26-006-L01`, `PP-26-006-S01` (Post-production),
NOT Published ones → multi-select → booking code becomes a Production ID like
`AGN-260522-EVT-01`, and the chosen episodes show on the booking.

---

## 2026-05-22 · Retire Apps Script Web App — project Episode IDs minted in-app (v1.22.0)

After the Web App's repeated operational failures (502 hang, env lost, then a
**dead deployment URL** — `…/AKfycbw2qiH…/exec` returned Google "ไม่พบเพจ"), we
removed the Apps Script dependency entirely. The app now mints
`PP-YY-NNN-{type}NN` IDs and writes the PD/Dir tabs itself via the Google
service account (`src/lib/dashboard-episodes.ts`).

**Required ops steps for this to be correct:**

1. **Service account edit access** — already in place (it writes the Bookings
   tab today), so no change needed.
2. **Disable the sheet's onEdit episode auto-gen trigger.** The app numbers from
   the producer's "PD &lt;producer&gt;" tab; the old onEdit used a separate
   `EP_SEQ` Script Property the app can't update. With booking now app-only the
   onEdit is dormant, but disable it so it can never fire and double-number.
3. The old `BOOKING_EPISODE_WEBAPP_URL` / `_SECRET` env are dead — can be
   removed from the Portainer stack (harmless if left).

**Verify after deploy:** create a project booking (e.g. Yamaha `PP-26-006`,
type T) → episodes should be `PP-26-006-T0N` and appear in "PD &lt;producer&gt;"
+ "Dir. &lt;director&gt;" tabs. If it errors `ออก Project ID ไม่ได้ (Dashboard:
…)`, the message says why (project not in All Projects / PD tab missing / sheet
unreachable).

**Numbering source of truth is now the PD tab** — old projects with hand-typed
episodes continue correctly with no migration (their episodes are already in the
PD tab, which the app scans for the max).

---

## 2026-05-22 · "AGN instead of PP" — Web App env lost + Episode-ID path simplified (v1.21.0)

**Symptom:** project-linked bookings (e.g. Yamaha `PP-26-006`) produced local
`AGN-260522-T-01..03` Episode IDs instead of `PP-26-006-T01..`.

**Root cause:** `BOOKING_EPISODE_WEBAPP_URL` / `BOOKING_EPISODE_WEBAPP_SECRET`
were **missing from the running container** (env lost during a redeploy — they
were documented as set at `sha-b597c3c` but didn't survive). The v1.20.0 silent
fallback then minted local IDs.

**Two-part fix:**

1. **Config (ops):** restore the two env vars in the Portainer stack — URL is in
   this log's "Where things live"; secret lives in the Apps Script Script
   Properties (`BOOKING_API_SECRET`). **Recreate the container** so they reach
   `process.env`. Verify:
   ```
   docker exec production-booking-app printenv | grep BOOKING_EPISODE
   ```
2. **Code (v1.21.0):** removed the silent fallback — a project booking now
   returns a clear `503` if the Web App is unreachable, instead of silently
   producing a wrong-format / out-of-sequence ID. Also removed the
   advisory-lock + retry scaffolding (over-engineered for the real load).

**Why the Web App stays:** the Dashboard sheet auto-generates Episode IDs via
its own onEdit trigger; the Web App keeps booking-created IDs in that **same
shared `EP_SEQ` sequence** and writes the PD/Dir tabs. The app cannot mint
project IDs locally without breaking that shared sequence — so for project
bookings the Web App is the single source, and "fail loud" beats "silent local".

**Guard against recurrence:** after any stack redeploy, confirm the env block
matches this log's "Env vars set in Portainer stack" — never blank the two
`BOOKING_EPISODE_*` vars.

---

## 2026-05-21 · Incident — booking POST 502 ("Unexpected token '<'") → fixed in v1.20.0

**Symptom:** Content Agency booking submit failed with `Unexpected token '<',
"<!DOCTYPE "... is not valid JSON`. After redeploy it became the v1.19.2 banner
"HTTP 502 — app restarting".

**Diagnosis (no app crash):**
- `GET /`, `POST /api/bookings` (unauth) → fast JSON every time (5/5 probes) →
  app stable, not crash-looping.
- App container logs: clean startup (`✓ Ready in 5.4s`), no error, no restart
  loop. So the POST was not throwing — it was **hanging**.
- 502 is from NPM (HTML body), i.e. NPM gave up waiting for the upstream.
- Sheet-backed routes (`/api/projects`, `/api/people`) worked; the differentiator
  on the failing path is the **Apps Script Web App** call for project-linked
  Episode IDs. The host has known IPv6-egress issues with Google
  (`NODE_OPTIONS=--dns-result-order=ipv4first` in the compose), and an
  `AbortController` can't always interrupt a socket wedged in connect → the
  `await` hung → NPM 502.

**Fix (v1.20.0):**
- `requestEpisodeIds` now uses a `Promise.race` hard 12s timeout (not just
  AbortController) — guaranteed to return.
- The booking POST falls back to local Episode IDs when the Web App fails, so a
  Web App/Dashboard outage never blocks a booking (episodes get `AGN-…` IDs;
  `projectId` still saved). Logged via `console.warn`.

**Operational note:** during a Web App outage, watch
`docker logs production-booking-app | grep 'Web App unavailable'` to find
bookings that got local Episode IDs, in case they need re-issuing once the Web
App is healthy.

**Deploy:** image `sha-` of the v1.20.0 commit; standard Portainer re-pull +
recreate. No schema change.

---

## 2026-05-21 · Migration — bookingCode backfill + AuditLog table + 90-day retention

Adds an audit trail to every booking change and gives booking + episode a
shared human-readable ID. See `CHANGELOG.md` [1.18.0] for the full feature
list. This entry covers the operational concerns only.

### Schema delta

- `bookings.bookingCode` — new column, `TEXT NULL UNIQUE`
- `audit_logs` — new table (id, at, actorEmail, action, entityType, entityId,
  bookingCode, fromStatus, toStatus, changes JSONB) + four indexes

`prisma db push --accept-data-loss` handles both — additive change, no
existing column is dropped.

### Backfill (idempotent, post-push)

`start.sh` runs after `db push`:

```sql
UPDATE bookings b
   SET "bookingCode" = (
     SELECT e."episodeId" FROM episodes e
     WHERE e."bookingId" = b.id
     ORDER BY e.sequence ASC LIMIT 1
   )
 WHERE b."bookingCode" IS NULL;
```

`WHERE bookingCode IS NULL` makes it a no-op on second boot. Bookings with
zero episodes (shouldn't exist; defensive) keep `NULL` — `@unique` permits
multiple NULLs.

### Retention purge (90 days, every boot)

```sh
psql "$DATABASE_URL" -c "DELETE FROM audit_logs WHERE at < now() - INTERVAL '90 days'"
```

Non-fatal (`|| echo`) — failure on first boot before the table exists is
ignored. Can also be triggered manually by an admin via
`POST /api/audit/purge` without restarting the service.

### Pre-purge warning + CSV export

- Admins see a yellow banner on every admin page when there are rows in the
  14-day "warning window" (older than 76 days but younger than 90).
- The banner links to `/api/audit/export?from=…` which streams a UTF-8 CSV
  (BOM-prefixed; Excel opens Thai cleanly).
- The same banner load also fires an auto-email to every active admin
  (throttled ≤ once / 24 h via the `audit.auto_email_sent` marker row).

Email provider follows existing precedence
(`EMAIL_PROVIDER` → `RESEND_API_KEY` → `gmail-oauth` → SMTP); no new env vars
needed.

### Concurrency hardening

Local episode-sequence generation now takes a PostgreSQL advisory lock per
`(outlet, date, program)` slot inside the booking transaction
(`pg_advisory_xact_lock(hashtextextended(key, 0))`). Combined with a 3-try
retry on `P2002`, this makes 20-EP simultaneous bookings safe even on the
local generation path. Project-linked bookings already had this property
through the Producer Dashboard Web App counter — unchanged.

### Deploy checklist

- [ ] Build new image and push: `ghcr.io/narasitk77/thestandard-production-booking:sha-<new>`
- [ ] Redeploy Portainer stack — `start.sh` runs the backfill + purge automatically
- [ ] Sanity: open `/admin` as an admin; expect bookings list to render (no banner
      yet because there's nothing in the warning window)
- [ ] Sanity: create a new booking with 2+ episodes; verify `bookingCode` in the
      DB equals `episodes[0].episodeId`
- [ ] Sanity: PATCH a booking status (e.g. `REQUESTED → ASSIGNED`); confirm
      `GET /api/bookings/:id/history` returns the `booking.status_change` row
- [ ] Sanity: hit `/api/audit/export` — should download a CSV with the BOM
      and at least the create + status-change rows from above

### Rollback path

If something breaks: revert the image tag in Portainer to `sha-<previous>`.
Schema change is additive (column + table), so the old code keeps working
against the new DB — no schema rollback needed unless we explicitly remove
the column/table.

---

## 2026-05-20 · Migration — Booking Category enum rename (in-place)

Renamed the `Category` enum values on `bookings.category` without dropping
data. Old → New: `RECURRING → ORIGINAL_CONTENT`, `AGENCY_JOB → ADVERTORIAL`,
`SERVICE_JOB → EVENT`, `INTERNAL` (unchanged).

### Migration mechanism

Added an idempotent `DO $$ ... $$` block to `start.sh` that runs **before**
`prisma db push --accept-data-loss`. It uses `ALTER TYPE "Category" RENAME
VALUE 'OLD' TO 'NEW'`, which mutates the enum type in place — existing rows
keep their data, no column drop/recreate, no `--accept-data-loss` collateral.

The block guards each rename with `pg_enum` existence checks, so it's safe to:
- Run on a fresh DB (the type doesn't exist yet — outer `pg_type` guard skips it)
- Run a second time after rollout (old labels are gone — inner checks skip)
- Roll back to v1.16.x if needed (the new enum values become "orphans" but
  `start.sh` would re-run on next boot of older code; only forward path tested)

### Deploy checklist

- [ ] Build new image: `ghcr.io/narasitk77/thestandard-production-booking:sha-<new>`
- [ ] Redeploy Portainer stack — `start.sh` runs the SQL block automatically
- [ ] Verify `probook.xtec9.xyz` form shows new labels
- [ ] Spot-check existing bookings in admin — Category column should display
      "Original Content", "Advertorial", "Event", "Internal" via `categoryLabel()`

---

## 2026-05-20 · Sprint deploy — Episode-Type unification + sheet integration

Big push. `ghcr.io/narasitk77/thestandard-production-booking:sha-b597c3c`
is live on `probook.xtec9.xyz` (verified via root-page chunk fingerprint
`page-0ab30e59e376fc84.js`, HTTP 200, cache-busted).

### Shipped this sprint (oldest commit on top so the feature progression reads naturally)

| Commit | What |
|---|---|
| `27615c2` | **Phase 1** — `projects.ts` column-mapping bug fix (was reading Client as Producer) + hide projects whose every episode on `_EPs` is `Published`. |
| `77dc985` | Standalone Apps Script Web App endpoint (`apps-script/booking-episode-endpoint.gs`) that ปุ๊ก / sheet owner drops in as a new file — no edits to existing trigger code. Only sharing the `EP_SEQ_*` ScriptProperties counter with `onEditEpisode`. |
| `1a4429b` | `bookingSeedCounters()` for the pilot copy — ScriptProperties don't carry over with File → Make a Copy, so the function scans PD tabs and seeds `EP_SEQ_<project>_<type>` to (max NN + 1). |
| `13a7dec` | **Phase 2** — booking app calls the Web App for project-linked bookings; `Booking.episodeType` is forwarded; sheet stays the single owner of Episode-ID numbering. |
| `07bc480` | **OT — per-person bulk approval.** `OTRecord.approvalStatus` enum + `/api/ot/admin/approve` route. UI shows amber "Approve N" button → green "✓ N" pill once signed off. |
| `876c8a7` | New-booking form gains `videographerCount` (1-10 next to the Videographer checkbox). Assign page gains a **Main Videographer (ช่างภาพหลัก)** picker. |
| `f4df207` | `bookingBackfillDirStatus()` — fixes the "ดึงข้อมูลได้บ้างไม่ได้บ้าง" gap in the pilot's Dir-tab Status column (event-sync triggers don't carry over with Make a Copy). |
| `f04f8bc` | (intermediate) Episode Type doubles as Program for Content Agency + Project. |
| `415ddbf` | Main Videographer picker restricted to assignees that are in `TEAM.video` (was listing every assigned email). |
| `bf9c7b9` | Project dropdown filters by the selected Producer — pick ไนซ์ → see only ไนซ์'s projects; switching Producer resets Project + Episode Type so a stale pick can't carry over. |
| `b597c3c` | **Form simplification — universal Episode Type.** Program → Episode Type for every outlet (L / S / A / T with descriptive Thai labels). Removes the separate AGN+Project picker. Shoot Type drops "Remote / Online". Location custom input accepts a Google Maps link. CREATIVE / HOST → **แขก / SUBJECT**. |

### Where things live

| | |
|---|---|
| App | `https://probook.xtec9.xyz` · stack `production-booking` on Portainer |
| Image | `ghcr.io/narasitk77/thestandard-production-booking:sha-b597c3c` (`latest` also points here) |
| GitHub | `narasitk77/thestandard-production-booking` (main branch tracks live) |
| Pilot sheet | `1rMLmQIS237UDKLtTjTP0IC9pZ_4eWn4FxiTG0XflARw` — `Dashboard: Production Project 2026 for pilot` |
| Master sheet (untouched) | `10TnR03z7qx1gYf6yCqnFG3TDcvEAwXpZqSJTMNpSzL4` — `Dashboard: Production Project 2026` (chonlathorn.j) |
| Apps Script project | `1D_lcNWz-fS3LOsDIod0Kj9CFEMsaG5Cbsazzi5nkPwrx9FPY3MGRqrlS` ("IVW EPs Migration", bound to pilot copy in this deploy) |
| Web App endpoint | `https://script.google.com/macros/s/AKfycbw2qiH11E0jVwvkT6kv_msWwcyooxx4mqPa37yQcKhF71ih9xbXQWD6pEL0B1zmxsRi/exec` |
| `BOOKING_API_SECRET` / `BOOKING_EPISODE_WEBAPP_SECRET` | stored in Portainer stack env vars + Apps Script Script Properties (don't paste here) |
| Docker host | `192.168.21.220` (private LAN) |

### Env vars set in Portainer stack (booking-relevant)

```
PRODUCER_DASHBOARD_SHEET_ID    = 1rMLmQIS237UDKLtTjTP0IC9pZ_4eWn4FxiTG0XflARw
BOOKING_EPISODE_WEBAPP_URL     = https://script.google.com/macros/s/AKfycbw2qi.../exec
BOOKING_EPISODE_WEBAPP_SECRET  = <set; secret stored only in Portainer + Apps Script>
IMAGE_TAG                      = sha-b597c3c
```

### Deploy cadence note

Each push to `main` builds `sha-<commit>` + retags `latest` (workflow:
`.github/workflows/docker-build.yml`). Portainer does NOT auto-redeploy
on push — you must bump `IMAGE_TAG` to the new sha and check "Re-pull
image and redeploy" in **Update the stack**. The Portainer "fetch git
refs" warning during this step is non-blocking — the image pull goes
through `ghcr.io` directly.

---

## 2026-05-20 · Docker host DNS — `ghcr.io` unresolvable   ✅ RESOLVED

**Symptom (Portainer notification):**

```
Failed to pull images of the stack: compose pull operation failed:
Error response from daemon:
Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io on 192.168.21.221:53:
no such host
```

Plus a recurring warning from the same DNS box:

```
Failed to fetch latest commit id of the stack 125: failed to list
repository refs: Get ".../info/refs?service=git-upload-pack":
dial tcp: lookup github.com on 127.0.0.11:53: server misbehaving
```

**Impact while open**

The IMAGE_TAG bump from `sha-bf9c7b9` to `sha-b597c3c` was blocked —
the Docker daemon itself couldn't resolve `ghcr.io` to pull the image.
Stack stayed on the previous tag (cached locally on the host).

**Root cause**

The LAN DNS server at `192.168.21.221` was not resolving external
hostnames. Both the Docker daemon (directly) and the Portainer
container (via Docker's embedded resolver `127.0.0.11`) forward to
it, so both saw failures.

**Fix applied**

SSH'd to `192.168.21.220` and patched `/etc/docker/daemon.json` to
bypass the broken LAN DNS:

```json
{ "dns": ["1.1.1.1", "8.8.8.8"] }
```

Followed by `sudo systemctl restart docker`. After restart, the
daemon resolves external hostnames directly via Cloudflare/Google
DNS, and Portainer "Update the stack" with re-pull succeeded.

**If this happens again** — same fix. The `daemon.json` change is
persistent across reboots; if it's somehow reverted, re-apply.

---

## 2026-05-20 · Pilot Dashboard sheet — `Anyone with link can edit`   🟡 STILL OPEN

The pilot copy `1rMLmQIS237UDKLtTjTP0IC9pZ_4eWn4FxiTG0XflARw` is shared
with public-write (`{type:anyone, role:writer}`). This works for the
booking app's service account (it's covered by "anyone"), but anyone
who learns the sheet ID can rewrite the data.

**Fix to apply at convenience**

Open the sheet → Share → switch General access from "Anyone with the
link" to "Restricted" → add the service-account email (the value of
`GOOGLE_SERVICE_ACCOUNT_EMAIL` in Portainer stack env) as Editor.

**Status: still open** — flagged but not yet fixed. App will keep
working after this change since the service account remains an
Editor; only public unauthenticated edits get cut off.

---

## 2026-05-20 · Apps Script Web App — curl redirect quirk on POST   ✅ RESOLVED

When the Web App was first deployed, `curl -L -X POST` against
`/exec` returned a Google Drive "ไม่พบเพจ" 404 page even with
`Anyone` access set correctly. Switching the client to Node `fetch`
(what the booking app uses in production) returned the expected
JSON immediately.

Root cause was the way curl follows the Apps Script POST 302 redirect
chain to `script.googleusercontent.com/macros/echo?user_content_key=...` —
the followed request loses the POST method/body. Not an Apps Script
problem and not a deployment problem.

**Verified working** via Node fetch with three safe tests:

| Test | Response |
|---|---|
| Wrong secret | `{ok:false, error:"unauthorized"}` |
| Right secret + bad type | `{ok:false, error:"bad type — expect L, S, A or T"}` |
| Right secret + bad projectId | `{ok:false, error:"bad projectId (expect PP-YY-NNN)"}` |

---

## Known follow-ups (cross-cutting)

- **Orphaned `/booking/[outlet]` form** (`src/app/booking/[outlet]/page.tsx`)
  is unlinked from any nav and bypasses every recent improvement
  (Producer/Director conditional, required Shoot End Date, Episode Type,
  Web App integration, ...). Flagged earlier in this conversation via a
  spawn_task chip. Decide whether to delete or redirect to `/`.

- **`production-management` (Panu)** — repo at
  `https://github.com/Panu-PookenZ/production-management` is private and
  was raised by the user but never accessed. Future integration to be
  scoped if/when the user wants to bring that system into the same data
  spine as this app.

---
