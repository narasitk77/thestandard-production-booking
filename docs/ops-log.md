# Operations Log — Production Booking

A running journal of infrastructure events, fixes, and operator actions on
the self-hosted Portainer deployment at `probook.xtec9.xyz`. Newest first.

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
