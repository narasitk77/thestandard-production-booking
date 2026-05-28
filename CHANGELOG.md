# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.35.4] — 2026-05-28

### Fixed — `/upload` strictly limits to CONFIRMED + COMPLETED everywhere

Two leaks in v1.35.3 closed:

#### 1. Admin's list view missed COMPLETED rows

The admin path fetched `/api/bookings?status=CONFIRMED` only — the
underlying API accepts a single status param at a time, so a single
fetch silently dropped every COMPLETED booking from the admin's
upload list. They had to know the URL or use `/my-bookings` to reach
those.

Fix: admin path now fires **two parallel fetches** (`status=CONFIRMED`
and `status=COMPLETED`), dedupes by id, and sorts by `shootDate` desc.
Crew path (`?scope=mine&limit=200`) was already correct — it fetches
all of the crew's assignments and filters client-side, which already
caught both statuses.

#### 2. Single-booking deep-link didn't warn on bad status upfront

If a user pasted `/upload?bookingId=X` where X happened to be
REQUESTED / ASSIGNED / CANCELLED, the page used to render the full
`UploadSection` and only show the failure when they tried to upload
(403 BAD_STATUS from `/api/upload/init`).

Fix: page now shows the booking's status badge in the header and, if
status is anything other than CONFIRMED / COMPLETED, replaces
UploadSection with a clear advisory:

```
Booking นี้สถานะ REQUESTED — upload ทำได้เฉพาะ CONFIRMED หรือ COMPLETED เท่านั้น
รอ Admin approve booking ก่อน — แจ้ง Producer
[← เลือก booking อื่น]
```

Server gate unchanged — `/api/upload/init` still 403s; this is a UX
fix so the user sees the reason without first composing files.

#### Rollback

Pure UI / fetch logic change in `/upload/page.tsx`. Bump
`IMAGE_TAG` back to `sha-8b7a2bb` (v1.35.3) to revert; the API gate
stays correct either way.

---

## [1.35.3] — 2026-05-28

### Fixed — Crew can actually reach the upload UI + assignment gate

v1.35.2 placed the Upload section on `/admin/[id]`, but `/admin` is
ADMIN-only via layout — so the video/sound crew the feature was built
for couldn't actually get there. This release opens up `/upload` (was
admin-only "under development") as the proper crew-facing entry point
and adds the per-booking assignment check the user asked for:

> "User คนนั้นจะสามารถเลือกได้แค่งานที่ตัวเองถูก assign และงานที่
> จะอัพได้ต้อง [CONFIRMED/COMPLETED]"

#### `/upload` rewrite (was the legacy admin-only stub)

- **Layout gate** flipped from "ADMIN only" to "anyone with upload
  access" (`getUploadAccess` = ADMIN or active TeamMember with role
  in `{video, sound}`). The under-development banner is gone.
- **Page** has two modes driven by `?bookingId=X`:
  - With param → renders the same `UploadSection` component used on
    `/admin/[id]`, with the booking context loaded from the URL.
    Server enforces the per-booking gate (see below) so a non-assigned
    user navigating directly to `/upload?bookingId=X` gets a 403.
  - Without param → shows a searchable list of the bookings the user
    can act on. Admins see all CONFIRMED/COMPLETED; crew sees only
    `?scope=mine` results (their own assignments).

#### `canUploadToBooking(email, bookingOrId)` — new helper in `src/lib/session.ts`

Single source of truth combining all three gates:

```ts
{
  ok: boolean,
  reason?: 'NO_UPLOAD_ROLE' | 'NOT_ASSIGNED' | 'BAD_STATUS' | 'BOOKING_NOT_FOUND',
  isAdmin?: boolean,
}
```

Rules:
- Inactive `User` → `NO_UPLOAD_ROLE`
- Non-admin without `TeamMember` role `video`/`sound` → `NO_UPLOAD_ROLE`
- Booking status not in `{CONFIRMED, COMPLETED}` → `BAD_STATUS`
- **Non-admin not listed in `Booking.assignedEmails`** → `NOT_ASSIGNED`
- ADMIN bypasses the assignment check (ops needs to upload on behalf
  of crew, fix wrong filings, etc.)

#### Server enforcement

- `POST /api/upload/init` — runs `canUploadToBooking` after parsing the
  body, returns `403` with the specific `code` so the UI can show a
  friendly message ("you're not assigned to this booking", etc.). The
  v1.35.2 `getUploadAccess` + `BAD_BOOKING_STATUS` checks fold into the
  single new helper — same coverage, less duplication.
- `GET /api/upload/list?bookingId=…` — same gate. Listing the upload
  history of a booking you can't act on leaks who's been on a shoot,
  so visibility ties to upload permission.

#### Discovery surfaces

- **Nav** — "Upload" link in More dropdown now uses `canUpload` flag
  (was `isAdmin`). Crew see the link; users without upload access
  don't.
- **`/my-bookings`** — CONFIRMED + COMPLETED rows get a primary
  "📹 Upload" button that links to `/upload?bookingId=<id>`. Only
  rendered when `me.canUpload === true`. Crew's natural home page now
  surfaces the action they need.
- **`/admin`** — the v1.35.2 Upload button on booking cards is
  unchanged (admin-only path stays as a power-user shortcut).

#### What the crew sees end-to-end (v1.35.3)

1. Videographer / sound op signs in → lands on `/`
2. Goes to **My Bookings** in the nav (or **Upload** for a direct
   booking picker)
3. Sees their assigned bookings; CONFIRMED/COMPLETED ones have
   "📹 Upload"
4. Clicks → `/upload?bookingId=X` → UploadSection prefilled, no way
   to misclick into a different booking
5. Drops files; per-cloud progress bars run; history table refreshes
6. Done

#### Rollback

Pure additive on the server (one new helper); UI changes affect
`/upload`, `/my-bookings`, Nav. Rollback by bumping `IMAGE_TAG` back
to `sha-7e3ed84` (v1.35.2). The `/upload` page reverts to its
admin-only stub; `/admin/[id]#upload` still works for admins exactly
as it did in v1.35.2.

---

## [1.35.2] — 2026-05-28

### Added — Upload UI on `/admin/[id]` (crew-only, status-gated, booking-prefilled)

Frontend for the v1.35.1 backend. Crew now upload footage directly
from the booking detail page — booking + outlet context come from the
URL, so there's no dropdown to misclick and the upload always lands in
the right Drive/Wasabi folder.

#### Visibility rules

The Upload section renders only when **both** conditions hold:

1. **User has upload access** — checked via `/api/me.canUpload`:
   - any `User.role === 'ADMIN'`, OR
   - `TeamMember.role` is `video` or `sound` (active members only)
2. **Booking is CONFIRMED or COMPLETED** — REQUESTED / ASSIGNED /
   CANCELLED bookings don't get the section at all

This means: a Producer / Director / Photographer can still see the
booking detail page, but the Upload section is hidden. The server
enforces the same rule via `getUploadAccess()` in `src/lib/session.ts`
+ a `BAD_BOOKING_STATUS` check in `/api/upload/init`, so a
hand-crafted POST would still fail.

#### `UploadSection` component (`src/app/_components/booking/UploadSection.tsx`)

- **Camera dropdown** — defaults to `Cam1`. Supported: Cam1–4, Sound,
  Drone, BTS.
- **Wasabi checkbox** — auto-checked + locked for DUAL_WRITE outlets
  (AGN, TSS, NWS). DRIVE_ONLY outlets get an optional opt-in toggle.
- **Multi-file file picker** — drops files into a queue; each file
  runs the full `init → parallel cloud PUTs → complete` cycle one at
  a time (parallel chunks within a file via 4-concurrent presigned
  PUTs; sequential between files to not saturate the uplink).
- **Per-file progress bars** — separate Drive + Wasabi tracks so the
  user sees which cloud is the bottleneck. Driven by
  `XHR.upload.onprogress` for both clouds.
- **Cancel button** — calls `POST /api/upload/[id]/cancel` to abort
  multipart + delete the reserved Drive slot.
- **History table** — pulls `GET /api/upload/list?bookingId=...` and
  shows previously-uploaded files for this booking with Drive link +
  status chip + uploader email.

#### Booking cards (`/admin`)

CONFIRMED + COMPLETED rows now show a primary **📹 Upload** button
that links to `/admin/[id]#upload`. The anchor scrolls the page to the
upload section so the crew lands on the right control with one click.

```
[CONFIRMED]   [📹 Upload] [EDIT] [Cancel] [✓ Approved]
[COMPLETED]   [📹 Upload] [View] [✓ Completed]
```

Visible only to users where `/api/me.canUpload === true`.

#### Server changes

- `src/lib/session.ts` — `getUploadAccess(email)`: returns true for
  ADMIN or active TeamMember with role in `{video, sound}`.
- `/api/me` — exposes `canUpload: boolean`.
- `/api/upload/init` — new gates:
  - `getUploadAccess` (403 `NO_UPLOAD_ACCESS`)
  - booking status must be CONFIRMED or COMPLETED (400 `BAD_BOOKING_STATUS`)
- `/api/upload/list?bookingId=...` (new) — returns Upload rows for a
  booking, newest first. Same auth gate.

#### What the user sees end-to-end

1. Crew opens `/admin` → sees a CONFIRMED booking they're working on
2. Clicks **📹 Upload** on the card → lands on `/admin/[id]#upload`
3. Upload section is pre-scrolled into view, booking already shown
4. Picks camera (Cam1 default), drags files in
5. Two progress bars per file (Drive + Wasabi if DUAL_WRITE)
6. Files finish → history table refreshes, Drive link clickable

No way to upload to the wrong booking — the context is in the URL.

#### Out of scope (deferred)

- SHA-256 browser-side integrity check (v1.35.4)
- Resume after browser close / tab crash (v1.35.4 reconciler will
  surface ORPHANED uploads for manual cleanup)
- Drag-and-drop UX polish (file picker works; drag-drop is convenience)
- Removal of legacy `/upload` page (v1.35.5)

---

## [1.35.1] — 2026-05-27

### Added — Wasabi + Drive write libs + `/api/upload/{init,complete,cancel}`

Backend half of the browser-direct dual-cloud upload flow. The browser
now has 3 endpoints to drive an end-to-end upload without server bytes
ever touching the wire. UI lands in v1.35.2.

#### New deps

```
@aws-sdk/client-s3 ^3.1055.0
@aws-sdk/s3-request-presigner ^3.1055.0
```

Both `--legacy-peer-deps` (next-auth pins nodemailer at v6 which conflicts
with the AWS SDK's transitive resolution, same pattern as pdf-lib).

#### `src/lib/outlet-folders.ts` (new)

Single source of truth mapping `Outlet.code` → folder name used by both
Drive and Wasabi. Confirmed mappings (matching the team's actual Drive
layout):

```
AGN → Advertorial          (NOT Outlet.name "Content Agency")
TSS → the Secret Sauce     (lowercase 'the' on purpose)
POP → THE STANDARD POP
NWS → News
WLT → Wealth
SPT → Sport
POD → Podcast
KND → KND
LIF → LIFE
```

`buildStoragePath(outlet, bookingCode, camera, filename)` returns the
segment array used by both clouds:
`[outletFolder, bookingCode, camera, filename]`. Single function — if we
ever change the layout it changes here only.

#### `src/lib/wasabi.ts` (new)

S3 client + presign helpers via `@aws-sdk/client-s3`:

- `isWasabiConfigured()` — env-var sanity check; callers check before use
- `createMultipart(key, mime)` — initiate multipart, returns `uploadId`
- `presignParts(key, uploadId, partCount)` — N presigned PUT URLs,
  1-hour TTL
- `completeMultipart(key, uploadId, parts)` — finalize after browser
  pushes all chunks
- `abortMultipart(key, uploadId)` — release storage on cancel/fail
- `verifyUpload(key, expectedSize)` — server-side HEAD to confirm
  size matches (controlled by `WASABI_VERIFY_ON_COMPLETE=1`)
- `chooseChunkSize(fileSize)` — picks a part size that keeps the part
  count ≤ 10000 (S3 hard limit) while staying ≥ 5MB (S3 min). Rounded
  to whole MB so progress bars look sensible.

#### `src/lib/google-drive.ts` — write helpers added

- `getDriveWriteAuth()` — JWT with full `drive` scope, DWD-impersonated
  through the same Workspace user that powers Calendar (single source
  of truth)
- `ensureFolderPath(rootId, segments)` — walk a path of folder names,
  create any missing segments. Race-tolerant (list-then-create with
  exists check; concurrent calls might both create one folder, accepted
  cost since Drive has no locks)
- `createResumableUploadSession({ parentId, filename, mimeType, size })`
  — reserves a file id via `files.create`, then PATCH to the resumable
  endpoint to get a `Location` session URL. Browser PUTs bytes straight
  to that URL.
- `deleteDriveFile(id)` — cleanup for cancel/fail
- `getDriveFile(id)` — read size + webViewLink for /complete verification

#### Schema

One column added to `Upload`:

```
wasabiMultipartId  String?  // S3 UploadId between init+complete
```

So `/complete` and `/cancel` can find the in-flight multipart without
hacky reuse of other columns. `prisma db push --accept-data-loss` adds
it on the next boot — pure additive, nullable, rollback-safe.

#### Endpoints

- **`POST /api/upload/init`** — validates booking + outlet + filename,
  decides Wasabi-or-Drive-or-both based on `Outlet.storagePolicy` and
  optional operator `includeWasabi`, ensures the Drive folder path
  exists, reserves a Drive file slot + resumable session, creates the
  Wasabi multipart upload + N presigned part URLs, and returns
  everything the browser needs:

  ```json
  {
    "uploadId": "cl…",
    "bookingCode": "AGN-260423-EVT-01",
    "outletFolder": "Advertorial",
    "targets": {
      "drive":  { "fileId": "…", "sessionUrl": "…" },
      "wasabi": {
        "uploadId": "…", "bucket": "video2026hires",
        "key": "VIDEO2026/Advertorial/AGN-…/Cam1/001.mp4",
        "parts": [{ "partNumber": 1, "url": "…" }, …],
        "chunkSize": 5242880
      }
    }
  }
  ```

- **`POST /api/upload/complete`** — browser sends back Drive file
  confirmation + Wasabi part ETags. We call `CompleteMultipartUpload`,
  verify both objects via HEAD, flip `Upload.status` to `COMPLETE`
  (or `DRIVE_OK` / `WASABI_OK` / `FAILED` for partial), and write the
  footage sheet row + flip `FootageLog.sheetRowWritten=true`.

- **`POST /api/upload/[id]/cancel`** — best-effort abort. Calls
  `AbortMultipartUpload` (Wasabi) + `files.delete` (Drive) + clears the
  `FootageLog` row. Idempotent — re-calling on COMPLETE/FAILED is a 200
  with `idempotent: true`.

#### Footage scanner (`src/lib/footage-sync.ts`) — race fix

The v1.34.2 scanner walks Drive and writes sheet rows. With browser
uploads also writing sheet rows via `/api/upload/complete`, they'd
race and produce duplicates. The scanner now skips files where any
`Upload` row has the matching `driveFileId` — the app handles its own
uploads end-to-end, the scanner only handles files that arrived
outside the app (NAS transfer, direct Drive upload).

#### Security note

Wasabi access + secret keys go directly into Portainer stack env. Per
deployment runbook: never paste them in chat, never commit them to
git, never put them in `.env.portainer.example`. The example file only
lists the variable names.

#### Out of scope (next versions)

- Upload UI on `/admin/[id]` — v1.35.2 (browser progress, chunk PUTs,
  parallel uploads, cancel button)
- Reconciler worker (ORPHANED cleanup) — v1.35.4
- SHA-256 integrity verify both clouds — v1.35.4
- Remove legacy `/upload` page — v1.35.5

---

## [1.35.0] — 2026-05-27

### Added — Schema foundation for dual-cloud (Drive + Wasabi) booking uploads

Opens the v1.35 line: replace the old local-disk `/upload` flow with
browser-direct uploads from `/admin/[id]` that fan out to both Google
Drive (working copy) and Wasabi S3 (archive). This release is
schema-only — no upload UI, no Wasabi SDK code yet. v1.35.1+ ship the
library + presign endpoints + UI.

Pure additive. Rollback is safe: nullable columns + enum extensions
only. Bump `IMAGE_TAG` back to `sha-b80e07e` (v1.34.5) and previous
behavior returns. The new columns sit unused — no data corruption.

#### Schema

```prisma
enum StoragePolicy {
  DRIVE_ONLY   // Drive only — operator may opt-in to Wasabi per file
  DUAL_WRITE   // Both clouds required, upload fails unless both succeed
}

model Outlet {
  …existing
  storagePolicy StoragePolicy @default(DRIVE_ONLY)
}

enum UploadStatus {
  PENDING, UPLOADING,
  DRIVE_OK,   // v1.35 — Drive done, Wasabi pending
  WASABI_OK,  // v1.35 — Wasabi done, Drive pending
  COMPLETE, FAILED,
  ORPHANED    // v1.35 — partial >24h, reconciler must inspect
}

model Upload {
  …existing
  sha256        String?
  driveFileId   String?  @unique
  driveUrl      String?
  wasabiBucket  String?
  wasabiKey     String?  // <bookingCode>/<camera>/<filename>
  wasabiEtag    String?
  initiatedAt   DateTime @default(now())
  completedAt   DateTime?
  failureReason String?

  @@index([status])
}
```

#### Migration (`start.sh`)

Two new blocks, both idempotent:

1. **Pre-push** — `ALTER TYPE "UploadStatus" ADD VALUE` for `DRIVE_OK`,
   `WASABI_OK`, `ORPHANED`. Guarded so re-runs are no-ops.
2. **Post-push** — flip `Outlet.storagePolicy = 'DUAL_WRITE'` for the
   three outlets that require both clouds:

   ```
   AGN  Content Agency      DUAL_WRITE
   TSS  THE STANDARD Studio DUAL_WRITE
   NWS  News                DUAL_WRITE
   ```

   Other outlets stay on the schema default `DRIVE_ONLY`. The `UPDATE`
   only flips rows still on the default — once an admin changes a
   policy via the future UI, this seed leaves their choice alone.

#### New env vars (`.env.portainer.example`)

| Var | Notes |
|---|---|
| `WASABI_ENDPOINT` | e.g. `https://s3.ap-southeast-1.wasabisys.com` |
| `WASABI_REGION` | e.g. `ap-southeast-1` |
| `WASABI_BUCKET` | bucket name (must be created in Wasabi console first) |
| `WASABI_ACCESS_KEY` | IAM access key with `s3:PutObject` + `s3:AbortMultipartUpload` + `s3:ListBucket` scoped to the bucket |
| `WASABI_SECRET_KEY` | matching secret |
| `WASABI_VERIFY_ON_COMPLETE` | default `1`; turns on server-side HEAD check after browser upload |

All unset by default — the upload flow that will read these doesn't
exist yet in v1.35.0, so a missing config doesn't break anything.

#### Out of scope (next versions)

- `src/lib/wasabi.ts` (S3 client + presign helpers) — v1.35.1
- `/api/upload/init` + `/complete` endpoints — v1.35.1
- Browser-direct upload UI on `/admin/[id]` — v1.35.2
- Multipart + progress + retry — v1.35.3
- SHA-256 integrity check + reconciler worker — v1.35.4
- Removal of legacy `/upload` page — v1.35.5

---

## [1.34.5] — 2026-05-27

### Changed — `/ot/admin` defaults to "qualifying-OT-only" view

The approver landing now hides any user whose monthly summary has
`totalDays === 0` — i.e. nobody whose recorded time hit the OT
threshold (weekday > 9h, or any weekend / declared holiday). Cuts
visual noise so the manager sees only people they actually need to
act on.

#### UI

- New checkbox **"เฉพาะที่ต้อง approve (เข้าเกณฑ์ OT)"** in the month
  picker row, **default ON**. Toggle off to reveal the full roster
  (useful when an admin is hunting for a user who hasn't hit threshold
  yet, or doing general profile maintenance).
- Roster header reflects the filtered count: `Roster (N คน ที่เข้า
  เกณฑ์ OT · ซ่อน M)` instead of the raw total.
- Empty-state row inside the table when the filter hides everyone:
  *"ไม่มีคนเข้าเกณฑ์ OT ในเดือนนี้ — เอาเครื่องหมายถูก…ออกเพื่อดู
  roster ทั้งหมด"*.

#### What stays unchanged on purpose

- **Inbox banner** at the top still reads the **full** `summary` —
  `อนุมัติทุกคนในเดือนนี้` still acts on every SUBMITTED record in the
  month even if their owner is currently filtered out of the table.
  The button's contract is "approve everything pending", not
  "approve everything visible".
- **Sticky bulk-select footer** acts on whatever's selected. If a
  user was checked while filter was off and the filter then hid them,
  the approve still applies — selections persist across toggle.
- **Totals strip** (4 cards: count / Hol days / WD>9h / THB) is
  unaffected — rows that get hidden by the filter contribute 0 to
  every total anyway (they have no qualifying days), so the numbers
  stay numerically identical.

No schema, API, or env change. Pure client-side filter.

---

## [1.34.4] — 2026-05-27

### Hardened — Defensive footage matching (accidents + out-of-rule inputs)

Closes the v1.34 hardening pass. No behavior change for the well-formed
inputs from v1.34.3 — every change here protects against accident /
typo / scale edge cases that would have silently produced wrong rows
or missed files.

Rollback is safe: no schema change. Bump `IMAGE_TAG` back to
`sha-1d21d9f` (v1.34.3) in Portainer and the previous behavior returns.

#### 1. Regex word-boundary protection (`src/lib/episode-id.ts`)

```diff
- EPISODE_ID_RE_LOOSE = /([A-Z]{2,4}-\d{6}-[A-Z0-9]{1,4}-\d{2})/
+ EPISODE_ID_RE_LOOSE = /(?<![A-Za-z0-9])([A-Z]{2,4}-\d{6}-[A-Z0-9]{1,4}-\d{2})(?!\d)/
```

Stops two classes of false matches:

- `XAGN-260423-EVT-01` no longer extracts `AGN-260423-EVT-01` (a letter
  butting against the ID is now treated as "not a match").
- `AGN-260423-EVT-100` no longer extracts `AGN-260423-EVT-10` (the
  trailing 3rd digit invalidates the match — format is 2-digit seq).

Acceptable boundaries (still match): space, `_`, `-`, `(`, `[`, `/`,
Thai chars, start/end of string. So real folders like
`[Final] AGN-260423-EVT-01 master` or
`งานวันแม่_AGN-260423-EVT-01_เสร็จแล้ว` continue to work.

#### 2. Dash + whitespace normalization (`src/lib/production-id.ts`)

```ts
normalizeForMatch(text)
  = text.replace(/[–—‑]/g, '-').trim()
```

Folders accidentally named with macOS-autocorrected en/em dashes
(`AGN–260423–EVT–01`) or non-breaking hyphens now match. Trim absorbs
trailing whitespace that copy-paste sometimes introduces.

#### 3. Look-alike (lowercase / near-miss) warning (`src/lib/production-id.ts`)

New helper `looksLikeProductionId(text)` detects strings that would
have matched if the case had been uppercase — `agn-260423-evt-01`,
`Agn-260423-Evt-01`. The sync worker collects these per tick and emits

```
[footage-sync] folder "agn-260423-evt-01" looks like a Production ID —
strict format requires "AGN-260423-EVT-01". Check for case/separator typo.
```

once per unique folder to the container log. Strict parsing still
returns null for these (they don't match the booking DB which stores
uppercase), so they land in `unparsed` — but the operator now has a
breadcrumb to fix the folder name.

#### 4. Skip Drive shortcuts + Google-native non-media files (`src/lib/google-drive.ts`)

`listFilesRecursive` now filters out:

```
application/vnd.google-apps.shortcut       — would double-count targets
application/vnd.google-apps.document       — notes, not footage
application/vnd.google-apps.spreadsheet
application/vnd.google-apps.presentation
application/vnd.google-apps.form
application/vnd.google-apps.drawing
application/vnd.google-apps.site
application/vnd.google-apps.script
application/vnd.google-apps.fusiontable
application/vnd.google-apps.jam
```

A user dropping a Google Doc with shot notes into the production
folder no longer creates a `FootageLog` row + sheet append for the
non-media file.

#### 5. Batched booking lookup — N+1 → 1 query (`src/lib/booking-lookup.ts`)

```ts
findBookingsByProductionIds(codes: string[])
  → Map<bookingCode, Booking>
```

Replaces N sequential `findUnique` calls with one `findMany({ where:
{ bookingCode: { in: codes } } })`. Matters when the first sync after
`FOOTAGE_WORKER_ENABLED=1` flips discovers thousands of pre-existing
files — DB stays responsive instead of going head-down for ~5s on
1000 sequential lookups.

#### 6. Sheet append chunking — max 1000 rows per request (`src/lib/footage-sheet.ts`)

```ts
const APPEND_CHUNK_SIZE = 1000
for (let i = 0; i < rows.length; i += APPEND_CHUNK_SIZE) {
  const chunk = rows.slice(i, i + APPEND_CHUNK_SIZE).map(rowToCells)
  await sheets.spreadsheets.values.append(...)
}
```

Prevents the Sheets API request-size limit from breaking the FIRST
sync after enablement (when the worker might find 5000+ matched
files at once). Each chunk is its own request; earlier chunks commit
even if a later one fails (worker retries unwritten via the
`FootageLog.sheetRowWritten=false` flag on the next tick).

#### Known limitations (deferred — flag in CHANGELOG, not fixed)

- **File moved between folders post-match**: if a file is logged with
  Production ID A, then someone moves it into a folder with Production
  ID B, the sheet row stays at A. The `FootageLog` upsert updates the
  ledger's `productionId` to B but `sheetRowWritten=true` blocks the
  re-append. Fix would be a "force-resync" admin endpoint — not built.
- **Multiple Production IDs in one path** (e.g.
  `AGN-…-01/something/TSS-…-02/file`): closest-wins picks `TSS-…-02`,
  but the inner-most match might not be the operator's intent. The
  warning loop in (3) does NOT flag this case because both folders
  parse strictly — only typos/case-misses get logged.

---

## [1.34.3] — 2026-05-27

### Fixed — Footage matcher reads Production ID from FOLDER name, not filename

v1.34.1/v1.34.2 parsed the Production ID from the filename itself —
that's the wrong convention. `src/lib/episode-id.ts` line 6 already
states the rule: **"Folder-only policy (ID on folder name, not
individual files)"**. The team's real Drive layout matches that:

```
DRIVE_FOOTAGE_ROOT/
└── AGN-260423-EVT-01/        ← Production ID here
    ├── Cam1_001.mp4
    ├── Cam1_002.mp4
    └── Sound/
        └── audio.wav
```

Filename-based parsing would miss the `AGN-260423-EVT-01` here because
the actual file is named `Cam1_001.mp4` with no ID embedded.

#### Changes

- **`src/lib/google-drive.ts`** — `listFilesRecursive` now tracks
  ancestor folder names as it walks. Each returned `DriveFile` carries a
  `folderPath: string[]` (root → leaf, root itself excluded). The walk
  queue now propagates `{ folderId, path }` instead of just an ID so
  every file knows the full chain of folders it lives under.
- **`src/lib/production-id.ts`** — new helper
  `findProductionIdInPath(folderPath)` that walks the array
  **leaf → root** and returns the closest match. Handles real-world
  nesting like `2026-04/AGN-260423-EVT-01/Cam1/001.mp4` — the file's
  immediate parent ("Cam1") doesn't match, the next level
  ("AGN-260423-EVT-01") does → that's what we return.
- **`src/lib/footage-sync.ts`** — replaces `parseProductionId(file.name)`
  with `findProductionIdInPath(file.folderPath)`. Files that live
  directly in the scan root (no production folder above them) now
  correctly land in `parseStatus = 'unparsed'`.
- **Camera derivation also goes folder-first** — `Cam1` in a folder
  name (`AGN-…/Cam1/001.mp4`) wins over a `Cam1_` token in a filename.
  Filename token stays as the fallback for the
  `AGN-260423-EVT-01/Cam1_001.mp4` layout (flat camera in the
  filename).

#### Behavior change for `parseStatus`

Files whose folder structure doesn't contain a Production ID — but
whose **filename** happens to include one — are now `unparsed` instead
of `matched`. This is the correct strict reading of the convention; if
the user wants those rescued, they'd move the file into a properly-
named folder. The `FootageLog` row carries the filename + folder path
context so triage is straightforward:

```sql
SELECT filename, "parseStatus" FROM footage_log
 WHERE "parseStatus" = 'unparsed'
 ORDER BY "createdAt" DESC;
```

No schema change. No env-var change. Worker still defaults off
(`FOOTAGE_WORKER_ENABLED=0`) — flip when ready per v1.34.2 rollout.

---

## [1.34.2] — 2026-05-25

### Added — Footage sheet sync worker (supervised, off by default)

Closes the v1.34 footage line: a supervised worker now scans the
configured Shared Drive root every 10 min, parses each new filename for
a Production ID, looks up the matching Booking, and appends a row to
the user's footage-log sheet (`FOOTAGE_LOG_SHEET_ID`) using the
adaptive writer from v1.34.1.

#### New files

| Path | Purpose |
|---|---|
| `src/lib/footage-sync.ts` | `runFootageSync({ dryRun? })` — pure-logic core. Drive walk → classify (`matched` / `parsed_no_booking` / `unparsed`) → upsert `FootageLog` ledger → batch-append matched rows to sheet → patch `sheetRowWritten=true`. Crash-safe: log row is written BEFORE the sheet append so a half-completed run retries on the next tick without double-rows. |
| `src/app/api/internal/footage/sync/route.ts` | GET endpoint poked by the worker. Auth mirrors `/api/internal/calendar/reconcile`: shared secret header (`x-footage-sync-secret`) or admin session. `?dryRun=1` for safe inspection. |
| `scripts/footage-sheet-sync-worker.js` | Polling loop. Reads `FOOTAGE_WORKER_ENABLED` (default off — stays dormant when unset/`0`/`false`). When on, hits the internal endpoint every `FOOTAGE_WORKER_INTERVAL_MS`. SIGTERM/SIGINT handlers. |

#### `start.sh` change

Adds a supervised loop alongside the existing calendar-reconcile
supervisor (around line 245-251). Both workers share the same restart
pattern: 5s back-off, foreground `exec npm start` reaps them when the
container stops.

```sh
echo "==> Starting footage sheet sync worker (supervised)..."
(
  while true; do
    node scripts/footage-sheet-sync-worker.js
    echo "[footage-sync] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &
```

#### Behavior contract

The worker is **off by default** — `FOOTAGE_WORKER_ENABLED` is unset
or `0`. In that state the script logs once and sleeps 30s before
exiting, the supervisor loops, and nothing else happens. The route
itself still works (admins can hit `?dryRun=1` to inspect classification
output without flipping the env var on).

When on, the worker:

1. `listFilesRecursive(DRIVE_FOOTAGE_ROOT)` — walks the Shared Drive
2. Loads existing `FootageLog` rows for those `driveFileId`s in one query
3. Skips files where `sheetRowWritten=true` (true dedupe)
4. Classifies the rest, upserts `FootageLog` with the new state
5. For `matched` files, batches them into one `appendFootageRows` call
6. Patches `sheetRowWritten=true` on success

Files with status `parsed_no_booking` or `unparsed` are recorded but
never written to the sheet — the sheet is the **matched** footage log,
not the raw Drive inventory. Query
`SELECT * FROM footage_log WHERE "parseStatus" != 'matched'` to triage
filename-format misses.

Camera column is best-effort derived from the filename via a
conventional `_<token>_` segment match (Cam1, Sound, Drone, BTS, Atem,
Switcher, Multi, Master, Proxy). Falls back to blank if no recognized
token — no guessing.

#### Rollout

1. Deploy v1.34.2 — schema unchanged from v1.34.1; only new files +
   `start.sh` change. Worker stays dormant.
2. User runs `npx tsx scripts/inspect-footage-sheet.ts` against prod
   env. Confirm canonical-key map covers all of the user's columns.
3. User sets in Portainer stack env:
   - `FOOTAGE_LOG_SHEET_ID=1KMmbPjbRnd6Deb-ct253YMmoINuLgTDnS4Id2lPA5VI`
   - `FOOTAGE_LOG_TAB=<the tab name from inspect step>`
   - `DRIVE_FOOTAGE_ROOT=<Shared Drive folder id>`
   - `FOOTAGE_WORKER_ENABLED=1`
4. Pull and redeploy. Container logs should show
   `[footage-sync] worker started; interval=600000ms; baseUrl=http://127.0.0.1:3000; secret=set`.
5. Drop a test file `AGN-260423-EVT-01_Cam1_test.mp4` into the Shared
   Drive folder. Within ~10 min the worker logs
   `[footage-sync] scanned=N matched=1 …` and a row appears in the sheet.

#### Out of scope (deferred)

- Modified-time incremental scanning — `listFilesRecursive` accepts a
  `modifiedAfter` option (v1.34.1) but the worker currently does a full
  walk every tick. Fine for thousands of files; revisit if we hit
  Drive rate limits.
- /upload page Drive push — the worker covers files that arrive via
  NAS-to-Drive transfer or direct Drive upload. The current `/upload`
  flow (local disk + Upload model) stays untouched.
- UI surface showing FootageLog rows — managers query the sheet
  directly. A future admin page could expose `parse_status != matched`
  for filename-format triage.

---

## [1.34.1] — 2026-05-25

### Added — Footage matcher library scaffold (no behavior change yet)

Lays the groundwork for the Drive footage → sheet auto-matcher that
ships fully in v1.34.2. This release adds the library code, the
`FootageLog` ledger table, and a diagnostic script — nothing scans or
writes to the user's sheet until `FOOTAGE_WORKER_ENABLED=1` flips in
Portainer env (default `0` so this release is a pure no-op).

#### New files

| Path | Purpose |
|---|---|
| `src/lib/production-id.ts` | `parseProductionId(filename)` — pulls a Production ID out of a filename. Tolerates path prefixes, camera suffixes, extensions. Returns `null` on no match. |
| `src/lib/booking-lookup.ts` | `findBookingByProductionId(code)` — single Prisma `findUnique` against the existing `bookingCode @unique` index. Returns booking + outlet + program + producer + assigned crew (sheet writer enrichment). |
| `src/lib/google-drive.ts` | `getDriveReadAuth()` + `listFilesRecursive(rootFolderId, opts?)`. DWD-impersonated (reuses `getCalendarImpersonateSubject()` — single source of truth for the impersonated user). Scope: `drive.readonly`. `supportsAllDrives + includeItemsFromAllDrives` so Shared Drives work. Soft cap at 5,000 files per run to protect worker memory. |
| `src/lib/footage-sheet.ts` | `probeSheet()` + `appendFootageRows(rows)`. Adaptive writer — reads row 1, normalizes each header (lowercase, strip non-alnum), maps to canonical keys via an alias table (`'productionid'`, `'bookingid'`, `'bookingcode'`, etc. all collapse to the same logical column). Sparse-row strategy means user-owned extra columns stay untouched and missing canonical columns silently skip. Module-level cache with 5-min TTL keeps API pressure low. |
| `scripts/inspect-footage-sheet.ts` | Run-once diagnostic. Prints sheet id (masked), tab name, raw headers, canonical-key map, unrecognized headers. Run via `npx tsx scripts/inspect-footage-sheet.ts` **before** flipping the worker on. |

#### Schema

```prisma
model FootageLog {
  id              String   @id @default(cuid())
  driveFileId     String   @unique
  productionId    String?
  bookingId       String?
  filename        String
  driveUrl        String?
  parseStatus     String   @db.VarChar(32) // 'matched' | 'parsed_no_booking' | 'unparsed'
  sheetRowWritten Boolean  @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([productionId])
  @@index([parseStatus])
  @@map("footage_log")
}
```

Applied via `prisma db push --accept-data-loss` per project convention.
Pure additive — no existing data touched.

The worker (v1.34.2) uses this as a dedupe ledger: before appending a
row to the footage sheet, it checks `findUnique({where: {driveFileId}})`.
Files that didn't parse or didn't match are still recorded (with
`parseStatus = 'unparsed'` / `'parsed_no_booking'`) so we can triage
filename-format misses without re-walking Drive.

#### Reused utilities

- `EPISODE_ID_RE` + `EPISODE_ID_RE_LOOSE` exported from `src/lib/episode-id.ts` — the anchored regex powers `parseEpisodeId`; the loose regex powers the new `parseProductionId`. Single source of truth, no drift.
- `getSheetsWriteAuth()` from `src/lib/google-sheets.ts` — same SA auth model used by the existing Producer Dashboard write path.
- `getCalendarImpersonateSubject()` from `src/lib/google-calendar.ts` — Drive read auth impersonates the same Workspace user that already powers Calendar attendee invites.
- `maskSheetId()` from `src/lib/google-config.ts` — used by the inspect script's output.

#### New env vars (`.env.portainer.example`)

| Var | Default | Notes |
|---|---|---|
| `FOOTAGE_LOG_SHEET_ID` | (unset) | The user's footage-log sheet id. Worker is a no-op when unset. |
| `FOOTAGE_LOG_TAB` | `Sheet1` | Tab name inside the sheet. |
| `DRIVE_FOOTAGE_ROOT` | (unset) | Shared Drive folder id the worker scans. |
| `FOOTAGE_WORKER_ENABLED` | `0` | Master switch. Stays `0` for v1.34.1 ship. |
| `FOOTAGE_WORKER_INTERVAL_MS` | `600000` | 10 min, matches the calendar reconcile worker. |

#### Rollout sequence (next step is v1.34.2)

1. **Now (v1.34.1):** Schema migrates, library code deploys, worker stays dormant.
2. **User runs** `npx tsx scripts/inspect-footage-sheet.ts` against the prod env to confirm column mapping.
3. **User sets** `DRIVE_FOOTAGE_ROOT` + `FOOTAGE_LOG_TAB` in the Portainer stack env.
4. **v1.34.2** ships the worker + `start.sh` supervisor entry. Flip `FOOTAGE_WORKER_ENABLED=1` and redeploy.

---

## [1.34.0] — 2026-05-25

### Changed — Renamed "Booking ID" → "Production ID" in all user-facing surfaces

Aligns the app's terminology with the team's spoken convention: the
human-readable code (`AGN-260423-EVT-01` etc.) is the **Production
ID**. The internal Prisma column `Booking.bookingCode` is intentionally
**not** renamed — 71 references, no functional gain, high migration
risk. This release is label-only and ships in one shot because nothing
runtime-coupled changes.

#### Label updates

| Surface | Before | After |
|---|---|---|
| Producer Dashboard sheet, row 1 col A | `Booking ID` | `Production ID` |
| `/admin/[id]` booking detail header chip | `Booking ID` | `Production ID` |
| `/dashboard` team workload CSV | `Booking IDs` | `Production IDs` |
| `/dashboard` bookings CSV | `Booking ID` | `Production ID` |
| `/api/bookings/export` CSV | `Production / Booking ID` | `Production ID` |
| Google Calendar event description | `Booking ID: ${booking.id}` | `Production ID: ${booking.bookingCode \|\| booking.id}` |

The Calendar description change is a **2-part fix**:

1. Label rename (consistent with the rest of v1.34.0).
2. Value flip from the internal CUID (`clxxxxxxxxx…`) to the
   human-readable code. The previous body printed
   `"Booking ID: clxxxxxxx…"` which was confusing — the label
   suggested the readable code but the value was the database row id.
   Pre-`bookingCode` bookings fall back to the CUID to keep history
   safe.

#### How the live Producer Dashboard sheet updates without a manual migration

`ensureSheetTab` in `src/lib/google-sheets.ts` rewrites the entire row
1 of the Bookings tab on **every** container boot (see line 121-139).
So the moment v1.34.0 boots, the live sheet's first cell flips from
"Booking ID" to "Production ID" — no batch UPDATE call needed, no
data orphaning (column position unchanged, only the cell text). Any
downstream Airtable sync that keys off the column header will see the
new name on the next sync after deploy.

#### Out of scope (explicitly)

- `Booking.bookingCode` Prisma field rename — kept as-is per user
  decision. 71 references including audit, calendar reconcile, csv,
  google-sheets writers and admin/producer routes.
- `bookingId` API/form param names — internal contract, no user
  visibility.
- Email subjects, notification copy — grep confirms none currently
  emit "Booking ID" string.

---

## [1.33.6] — 2026-05-25

### Changed — Backfill legacy bookings: crewRequired MUA → Virtual Production

Follow-on to v1.33.5, which only swapped the wizard option list. This
release adds a one-shot data backfill in `start.sh` that rewrites
`bookings.crewRequired` arrays containing `"MUA"` to `"Virtual
Production"`, so existing booking detail views display the new label
instead of mixing both terms.

```sql
UPDATE bookings
   SET "crewRequired" = array_replace("crewRequired", 'MUA', 'Virtual Production')
 WHERE 'MUA' = ANY("crewRequired");
```

Idempotent: `array_replace` is a no-op when MUA isn't present, and the
WHERE clause limits scanning to rows that still contain MUA. Re-runs on
every container start are safe and free after the first pass.

No schema change — `crewRequired` was already a free-form `String[]`.

---

## [1.33.5] — 2026-05-25

### Changed — Booking wizard "Crew Required": MUA → Virtual Production

`CREW_OPTIONS` in `src/lib/data.ts` replaces `'MUA'` with
`'Virtual Production'` so the New Booking wizard's "Crew Required"
checkbox group reflects the actual crew categories used by THE
STANDARD's production team.

```
Before: ['Videographer', 'Sound', 'DIT', 'Lighting', 'MUA', 'Art Director']
After:  ['Videographer', 'Sound', 'DIT', 'Lighting', 'Virtual Production', 'Art Director']
```

`Booking.crewRequired` is a free-form `String[]` — no schema change.
Existing bookings whose `crewRequired` array still contains
`"MUA"` are unaffected by this change (the string is preserved as-is
on the booking detail view). The booking wizard simply no longer
offers MUA as a tickable option for new bookings.

No backfill applied — historical bookings with MUA stay as MUA so
audit + reporting against past data remains accurate.

---

## [1.33.4] — 2026-05-25

### Added — OT Approver role (Manager scope, no schema change)

Introduces a position-based **OT Approver** gate so a designated Manager
can approve/reject OT and see the cover-sheet overview without being
granted the full ADMIN role (which also grants `/admin` booking console,
user roster CRUD, GHA + sheet config, dashboard, upload — all of which
the Manager doesn't need).

#### `getOTApproverAccess(email)` + `requireOTApprover()` — new in `src/lib/session.ts`

Returns true when the user is:

1. `role === 'ADMIN'`, **or**
2. their `User.position` field (case-insensitive) contains `"manager"`

Mirrors the existing `getProducerAccess` pattern so the gate is set by
filling in the person's profile, not by toggling a separate flag. The
gate also rejects `active === false` users.

Today this picks up:

- `narasit.k@thestandard.co` — `role=ADMIN` (set by `INITIAL_ADMINS` in
  `src/lib/auth.ts` + seed). Full access, unchanged.
- `chonlathorn.j@thestandard.co` — `position='Video Production Manager'`
  (already in `TEAM_PROFILES` and re-asserted on every seed run). Gains
  OT approver access; no other role changes.

Anyone else whose position is later set to include "manager" (e.g. "OT
Manager", "Production Manager") automatically picks up the same gate
without a code change.

#### Routes flipped from `requireAdmin()` → `requireOTApprover()`

- `GET  /api/ot/summary`         — admin cover sheet data
- `POST /api/ot/admin/approve`   — bulk approve (all 3 modes)
- `POST /api/ot/admin/reject`    — reject with note
- `GET  /api/ot/export`          — CSV export
- `GET  /api/ot/export/pdf`      — PDF cover sheet (bulk mode)
  - single-person mode (`&email=...`) now also accepts the owner OR any
    OT approver

`GET /api/ot` was updated so `?email=` and `?all=1` queries also work
for managers, not just admins — required for the manager's review page
to load other users' records.

#### UI surfaces

- `Nav` → adds "OT · Approve" link in the More dropdown for anyone who
  passes `canApproveOT`. ADMIN-only `/admin` link is unchanged.
- `/ot` (user page) → the right-hand admin shortcut is now visible to
  any approver, labelled "→ Approve / Cover Sheet" for managers and
  "→ Admin / Cover Sheet" for admins.
- `/ot/admin` (cover sheet) → still loads identically, but for non-
  ADMIN approvers the **Add user**, **Edit user**, **Toggle role**,
  and **Toggle active** controls are hidden. A small "Manager view —
  read-only roster" tag in the Roster header explains why. Approve /
  reject / review / PDF / CSV all work as before.
- `/ot/admin/review/[email]?month=…` → no UI change; the page was
  already gated by the underlying API, which now accepts approvers.
- `/api/me` now ships `canApproveOT: boolean` so client pages can
  conditionally render approver-only UI without a second round-trip.

#### What's intentionally *not* extended to the Manager role

- `/admin` (booking admin console) — still ADMIN-only.
- `/dashboard` — still ADMIN-only.
- `/api/admin/users` (user roster CRUD) — still ADMIN-only on the
  server. Frontend now hides the buttons that hit it, so a Manager
  doesn't get a 403 in the face.
- `/upload` — still ADMIN-only.

#### Deploy + rollout notes

- Pure additive change. No schema migration. `start.sh` already seeds
  `chonlathorn.j`'s `position='Video Production Manager'` from
  `TEAM_PROFILES` on every restart via `prisma/seed.ts upsert`, so the
  gate flips on at first deploy of v1.33.4 without manual DB work.
- Rollback to v1.33.3 simply re-narrows the gate to ADMIN-only — no
  data fix needed.

---

## [1.33.3] — 2026-05-25

### Added — OT signature workflow (Phase 4: PDF export with embedded signatures)

Closes the v1.33 line. The OT cover sheet now renders as a real signed
artifact suitable for HR/finance hand-off — one A4 page per person,
table of OT entries, totals, and both signatures (requester + manager)
embedded as actual PNG images at the bottom of the page.

#### `GET /api/ot/export/pdf?month=YYYY-MM[&email=...]` (new)

- `month=YYYY-MM` (admin-only) → multi-page PDF, one page per user
  who has records in the month.
- `month=YYYY-MM&email=...` → single-person, single-page PDF;
  accessible to the owner of `email` or any admin.

Each page contains:

- Header row with company label + month
- Person info block (ชื่อ-นามสกุล / รหัสพนักงาน / ตำแหน่ง / email)
- Table: date / day-type / time-range / job task / status / THB,
  with a small "เหตุผล: …" line under each row when present.
- Totals strip (วันหยุด/Hol days · วันธรรมดา days · รวม THB).
- Two signature boxes at the bottom:
  - **ผู้ขอ (Requester)** — embeds the most recent
    `requesterSignaturePng` snapshot from the user's records, with
    their printed name and submission date.
  - **ผู้อนุมัติ (Manager)** — embeds the most recent
    `approverSignaturePng` snapshot, with the approver's email and
    approve date. Falls back to "(รออนุมัติ)" when not yet signed.

Signatures are taken from the per-row snapshots stamped in Phases 2–3
so the PDF is internally consistent with the database state — a user
or manager updating their saved signature later does not change PDFs
that were exported under the old signature.

#### Thai rendering — embedded Sarabun font (OFL)

`pdf-lib`'s built-in fonts have no Thai glyphs, so the API embeds
Sarabun Regular + Bold (SIL Open Font License, by Cadson Demak) with
glyph subsetting enabled. Per-PDF font payload is ~5–10KB; total
typical export size is 15–25KB for a single-person sheet.

- `public/fonts/Sarabun-Regular.ttf` (~88KB)
- `public/fonts/Sarabun-Bold.ttf` (~88KB)
- `public/fonts/SARABUN-OFL.txt` — license attribution

New runtime deps: `pdf-lib ^1.17.1`, `@pdf-lib/fontkit ^1.1.1`.

#### UI surfaces

- `/ot/admin` — primary "Cover Sheet PDF (พร้อมลายเซ็น)" button next
  to the existing CSV exports.
- `/ot/admin/review/[email]?month=…` — header "PDF" button generates
  the single-person sheet for the currently-viewed person + month.
- `/ot` — when the user has any records for the visible month, a
  small "PDF" button in their profile strip downloads their own
  signed cover sheet without involving an admin.

#### Verification

`scripts/test-ot-pdf.ts` is a one-shot smoke test that generates a
PDF for a synthetic person (mix of APPROVED/SUBMITTED/REJECTED rows,
both signature snapshots present) — useful for manual inspection
when iterating on the PDF layout. Run via
`npx tsx scripts/test-ot-pdf.ts`.

This commit closes the v1.33 signature workflow line. The full
feature branch `feat/ot-signature` is now ready to merge to `main`.

---

## [1.33.2] — 2026-05-25

### Added — OT signature workflow (Phase 3: manager bulk approve + review page)

Gives the manager the tools to actually work through the SUBMITTED queue
v1.33.1 fills up: bulk-approve multiple people at once, drill into a
single person's report for per-row decisions, and push individual rows
back to the user with a reason.

#### `/api/ot/admin/approve` — extended to three modes

The existing `{email, month}` shape is preserved; two new shapes are
added so the same endpoint serves all approve flows:

- `{ recordIds: string[] }` — approve a hand-picked set of rows. Used
  by the bulk-select footer on `/ot/admin` and per-row approve on the
  review page.
- `{ month, allSubmitted: true }` — month-wide "approve every
  SUBMITTED row across all users". Powers the one-click Inbox banner
  on `/ot/admin`.
- `{ email, month }` — legacy mode for one user × one month.

Modes are mutually exclusive — `recordIds` takes precedence, then
`allSubmitted`, then the legacy `{email, month}`. All three only flip
rows currently in SUBMITTED (idempotent re-clicks; DRAFT/REJECTED rows
never silently jump past the user). The approver's saved signature is
snapshotted onto every approved row in every mode.

#### `/api/ot/admin/reject` (new)

`POST { recordId, note }` — flips one SUBMITTED row to REJECTED with
the manager's note attached. Non-SUBMITTED rows are no-ops (returns
`rejected: 0`), so managers don't accidentally re-reject rows the user
has already updated. `note` is required, non-empty, ≤500 chars —
silent rejects don't give the user enough to act on.

#### `/ot/admin` — Inbox + bulk select + sticky footer

- **Inbox banner** at the top: `N รายการรออนุมัติจาก M คน` with a
  primary one-click "อนุมัติทุกคนในเดือนนี้" button. When the queue is
  empty, shows a green "ไม่มีคำขอ OT รออนุมัติ" confirmation instead.
- **Per-row checkbox** (only enabled when the row has SUBMITTED
  records); header checkbox toggles all selectable rows.
- **Per-row "Review N" link** replaces the old direct "Approve N"
  action — manager goes through the review page rather than blind-
  approving. The old direct approve is still reachable from the
  review page's "อนุมัติทั้งหมด + เซ็น" footer button.
- **Rejected count badge** on rows where the manager has pushed
  records back; clarifies why the SUBMITTED count is lower than the
  total in-flight count.
- **Sticky bottom bar** appears whenever any checkbox is selected,
  with "อนุมัติที่เลือก (N)" — fires `{email, month}` approves in
  parallel across selected users (idempotent endpoint, partial
  failures leave clean state).
- Clicking a person's name links to the review page.

#### `/ot/admin/review/[email]?month=YYYY-MM` (new)

Per-person, per-month review surface for managers who want to act at
row granularity rather than bulk-approve the whole report.

- Per-row Approve / Reject buttons (only on SUBMITTED rows).
- Reject opens a modal asking for a note (≤500 chars); user sees this
  back on `/ot` and resubmits via Phase 2's flow.
- Approved rows show a lock icon + the approver email + timestamp.
- The user's submitted signature is rendered at the top so the
  manager can sanity-check it against past sign-offs.
- Sticky footer mirrors the admin page pattern: "อนุมัติทั้งหมด +
  เซ็น" for one-click approve of every still-SUBMITTED row for this
  person.

#### Backward-compat note

`/api/ot/summary` continues to ship the `pendingRecords` field; the
v1.33.0 admin UI consumers can still read it. The new admin page reads
`submittedRecords` and `rejectedRecords` directly to surface the
correct counts in the new badges.

---

## [1.33.1] — 2026-05-25

### Added — OT signature workflow (Phase 2: user submit flow)

Closes the v1.33.0 "Known gap": new OT records now have a path out of
`DRAFT` and into the manager's approval queue, plus a recovery path for
records the manager pushes back.

#### `/api/ot/submit` (new)

`POST { month: "YYYY-MM" }` — flips every `DRAFT` or `REJECTED` record
owned by the signed-in user in the given month to `SUBMITTED`, stamping
`submittedAt = now()` and snapshotting `User.signaturePng` onto each
record's `requesterSignaturePng`. Previous `rejectionNote`s are cleared
so the manager sees a clean queue on the resubmit. `APPROVED` and
already-`SUBMITTED` rows are untouched (idempotent re-clicks).

The endpoint blocks submission if the user has no saved signature
(returns `400` with `code: 'NO_SIGNATURE'`) — the signature is the
legal sign-off, so submitting without one is rejected at the API level.

#### `/api/ot/[id]` PATCH/DELETE — status-aware gates

- `APPROVED` rows are locked for the owner. Admins can still edit/delete
  (correction path — preserves existing override behavior).
- Owner edits on a `SUBMITTED` row silently revert the row to `DRAFT`
  and clear `submittedAt + requesterSignaturePng`, forcing a re-sign +
  re-submit. The manager is never asked to approve content they haven't
  seen.
- `DRAFT` and `REJECTED` rows are fully editable / deletable by the
  owner.

#### `/ot` page — status visibility + submit modal

- **Status strip** at the top of the records list shows per-month counts
  (`Draft N · Submitted N · Approved N · Rejected N`) plus a primary
  action button that becomes "ส่งให้ approve (N)" when there are draft
  records, or "แก้แล้วส่งใหม่ (N)" when the user has rejected records to
  re-submit. Disabled when there's nothing to send.
- **Rejection banner** (only when rejected records exist) lists each
  rejected row with the manager's note so the user doesn't have to scan
  the day list to find what needs fixing.
- **Per-row badge** on every record card showing its current status,
  plus the submit/approve date when applicable.
- **Submit confirm modal** previews the signature that will be
  snapshotted onto each row. If the user has no signature, the modal
  surfaces a deep link to `/profile/signature` instead of letting the
  user submit without one.
- **APPROVED rows hide the delete button** for the owner and show a
  small lock icon, with a tooltip "ติดต่อ admin หากต้องการแก้".

#### Behavioural change worth flagging

`POST /api/ot` (create record) now creates records in `DRAFT` (via the
schema default change from Phase 1). The v1.32 behavior of "every new
entry immediately enters the manager queue" is gone — users explicitly
opt in by clicking the submit button on `/ot`. This is the intended
two-step "fill, then sign and send" workflow.

---

## [1.33.0] — 2026-05-25

### Added — OT signature workflow (Phase 1: schema + signature profile)

Opens the v1.33 line that replaces the two-state OT approval flow
(`PENDING → APPROVED`) with a four-state workflow that captures both the
requester's and the manager's e-signature on every record. Phase 1 lays
the schema and lets every user set their saved signature; Phases 2–4
follow with the user submit flow, the manager bulk-approve UI, and the
PDF export.

#### Schema (`prisma/schema.prisma`) — additive, with one enum migration

```
model User {
  …existing fields…
  signaturePng        String?   @db.Text   // base64 PNG data URL
  signatureUpdatedAt  DateTime?
}

enum OTApprovalStatus {
  DRAFT      // user is still filling out — not visible to managers
  SUBMITTED  // user signed; awaiting manager sign-off (was: PENDING)
  APPROVED   // manager signed off
  REJECTED   // manager pushed back with rejectionNote; user can resubmit
}

model OTRecord {
  …existing fields…
  approvalStatus         OTApprovalStatus @default(DRAFT)  // was: PENDING
  submittedAt            DateTime?
  requesterSignaturePng  String? @db.Text
  approverSignaturePng   String? @db.Text
  rejectionNote          String?
}
```

**Migration (`start.sh`, runs before `prisma db push`):**

1. `ALTER TYPE "OTApprovalStatus" ADD VALUE` for `DRAFT`, `SUBMITTED`,
   `REJECTED` — idempotent via `IF NOT EXISTS` guards.
2. `UPDATE ot_records SET "approvalStatus" = 'SUBMITTED' WHERE
   "approvalStatus" = 'PENDING'` so the old label has no rows referencing
   it.
3. `prisma db push --accept-data-loss` then reconciles the enum (drops
   the unused `PENDING` label) and adds the new columns as additive
   nullable fields.

No existing approved/pending data is lost: previously-PENDING records
land in the new `SUBMITTED` state (awaiting manager sign-off), and
previously-APPROVED records stay APPROVED. New columns
(`submittedAt`, `requesterSignaturePng`, `approverSignaturePng`,
`rejectionNote`) start NULL and only fill in as users submit/reject
through the new flow.

#### Signature snapshots — historical immutability

`OTRecord.requesterSignaturePng` and `approverSignaturePng` are
**snapshots** taken from `User.signaturePng` at submit/approve time. A
user updating their signature later does not retroactively change any
historical OT report.

#### `/api/me/signature` (new)

- `GET` → `{ signaturePng, signatureUpdatedAt }` — the signed-in user's
  saved signature data URL (or `null`).
- `POST { png }` — saves or replaces the signature. Validates the value
  is `data:image/png;base64,…` with a base64 payload, caps storage at
  200KB raw base64 (~150KB binary). `POST { png: null }` clears it.

#### `/api/me` — extended

Adds `hasSignature: boolean` and `signatureUpdatedAt: string | null` to
the existing response so client code can detect "user hasn't set a
signature yet" without pulling the full image.

#### `/api/ot/summary` — extended status counts

The summary endpoint that powers `/ot/admin` now returns
`draftRecords`, `submittedRecords`, `approvedRecords`, `rejectedRecords`
per person. `pendingRecords` is preserved as a backward-compat alias
that sums `submitted + rejected` ("anything in flight, not yet
approved"), so the v1.32 admin UI keeps working unchanged in Phase 1.

#### `/api/ot/admin/approve` — now snapshots approver signature

The existing `{email, month}` bulk-approve endpoint now reads the
approver's `User.signaturePng` and writes it into every record's
`approverSignaturePng` at approval time. Approvers with no saved
signature can still approve — `approverSignaturePng` will be NULL and
the future PDF export will fall back to a typed name.

The endpoint also now filters on `approvalStatus: 'SUBMITTED'` rather
than the old `'PENDING'`. Phases 2–3 will extend it with two new modes
(`{recordIds: []}` and `{month, allSubmitted: true}`).

#### `/profile/signature` (new page)

Reachable from the `More → ลายเซ็น` nav entry. Mobile-friendly
canvas-based signature pad (mouse + touch) with smoothed strokes, plus a
PNG upload alternative. Save persists to the user's account; "ลบออกจาก
บัญชี" clears it. The `SignaturePad` component
(`src/app/_components/SignaturePad.tsx`) is reusable — Phase 2 will use
it inside the submit modal.

#### Known gap until Phase 2 lands

With the default now `DRAFT`, newly-created OT records do not appear in
the manager's approval queue until the user clicks "ส่งให้ approve"
(Phase 2). The feature branch `feat/ot-signature` bundles all four
phases before merging to `main`, so production is unaffected until the
full flow ships together.

---

## [1.32.2] — 2026-05-24

### Added — `calendarSyncStatus` field + guest-list verification on booking detail + impersonate fallback warning

Bundles the remaining 3 Codex-review fixes (issues #3, #2, #4) into a
single release because the UI changes share the same components.

#### Issue #3 — async calendar sync visibility (schema change, additive)

Approve sets `status='CONFIRMED'` instantly, then fires calendar create
in a background IIFE. Pre-v1.32: if calendar failed, booking showed
CONFIRMED but `calendarEventId` was null and error was only in container
logs. No DB field tracked the failure.

**Schema (`prisma/schema.prisma`) — all nullable adds, no data loss:**

```
enum CalendarSyncStatus { PENDING, OK, FAILED }

model Booking {
  …existing fields…
  calendarSyncStatus    CalendarSyncStatus?
  calendarSyncError     String?
  calendarLastSyncedAt  DateTime?
}
```

Applied via existing `prisma db push --accept-data-loss` in `start.sh`.
New table column writes never touch existing data.

**State writers:**

- `src/app/api/admin/[id]/approve/route.ts` — sets `PENDING` synchronously
  before kicking off the background create; the IIFE writes `OK` on
  success or `FAILED` (with `calendarSyncError`) on caught error. Adds
  a `calendar.approve_failed` audit row on failure.
- `src/lib/calendar-reconcile.ts` `processBooking()` — every successful
  patch / create writes `OK + lastSyncedAt + clears error`; the catch
  writes `FAILED + error`. The "already in sync" path also refreshes
  the OK timestamp.
- `src/lib/calendar-reconcile.ts` reconciler WHERE clause — extended
  to also pick up rows orphaned by a mid-task container restart:
  `(status=CONFIRMED AND assigned non-empty) OR (status=PENDING AND
  lastSyncedAt < now - 5 min)`.
- `src/app/api/admin/[id]/assign/route.ts` — both the patch-existing
  path and the auto-recover create path write `OK`/`FAILED` based on
  outcome.
- `start.sh` — one-time backfill for legacy CONFIRMED bookings:
  `OK` if `calendarEventId IS NOT NULL`, `FAILED` otherwise. Guarded
  by `WHERE calendarSyncStatus IS NULL` so it's idempotent.

**UI:**

- `src/app/admin/page.tsx` `<CalendarStatus>` — primary chip now driven
  by the new status field, not just the existence of `calendarEventId`.
  Three explicit states (PENDING gray spinner / OK no-chip + green link
  / FAILED red + tooltip error). Last-checked timestamp shown as a
  small relative-time hint. Legacy bookings (NULL status) fall through
  to the old "infer from eventId" path.
- `src/app/admin/[id]/page.tsx` — Confirmed card replaced with a new
  `<BookingConfirmedCard>` (see Issue #2 below) that shows the sync
  status badge + last-synced timestamp + error inline + Open in
  Calendar link.

#### Issue #2 — guest-list verification on booking detail

`/admin/[id]` Confirmed card previously showed only "Calendar event
created · ID: …" — never verified the assigned crew were actually on
the event. Easy to silently miss missing guests.

**Endpoint — `GET /api/admin/[id]/calendar-resync?dryRun=1`:**

- Reuses existing `reconcileSingleBooking()` with `dryRun: true`.
  Returns the same `ReconcileItem` shape (assignedEmails,
  calendarAttendees, htmlLink, action) without modifying anything.
- POST behavior unchanged (still writes). GET without `?dryRun` also
  still writes for backwards compat.

**UI — new `<BookingConfirmedCard>` in `/admin/[id]/page.tsx`:**

- On mount (when booking is CONFIRMED), fetches dry-run verification.
- Renders: assigned crew list vs calendar guests list with counts.
- If `missing.length > 0`: red box "⚠ Missing N guests on calendar:
  alice@, bob@" so the admin sees the problem immediately.
- If `extra.length > 0`: amber box flags guests on the event that
  aren't in the assigned list.
- If all in sync: green "✓ All N crew are on the calendar".
- "Re-sync calendar guests" button always available; on success it
  re-runs the dry-run so the diff updates without a page reload.

#### Issue #4 — visible warning when impersonate falls back to hardcoded default

The v1.29.4 hardcoded `narasit.k@thestandard.co` fallback (added after
Portainer dropped the env var) creates an invisible single-person
dependency. v1.32.4 makes it visible:

- `src/app/admin/health/page.tsx` — under the Google Calendar section,
  when `impersonateSource === 'hardcoded-fallback'`, render an amber
  warning explaining: "If `narasit.k@thestandard.co` leaves the company
  or loses Workspace access, calendar invites will break. To swap: set
  `GOOGLE_IMPERSONATE_SUBJECT` in Portainer stack env and redeploy.
  See `docs/runbook-impersonate-swap.md`."
- `src/lib/google-calendar.ts` `getCalendarImpersonateSubject()` — the
  existing once-per-process `console.warn` now also writes a one-time
  `AuditLog` row (action `calendar.impersonate_fallback_in_use`) so
  the audit-email alert path (v1.26.5) picks up the fallback usage
  durably, not just in transient logs.
- New `docs/runbook-impersonate-swap.md` — step-by-step swap procedure
  (when, how, what survives, troubleshooting, rollback, long-term
  multi-fallback list option).

### Verification

- `tsc --noEmit` clean.
- `next build` passes — all routes + page sizes within expected range.
- `prisma db push --accept-data-loss` in dev creates the new column +
  enum without touching existing data.
- After deploy:
  1. `/admin` Confirmed cards show PENDING immediately after approve,
     flip to OK in 1-3 seconds, or FAILED with red chip + error
     tooltip if calendar fails.
  2. `/admin/[id]` for CONFIRMED bookings shows the new
     `<BookingConfirmedCard>` with calendar sync status badge + live
     guest verification + Re-sync button.
  3. `/admin/health` shows amber warning under Google Calendar
     section if `GOOGLE_IMPERSONATE_SUBJECT` env unset.
  4. `start.sh` log shows one-time backfill of legacy CONFIRMED rows.

### Risk

- Medium — adds DB writes on every approve/reconcile/assign success
  and failure. All conditional updates on existing rows, no new
  indexes. Stale-PENDING reconciler clause prevents rows getting stuck.
- The `BookingConfirmedCard` adds 1 Google Calendar API call per
  `/admin/[id]` page load. Admin-only, ~200-500ms. Acceptable.
- Auto-recover paths in assign route now also write status — slight
  performance cost on assign (~5-10ms extra DB write). Negligible.

---

## [1.32.1] — 2026-05-24

### Fixed — `/api/health` now exercises the same auth models production uses

Codex production review (booking `AGN-260527-STD-01`) found that
`/admin/health` was reporting `unauthorized_client` failures on both
the Google Calendar and Producer Dashboard sheet checks **even though
real booking flows were working**. Root cause: the health endpoint
hand-rolled its own JWT auth with scopes/impersonate that didn't match
what `src/lib/google-calendar.ts` and `src/lib/google-sheets.ts`
actually use.

**Mismatch (before):**

| Path | Real prod code | Health was testing |
|------|----------------|--------------------|
| Calendar | `calendar` (full) + DWD impersonate | `calendar.readonly` + impersonate |
| Sheets WRITE | `spreadsheets` (full) + NO impersonate | `spreadsheets.readonly` + impersonate |
| Sheets READ | `spreadsheets.readonly` + NO impersonate | (not tested) |

The DWD grant in Workspace is scoped to **calendar only** — impersonating
on a sheets call returns `unauthorized_client`. The health endpoint was
asking Google "can you impersonate this user for sheets?" — and Google
correctly said no. But that's not what production code does; sheets
goes service-account-direct, which IS authorized.

**Fix:**

- `src/lib/google-calendar.ts` — exported new helper `getCalendarAuth()`.
  Existing internal `getAuth` renamed to a private alias of it. Callsites
  unchanged.
- `src/lib/google-sheets.ts` — exported new helpers `getSheetsWriteAuth()`
  (full scope, no impersonate — used by `appendBookingRow` /
  `updateBookingRow`) and `getSheetsReadAuth()` (readonly scope, no
  impersonate — same model used by `projects.ts`, `people.ts`,
  `dashboard-episodes.ts`).
- `src/app/api/health/route.ts` — replaced 3 inline `new google.auth.JWT(...)`
  blocks with calls to those helpers. Now produces 3 distinct check
  results matching the 3 distinct auth models in the code.
- `src/app/admin/health/page.tsx` — relabeled rows to make the auth
  model visible in each check name. Added a one-line legend above the
  Live Checks list. Response shape change: `googleCalendar` →
  `googleCalendarDwd`; `producerDashboardSheet` →
  `producerDashboardSheetWrite` + new `producerDashboardSheetRead`.

### Verification

- `tsc --noEmit` clean.
- After deploy, `/admin/health` should show 4 green checks (DB +
  Calendar DWD + Sheets WRITE + Sheets READ) — they all match what
  the booking flows actually exercise.
- If a check fails, the row label tells you exactly which auth model
  broke, so the fix is unambiguous.

### Risk

Low. Widens health scopes from `.readonly` to write — service account
already has the broader grants because production code uses them. The
two new exported helpers are referenced only by `/api/health`; existing
production callsites still go through the same code paths via the
private alias `const getAuth = getCalendarAuth/getSheetsWriteAuth`.

---

## [1.32.0] — 2026-05-24

### Added — proposed GHA post-build smoke test (paste manually — token scope blocks auto-apply)

Until v1.31, the GHA workflow only verified that `next build` passed.
A commit could break startup (`start.sh` typo, prisma migration
failure, runtime JS error in a server component, env var reads that
explode without a fallback) and still get pushed to GHCR + tagged
`latest`. Operator would only discover the breakage when redeploying
in Portainer.

**Proposed `smoke-test` job** (added to `docs/gha-smoke-test.yml.proposed`
because the agent's PAT lacks `workflow` scope — see "How to apply"
below):

1. Spins up Postgres 16 as a GHA service container.
2. Pulls the just-built `sha-<commit>` image from GHCR.
3. Runs the image with `DATABASE_URL` pointing at the service Postgres
   + minimal NextAuth env (real Google creds intentionally omitted —
   we're not testing the Sheets/Calendar integration here, just
   startup).
4. Polls `GET /login` every 5 seconds for up to 180 seconds, waiting
   for a 200/302/307.
5. Fetches `/login` content + greps for the expected "Production
   Booking" title to verify the page actually rendered.
6. Surfaces the container log on both success and failure (with extra
   container state inspection on failure).

**What this catches** (once applied):

- `start.sh` failures (DB readiness wait, schema sync, seed errors).
- Prisma client mismatches (forgot to regenerate after schema change).
- Server-side errors that build-time `tsc` + `next build` miss.
- Container env contract drift (renamed env var with no fallback).

**What this does NOT catch** (out of scope for smoke):

- DWD / Google Calendar issues (no real creds in the smoke env).
- Specific booking creation / approval / assign flows.
- UI rendering issues past the login page.

**Does not gate deploy** (by design): the job runs *after* the image
is already pushed to GHCR. A failed smoke test marks the commit with
a red ✗ in GitHub but does not delete the image. Operator sees the
red status before pulling in Portainer. Future iteration: split into
`build → smoke → tag-as-latest` so smoke gates `latest` specifically.

### How to apply (manual one-time step)

The agent's GitHub Personal Access Token does not have `workflow`
scope, so it cannot modify `.github/workflows/*.yml`. Two options for
the human:

**Option A (easiest — via the web UI):**

1. Open `docs/gha-smoke-test.yml.proposed` in the repo on GitHub.
2. Copy the YAML below the comment header (starts with
   `# v1.32+ — boots the just-built image...`).
3. Open `.github/workflows/docker-build.yml` in the GitHub web UI →
   click the pencil (Edit) icon.
4. Paste the copied YAML as a second job in the `jobs:` block —
   directly after the `build-and-push:` job.
5. Commit directly to the branch via the web UI. (Web-UI commits use
   your personal session, not the PAT, so they have `workflow` scope.)

**Option B (give the PAT `workflow` scope):**

1. Go to https://github.com/settings/tokens
2. Find the PAT used for local pushes, click Edit.
3. Tick the `workflow` scope checkbox, save.
4. Re-run the push that adds the workflow file.

Once applied, every push to `main` or
`fix/assign-email-real-results` will produce two GHA jobs instead of
one. Operator can glance at the smoke-test status before pulling in
Portainer.

### Verification

- `docs/gha-smoke-test.yml.proposed` is valid YAML (verified
  syntactically — no parsing test possible without applying).
- Existing `build-and-push` job is unchanged on disk.
- Once user applies the file, the very first smoke run on a fresh
  commit will be the real verification.

---

## [1.31.1] — 2026-05-24

### Added / cleanup — ESLint config, docs, legacy redirect

Hygiene pass. No app behavior change.

**`.eslintrc.json` (new):**

- Extends `next/core-web-vitals`. Disables two noisy rules
  (`react/no-unescaped-entities`, `@next/next/no-img-element`) that
  fight our existing markup.
- `npm run lint` now works without prompting for setup. Current
  baseline: 0 errors, 2 warnings (both pre-existing: custom font in
  `app/layout.tsx`, useEffect dep in `ot/admin/page.tsx`).

**`docs/architecture.md` (new):**

- One-page mental model for new developers. Stack, data sources,
  booking lifecycle diagram, code map, background workers, auth
  model, deploy flow, diagnostic checklist, roadmap of what's
  deliberately not done yet. Read this first.

**`docs/runbook-backup.md` (new):**

- DB backup + restore procedure. **Currently the PLAN, not the
  reality** — there's no automated backup running yet. Includes the
  manual `pg_dump` commands, retention policy proposal, restore
  procedure with safety steps, quarterly verification drill, and an
  "in an actual emergency" section listing recovery paths if you have
  no backup (replay from PD Sheet, scrape Google Calendar, audit_logs).
- Action items list at the bottom — needs a target (S3 / GDrive /
  USB), cron schedule, and credentials setup.

**`src/app/booking/[outlet]/page.tsx` (rewrite — 400 lines → 10):**

- Was the legacy pre-wizard per-outlet form. v1.28 replaced it with
  the 5-step wizard at `/new` but kept the old page in the codebase.
  No internal href referenced it, but external bookmarks (`/booking/AGN`,
  `/booking/NWS`, etc.) may still exist in someone's notes/emails.
- Now a thin redirect: `redirect('/new')`. Old bookmarks land
  smoothly on the wizard instead of 404.

### Verification

- `next lint` runs clean (no errors).
- `tsc --noEmit` clean.
- `next build` passes — `/booking/[outlet]` still in the route table,
  size dropped from 6.3 kB → ~140 B (just the redirect).

---

## [1.31.0] — 2026-05-24

### Added — `team_members` DB table + `/admin/team` CRUD (decouple crew roster from code)

Crew assignment roster used to be a hardcoded `TEAM` constant inside
`src/app/admin/[id]/page.tsx` — adding/removing a crew member required a
code change + redeploy. v1.31 moves the roster to a Prisma table and
gives admins a CRUD UI.

**Schema — `TeamMember` model:**

```
model TeamMember {
  id        String   @id @default(cuid())
  email     String   @unique         // canonical id (matches assignedEmails)
  name      String                   // display name in assign checkboxes
  role      String                   // producer|video|director|sound|photo|switcher|virtualProduction
  active    Boolean  @default(true)  // false = hide from assign UI (history preserved)
  sort      Int      @default(0)     // tie-breaker within role group
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@map("team_members")
  @@index([role, active, sort])
}
```

`prisma db push --accept-data-loss` (in `start.sh`) creates the table
on next container start. No data loss because the table is new.

**Seed — `prisma/seed.ts`:**

- Imports `INITIAL_TEAM_ROSTER` from the new
  `src/lib/team-roster.ts` and **inserts only members missing from the
  DB**. Edits made later via `/admin/team` survive subsequent seeds.

**New module — `src/lib/team-roster.ts`:**

- Centralized `RosterRole` type, `ROLE_ORDER`, `ROLE_LABEL` map,
  `INITIAL_TEAM_ROSTER` seed data, and `groupByRole()` helper. Used by:
  - `prisma/seed.ts` (seed insert)
  - `src/app/api/admin/team/route.ts` (role validation)
  - `src/app/admin/team/page.tsx` (UI labels + dropdowns)
  - `src/app/admin/[id]/page.tsx` (fallback when API fails)

**API — `/api/admin/team` (new):**

- `GET` — list all members (active + inactive), sorted by ROLE_ORDER →
  sort → name. Admin-only.
- `POST` — create. Validates role against `ROLE_ORDER`; email must be
  unique (409 on dup).
- `PATCH /api/admin/team/[id]` — update `name`/`role`/`sort`/`active`
  (email is immutable — it's the canonical id used by
  `booking.assignedEmails`).
- `DELETE /api/admin/team/[id]` — soft-delete (`active: false`).
  Never hard-delete — historical bookings reference these emails.

**UI — `/admin/team` (new page):**

- Grouped by role with section headers (Producer / Coordinator,
  Videographer, …). Counts shown per group.
- Inline edit for each row (name + role). Email is read-only.
- Add-member form at the top (email + name + role dropdown).
- Soft-delete button (Trash icon) → confirmation → `active=false`.
  Re-activate button (Rotate icon) on inactive rows.
- "Show inactive" toggle so deactivated members can still be seen +
  re-activated.
- Linked from `/admin` header next to Permissions and Health.

**`/admin/[id]` change:**

- Removed the 40-line hardcoded `TEAM` constant.
- Added `team` state populated via `/api/admin/team` on mount; falls
  back to `groupByRole(INITIAL_TEAM_ROSTER)` if the API errors so the
  assign UI is **never blank** (defensive — same pattern as
  v1.29.4's calendar impersonate fallback).
- Section list (`teamSection label="Videographer" members={team.video}`)
  unchanged.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — 3 new routes registered (`/admin/team`,
  `/api/admin/team`, `/api/admin/team/[id]`).
- `start.sh` runs `prisma db push` → table created. Then `tsx
  prisma/seed.ts` → 26 initial team members inserted on first run.
- After deploy, `/admin/team` shows the seeded list grouped by role.
  Editing a member's name reflects on `/admin/[id]` assign UI
  immediately (after page refresh).

### Tradeoffs / follow-ups

- The fallback (hardcoded `INITIAL_TEAM_ROSTER`) means if an admin
  deactivates a member at `/admin/team` AND the API fetch happens to
  fail on `/admin/[id]`, that member could still appear in the assign
  UI. Acceptable trade — the alternative is an empty assign UI on
  transient errors, which is worse for the assignment workflow.
- Adding a brand-new role beyond the seven defined in `ROLE_ORDER`
  still requires a one-line code change (add to `ROLE_ORDER` +
  `ROLE_LABEL` + a `<TeamSection>` in `admin/[id]`). Worth doing only
  if multiple new roles need to be supported.

---

## [1.30.0] — 2026-05-24

### Added — single-source Producer Dashboard sheet config + `/admin/health` diagnostic page

Long-running setup: production deploys will eventually point at a real
Producer Dashboard sheet (separate from today's sandbox). Two changes
to make that swap safe + verifiable:

**1. `src/lib/google-config.ts` (new) — single source of truth for
sheet config:**

- `SANDBOX_PRODUCER_DASHBOARD_SHEET_ID` constant + `getProducerDashboardSheetId()`
  helper. Reads `PRODUCER_DASHBOARD_SHEET_ID` env first; falls back to
  the sandbox id.
- `isUsingSandboxSheet()` + `maskSheetId()` for safe display
  ("10TnR0…pSzL4").
- Inlined consumers: `google-sheets.ts`, `projects.ts`, `people.ts`,
  `dashboard-episodes.ts` — all dropped their private 4-way duplicated
  `DEFAULT_DASHBOARD_SHEET_ID = '10TnR0…'` constant and now `import {
  getProducerDashboardSheetId } from './google-config'`. Future swaps
  touch one file.

**2. `GET /api/health` (new, admin-only):**

Returns runtime config + live checks in one response:

- **Config (masked):** version, NODE_ENV, sheet id (masked) +
  source (`env` vs `hardcoded-fallback`) + sandbox flag, calendar id
  (masked), impersonate subject + source, NextAuth + reconcile worker
  secrets (set/missing booleans, never the values themselves), SMTP
  config presence.
- **Live checks (each timed):**
  - DB — `prisma.booking.count()` round-trip.
  - Google Calendar — DWD JWT → `calendars.get` on the configured
    calendar id.
  - Producer Dashboard sheet — DWD JWT → `spreadsheets.get` on the
    configured sheet id; returns the sheet title + tab list.
- Returns 200 if every check passes, 503 otherwise.

**3. `/admin/health` (new page):**

Pretty wrapper around `/api/health`. Shows:

- Top-line "All systems operational" / "One or more checks failed"
  banner.
- **Amber SANDBOX warning** when the sheet env is unset / matches the
  sandbox id — admins immediately see they're on the dev sheet, with
  exact instructions for the production swap.
- Live check results with latency + error details for failing checks.
- Source badges (`env` green vs `hardcoded fallback` amber) so it's
  obvious which knobs are explicitly configured vs. relying on a
  safety-net default.
- Linked from `/admin` header next to Permissions.

**4. `docs/runbook-sheet-swap.md` (new):**

Step-by-step procedure for swapping the Producer Dashboard sheet
(sandbox → production) with a verification checklist + rollback steps.
Covers the failure modes (service account access, wrong id, forgetting
to redeploy) and notes the 5-min cache TTL.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — new route `/api/health` registered.
- No behavior changes to the booking / approve / assign / calendar
  flows. This release adds infrastructure (config consolidation +
  observability), not user-visible features.

### Tradeoffs / follow-ups

- `/admin/health` does live network calls (DB + Calendar + Sheets) per
  page load. Cheap (~50–500ms) but don't auto-poll it; the Re-check
  button is manual on purpose.
- The Calendar / Sheet checks reuse the same DWD JWT used by the
  worker, so a healthy /admin/health implies the worker can talk to
  Google too.
- `GOOGLE_SHEETS_ID` env var present in the Portainer stack is not
  consumed by any code (verified). Documented in
  `runbook-sheet-swap.md` notes; safe to leave or remove.

---

## [1.29.4] — 2026-05-24

### Fixed — hardcoded fallback for the impersonated Workspace user

Confirmed root cause of the long-running "calendar guests not added" issue
via live Portainer inspection on 2026-05-24:

- Service account creds: ✓ set
- Google Admin DWD: ✓ granted (client id `106117530552798836735`, scope
  `https://www.googleapis.com/auth/calendar` — full read/write)
- Shared calendar "THE STANDARD Production Bookings": ✓ shared with
  `narasit.k@thestandard.co` with "Make changes and manage sharing"
- Portainer stack env editor: shows `GOOGLE_IMPERSONATE_SUBJECT=
  narasit.k@thestandard.co` (51 chars, no whitespace)
- **Running container env vars: GOOGLE_IMPERSONATE_SUBJECT is MISSING**

The Portainer stack is Repository-mode (deploys from
`docker-compose.portainer.yml` in git). That compose has the default
`${GOOGLE_IMPERSONATE_SUBJECT:-narasit.k@thestandard.co}` since v1.26.4,
which should set the env var either way. But git fetch has been failing
intermittently (saw `Failed to fetch latest commit id` and `Failed to
pull images of the stack` toasts) and Portainer kept using a stale
cached compose file that pre-dates the default — so the var never made
it into the container.

**Fix:** hardcode the same fallback at the application layer in
`src/lib/google-calendar.ts`:

- `DEFAULT_IMPERSONATE_SUBJECT = 'narasit.k@thestandard.co'`.
- `getCalendarImpersonateSubject()` returns the env value when set
  (trimmed); otherwise returns the default and logs a one-time warning
  to the container log so the misconfig is still discoverable.

Net effect: calendar guest sync now works whatever shape the Portainer
stack is in, as long as DWD itself is healthy. The env var still wins
when set (so multi-Workspace deploys or different impersonators can
override).

### Verification

- `tsc --noEmit` clean.
- `next build` passes.
- After deploying `sha-<this-commit>`, Re-sync on the affected bookings
  (PP-26-001-L01, PP-26-006-L01) must turn the chip green:
  `✓ event created with N guests` — and the events appear on Google
  Calendar "THE STANDARD Production Bookings" with the assigned crew
  as guests.

### Follow-up

- Portainer's stale-compose issue should still be fixed for hygiene:
  either fix the box's DNS/git connectivity so `Failed to fetch latest
  commit id` stops happening, or detach the stack from Git and re-add
  it. The code fix is defensive — it doesn't address the underlying
  Portainer/git plumbing.

---

## [1.29.3] — 2026-05-23

### Fixed — surface the real reason `createCalendarEvent` failed (was: silently returning null)

Direct follow-up to v1.29.2: when ops clicked **Re-sync** on two
CONFIRMED bookings, both came back with the unhelpful chip
`⚠ createCalendarEvent returned null`. That message was the wrapper
saying "the underlying call gave me nothing" — the *actual* Google
Calendar error was being eaten by `createCalendarEvent`'s broad
`catch → return null` and a few defensive `return null`s on known
failure modes (no credentials, DWD off, attendees rejected). The
upstream reason only showed up in container logs / `AuditLog`, which
defeats the whole point of the v1.29.2 admin Re-sync button.

**Fix — `src/lib/google-calendar.ts` `createCalendarEvent`:**

Every `return null` on a known failure path is now a `throw Error(...)`
with a human-readable, action-oriented message:

- **No service account credentials** →
  `Google service account not configured — set GOOGLE_SERVICE_ACCOUNT_JSON …`
- **`requireAttendees: true` + DWD off** →
  `GOOGLE_IMPERSONATE_SUBJECT not set … set GOOGLE_IMPERSONATE_SUBJECT to a Workspace user (e.g. narasit.k@thestandard.co) … and redeploy.`
- **`requireAttendees: true` + Google rejected the attendees array** →
  `Google Calendar rejected event create with attendees: <upstream message>`
  (the actual API error from Google, e.g. "Service accounts cannot
  invite attendees without Domain-Wide Delegation of authority", or
  "Calendar usage limits exceeded", etc.)

The outer `catch` no longer swallows — it re-throws (wraps non-Error
values with a `Calendar event create failed:` prefix). All known
callers (`approve/route.ts`, `assign/route.ts`,
`calendar-reconcile.ts → createVerifiedCalendarEvent`) already wrap
the call in try/catch, so this is non-breaking for them — the
difference is that the caught error now carries the real reason.

**Fix — `src/lib/calendar-reconcile.ts`:**

`createVerifiedCalendarEvent` kept the defensive
`if (!eventId) throw new Error('createCalendarEvent returned null')`
fallback as belt-and-suspenders for the unlikely case Google returns
an event without an id. Replaced that generic message with a
direction to retry / check AuditLog. The common configuration cases
now bubble up specific messages instead.

### Net effect on the admin Re-sync UX

Before this fix:
```
⚠ createCalendarEvent returned null
```

After this fix (the same DWD-off booking):
```
⚠ GOOGLE_IMPERSONATE_SUBJECT not set (or env value is empty after trim)
  — Domain-Wide Delegation is required to add calendar guests …
```

— and the admin knows exactly which Portainer env var to fix.

### Verification

- `tsc --noEmit` clean.
- `next build` passes.
- No public API change — `createCalendarEvent` still returns
  `Promise<string | null>` (the residual `null` is for the unexpected
  Google-response-with-no-id case). The change is purely error-message
  quality.

---

## [1.29.2] — 2026-05-23

### Added — calendar link on admin booking cards + on-demand Re-sync button

Ops report: a CONFIRMED booking (Content Agency · Long Form (project),
1 assigned crew member) showed no Google Calendar event, and the admin
had no way to see *why* without SSH'ing into the container to read logs.
This release surfaces the calendar state directly on each booking card.

**New: `<CalendarStatus>` on `/admin` cards** (CONFIRMED + COMPLETED):

- **Has `calendarEventId`** → blue chip "📅 Open in Calendar" linking to
  the public event URL (or "📅 Calendar event linked" tooltip with the
  event id when the htmlLink isn't cached yet — first Re-sync click
  fetches it).
- **No `calendarEventId`** → red chip "⚠ No calendar event" so the
  failure mode is impossible to miss.
- **Always present** → "Re-sync" button. Triggers an immediate
  per-booking reconcile (no waiting for the 10-minute worker tick).
  Inline result chip after the call: `✓ event created with N guests`,
  `✓ guests updated (N)`, `✓ already in sync`, or `⚠ <reason>`.

The button is deliberately shown even when the event link is green, so
an admin who hears "I didn't get the calendar invite" from crew can
force a guest patch immediately without chasing logs.

**New endpoint: `POST /api/admin/[id]/calendar-resync`**

- Admin-auth only (`requireAdmin`).
- Calls `reconcileSingleBooking(bookingId)` — same code path as the
  background worker, just scoped to one booking.
- Returns the full `ReconcileItem`: `{ ok, action, eventId, htmlLink,
  assignedEmails, calendarAttendees, error? }`. Action is one of
  `ok | patched | created | failed | skipped`.
- `GET` alias provided for ad-hoc browser testing while signed in.

**Refactor: `src/lib/calendar-reconcile.ts`**

- Extracted the per-booking work into a private `processBooking()` that
  takes a fully-included booking record and the reconcile options
  (`actorEmail`, `dryRun`). The bulk worker
  (`reconcileCalendarGuests`) now loops over `processBooking`; the new
  single-booking entry point (`reconcileSingleBooking`) fetches one
  booking and calls the same function. Same AuditLog rows
  (`calendar.reconcile_created/_patched/_recreated/_failed`), same
  verification semantics, same DB writes — but now reusable.
- `reconcileSingleBooking` rejects non-CONFIRMED bookings with a
  human-readable `skipped` reason instead of silently doing nothing.
- `ReconcileItem` now exposes `htmlLink?: string | null` so the admin
  UI can display the Google Calendar URL the moment a reconcile
  completes.

### Diagnosing the user-reported case

After deploy, on the affected CONFIRMED booking:

1. Click **Re-sync** on the card.
2. Read the inline result chip:
   - `✓ event created with 1 guest` → root cause was the approve
     background create silently failing (DWD blip, network); the new
     event is correct.
   - `✓ guests updated (1)` → event existed but didn't have the
     assigned email yet; just patched.
   - `⚠ GOOGLE_IMPERSONATE_SUBJECT not set …` → DWD config issue. Set
     the env var (or fix its value) in the Portainer stack and
     redeploy.
   - `⚠ <google api error message>` → likely Workspace-side: DWD scope
     drift, impersonated user lost calendar access, or the calendar id
     was changed. Cross-reference `AuditLog action='calendar.invite_*'`
     for the same booking.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — `/api/admin/[id]/calendar-resync` appears in
  the route table.
- No behavior changes to the background worker, approve, or assign
  paths; this release adds a manual escape hatch + visibility, doesn't
  touch the automated flow.

---

## [1.29.1] — 2026-05-23

### Fixed / hardened — reconcile worker resilience + Docker build hygiene

Quick dev-audit pass on top of v1.29.0. No application-logic change; purely
operational reliability + repo hygiene. Found by reading the freshly-shipped
reconciler with a "what breaks at 3am" lens.

**Reconcile worker (`scripts/calendar-reconcile-worker.js`):**

- `parsePositiveInt()` helper guards the interval env var. Previously
  `Number(process.env.CALENDAR_RECONCILE_INTERVAL_MS || 600000)` returned
  `NaN` when the env value was a non-numeric string, and `setInterval(fn,
  NaN)` is silently clamped to ~1ms — a runaway loop that would hammer
  the internal endpoint, the DB, and Google Calendar. Now any non-finite
  or non-positive value falls back to the 10-minute default.
- Loud-fail when no secret is configured. The internal endpoint also
  accepts admin sessions, but the worker is headless — without a secret
  it 401s every request forever in silence. New startup warn line
  surfaces that immediately so it shows up in `docker logs`.
- Startup log now reports the resolved `baseUrl` and `secret=set/MISSING`
  so a misconfiguration is obvious from line one of the container log.
- SIGTERM / SIGINT handlers clear the timer and exit 0. Container stop
  no longer waits for the SIGKILL grace period to take the worker out.

**Supervisor wrapper (`start.sh`):**

- Wraps the worker in `while true; do node …; sleep 5; done &` so a
  crashed worker auto-restarts after 5 seconds instead of staying dead
  for the rest of the container's lifetime. The 5-second back-off
  prevents a hot loop if the script throws on require.

**Docker build hygiene:**

- `.dockerignore` (new — committed). Codex had created this locally but
  never committed it, so every `docker build` was tarballing
  `node_modules`, `.next`, `backups/`, and `.git` into the daemon
  context. The committed file is more conservative than Codex's draft:
  - **`CHANGELOG.md` is NOT excluded** — `src/app/changelog/page.tsx`
    does `fs.readFileSync(cwd+'/CHANGELOG.md')` at runtime. Codex's
    draft excluded it, which would have made `/changelog` show
    "Changelog not found" in production.
  - `USER_MANUAL_TH.md` also stays for the same reason
    (`src/app/manual/page.tsx`).
  - Inline comment explains the runtime-read invariant so future edits
    don't regress this.
- `.gitignore` now ignores `/backups`, `*.sql`, `*.dump`. The repo
  already had a local `backups/` directory containing a real DB dump
  (`production_booking_20260523_142436.sql`). That's user data — must
  never get committed by accident.

**Compose parity (`docker-compose*.yml`):**

- Both composes now show `CALENDAR_RECONCILE_URL` as a commented-out
  override. Default `http://127.0.0.1:3000` works for the standard
  container layout; the override is needed only if `PORT` is changed.
  Discoverable via comment instead of having to read the worker source.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — no new routes (this was a hygiene pass).
- No application-logic changes. Reconciler behavior unchanged; only its
  resilience and discoverability improved.

---

## [1.29.0] — 2026-05-23

### Added — calendar guest auto-reconciler + strict "no event without guests" path

Layered on top of v1.28.2's synchronous-assign fix. After v1.28.2 went out,
ops observed that the underlying Google Calendar invite path can still fail
transiently (DWD impersonation token blip, network hiccup, attendees patch
rejected mid-flight). Those events would heal only on the next manual
re-assign. This release adds an **automated reconciliation loop** that
detects and repairs guest drift on its own, plus a stricter create path so
a missing-guest event is no longer treated as success.

**New module — `src/lib/calendar-reconcile.ts`:**

- `reconcileCalendarGuests({ limit, actorEmail, dryRun? })` pulls
  CONFIRMED bookings that have `assignedEmails`, fetches each booking's
  Google Calendar event, and reconciles drift:
  - No `calendarEventId` on the booking → create event with guests baked
    in, **verify the guests landed by re-fetching the event**, persist
    `calendarEventId`. If the verification fails, delete the half-created
    event and surface the error.
  - Event exists but disappeared on Google's side (404) → same recreate +
    verify path; old `calendarEventId` logged into the audit row.
  - Event exists, guest list differs → `updateCalendarEventAttendees`
    patch; if patch fails, fall back to delete + recreate so the result
    matches `assignedEmails` exactly.
  - Event exists and guests match → no-op (logged as `ok`).
- Every action emits a typed `AuditLog` row:
  `calendar.reconcile_created`, `calendar.reconcile_recreated`,
  `calendar.reconcile_patched`, `calendar.reconcile_failed`. Actor is
  `calendar-reconcile` (worker) or the admin's email (manual run).

**New internal endpoint — `src/app/api/internal/calendar/reconcile/route.ts`:**

- `GET /api/internal/calendar/reconcile?limit=N&dryRun=0` (and `POST`
  alias) runs the reconciler.
- Two auth modes:
  1. **Worker auth** — `x-reconcile-secret: <secret>` or `Authorization:
     Bearer <secret>`. Secret resolves to `CALENDAR_RECONCILE_SECRET` →
     `NEXTAUTH_SECRET` → `AUTH_SECRET`.
  2. **Admin auth** — signed-in admin session can hit the endpoint
     directly from a browser to trigger a manual run.

**New worker — `scripts/calendar-reconcile-worker.js`:**

- Plain Node script, no framework. Spawned from `start.sh` as
  `node scripts/calendar-reconcile-worker.js &` after the Next.js server
  is up. Calls the internal endpoint every `CALENDAR_RECONCILE_INTERVAL_MS`
  (default 600000 = 10 min), first run delayed 30s to let the server warm.
- Re-entrant guard (`running` flag) so a slow run can't pile up.
- Only logs when something actually changed (patched/created/failed > 0)
  to keep container logs quiet.

**`src/lib/google-calendar.ts` (+131 -24):**

- `createCalendarEvent(booking, options)` now accepts
  `{ requireAttendees?: boolean }`. When set, the function refuses to
  create a guest-less event under any of:
  - `GOOGLE_IMPERSONATE_SUBJECT` not configured (DWD off)
  - Google rejects the attendees array (DWD scope drift, impersonation
    user lost calendar access)
  In strict mode the function returns `null` after writing a
  `calendar.invite_failed` audit row with `fallbackCreated: false`, so
  the caller can react instead of pretending the booking has a calendar
  entry. Default behavior (unset) keeps the v1.26.5 fallback: create
  guest-less event + alert.
- `notifyCalendarAlert` gained a `fallbackCreated` flag so the alert
  email distinguishes "we wrote an event but couldn't add guests" from
  "we aborted; nothing was created".
- New `getCalendarEventAttendees(eventId)` returns
  `{ exists, attendees[], htmlLink? }`. Used by the reconciler to
  diff what Google actually has against what the DB thinks.
- `parseTime` replaced by `parseBangkokDateTime` + `addHoursInBangkok`.
  Uses explicit `+07:00` strings in the dateTime field instead of
  `.toISOString()` (which is UTC). The previous form was timezone-correct
  if the server was in Asia/Bangkok but drifted on UTC containers — the
  Portainer image runs UTC. This was a quiet bug hiding behind the
  `timeZone: 'Asia/Bangkok'` hint on the event.
- `getCalendarImpersonateSubject()` (used everywhere DWD is checked) now
  trims the env var. Trailing newlines/spaces from Portainer's env
  editor were silently disabling DWD.
- `deleteCalendarEvent` adds `sendUpdates: 'none'` (don't email guests
  about a recreate) and treats 404 as success (idempotent).

**`src/app/api/admin/[id]/approve/route.ts`:**

- Passes `requireAttendees: booking.assignedEmails.length > 0` when
  calling `createCalendarEvent`. If admin approves a booking that
  already has crew but DWD is broken, approve no longer silently
  creates a guest-less event.

**`src/app/api/admin/[id]/assign/route.ts`:**

- Same `requireAttendees` flag passed to the auto-recover
  `createCalendarEvent` branch.
- Switched `process.env.GOOGLE_IMPERSONATE_SUBJECT` reads to
  `getCalendarImpersonateSubject()` so the trimming applies here too.

**`start.sh`:**

- Spawns the reconcile worker after migrations + seed, before the Next.js
  exec. Worker runs as a detached background process inside the
  container; killing the container kills it.

**`docker-compose.portainer.yml`:**

- New env vars: `CALENDAR_RECONCILE_SECRET` (defaults to
  `NEXTAUTH_SECRET`) and `CALENDAR_RECONCILE_INTERVAL_MS` (default 10
  minutes).

**`docker-compose.yml` (dev):**

- Parity with the Portainer compose: added the two reconcile vars + the
  `GOOGLE_IMPERSONATE_SUBJECT` / `CALENDAR_ALERT_EMAIL` defaults that
  were already in the Portainer compose. Local dev now exercises the
  same worker path as production.

### Verification

- `tsc --noEmit` clean.
- `next build` passes — `/api/internal/calendar/reconcile` appears in the
  route table.
- Codex's image build on this branch went green (`sha-452857f`).
- **Manual QA still pending** for the full reconcile loop end-to-end on
  the live Portainer stack. The plan in `docs/ops-log.md` for this
  release lists the steps.

### Tradeoffs / follow-ups

- Reconcile worker is a separate process inside the container — if it
  crashes it doesn't take the web server with it, but it also won't
  restart on its own. Acceptable for v1; if needed, wrap with a tiny
  supervisor (`while true; do node …; sleep 5; done`) later.
- Worker auths against `localhost:3000`. If a future deploy changes the
  internal port, set `CALENDAR_RECONCILE_URL`. Currently undocumented in
  the compose file — add when actually needed.
- `requireAttendees` is opt-in per call. Both server-side callers
  (approve, assign) use it; the reconciler always uses it. The
  legacy/external callers (if any) keep the old fallback behavior. A
  future pass could make `requireAttendees: true` the default.
- No automated tests for the reconciler. The Codex commits did not add
  any; we're relying on AuditLog rows + manual verification. A small
  Vitest suite for `reconcileCalendarGuests` (using fakes for Google +
  Prisma) is the natural next step but out of scope for an emergency
  reliability fix.

---

## [1.28.2] — 2026-05-23

### Fixed — calendar guests now sync synchronously on Assign (regression)

**Symptom (reported by ops):** assigning crew on `/admin/[id]` did not add
those people as guests on the Google Calendar event for the booking. The
booking still showed the assigned list in the app and emails went out, but
the calendar event stayed empty (or kept the previous guest list on
re-assign). v1.26.x had fixed this once via Domain-Wide Delegation;
something silently regressed.

**Root causes (two, fixed together):**

1. **Race condition on the approve → assign sequence.** Approve creates
   the calendar event in a background task. If admin clicked Assign before
   that background task finished, `booking.calendarEventId` was still
   `NULL`, so the `if (booking.calendarEventId)` guard in the assign route
   skipped the attendee update entirely. The event was created later
   *without* guests, and nothing reconciled them.
2. **Fire-and-forget attendee patch.** The assign route called
   `updateCalendarEventAttendees(...).catch(...)` (no `await`). Failures
   (DWD off, Google API rejection, expired impersonation) were logged
   server-side but the response said "✓ Saved & sent N emails" regardless,
   so admins assumed guests went out.

**Fix (`src/app/api/admin/[id]/assign/route.ts`):**

- Attendee update is now `await`ed. Result is captured into a typed
  `calendarSync: { ok, eventId, action, error? }` object.
- **Auto-recover branch added:** if the booking is `CONFIRMED` but has no
  `calendarEventId` (race or earlier create failure), the assign route
  creates the calendar event right then, with the just-assigned crew baked
  in as guests, and saves the new `calendarEventId` to the DB.
- Branch (3) — booking still in `REQUESTED`/`ASSIGNED` (not yet approved)
  — stays a no-op; the existing approve route already bakes
  `assignedEmails` into the event it creates, so guests will appear the
  moment admin approves.

**Admin UI (`src/app/admin/[id]/page.tsx`):**

- The Assign toast now reports calendar guest sync status, e.g.
  - `✓ Saved & sent 3 emails · calendar guests updated (3)`
  - `✓ Saved & sent 3 emails · calendar event auto-created with 3 guests`
  - `⚠ Saved · sent 3/3 · calendar guests NOT added (Google Calendar API
    rejected the attendees update — see AuditLog calendar.attendees_update_failed)`
- A failed calendar sync downgrades the toast tone to `warning` even when
  email + DB save succeeded, so admins notice immediately instead of
  finding out from crew that they didn't get invites.

**Behavior preserved:**

- Approve's background calendar create kept (don't block approve UX).
- Email send loop unchanged.
- `calendar.attendees_update_failed` / `calendar.invite_failed` AuditLog
  rows + alert emails (from v1.26.5) still fire — now the UI also
  reports them inline so admins don't have to query AuditLog to discover
  silent failures.
- `updateBookingRow` to the Producer Dashboard sheet still happens.

### Verification

- `tsc --noEmit` clean.
- `next build` passes (only pre-existing dynamic-server warnings on OT/audit
  routes).
- Manual QA (after deploy):
  1. Submit a booking → approve immediately → assign 2 crew within 5s →
     toast should read `calendar event auto-created with 2 guests` (the
     race window). Calendar event in Google Calendar must show the 2
     guests.
  2. Submit + approve + wait 30s + assign → toast should read
     `calendar guests updated (N)`. Event must have N guests.
  3. Re-assign on an already-CONFIRMED booking with crew → swap one
     member → toast `calendar guests updated`; calendar event reflects
     the swap and removed crew gets a cancellation.
  4. If toast warns `calendar guests NOT added` → query `AuditLog`
     `action='calendar.attendees_update_failed'` for the diagnostic.

---

## [1.28.1] — 2026-05-23

### Changed — booking wizard step 4 field order

In the People & Crew step (CA flow), the field order now reads top-to-bottom
as the actual cascade chain: **Producer → Project ID → Episodes → Director →
Crew → Notes**. Previously Director sat between Producer and Project, which
made the "pick Producer first so the Project list filters" relationship
harder to spot.

No data-model, validation, or POST-payload changes — purely a JSX reorder
in `src/app/_components/booking/BookingWizard.tsx`. Director is still
required for CA bookings.

---

## [1.28.0] — 2026-05-23

### Changed — operations-console UI redesign (Home, 5-step booking wizard, Calendar drawer, inbox-style My Bookings)

A full visual + IA pass to move the app away from a "Google-Form-on-a-page"
look toward a modern, dense, internal-operations console. **No API, schema,
or POST-payload changes** — same `/api/bookings` POST body, same calendar
event behavior, same email triggers, same Producer Dashboard sync.

**Design system (`tailwind.config.ts`, `src/app/globals.css`):**

- New cool-neutral app background (`#F6F7F9`) replacing the legacy
  `#F0EBF8` light-purple — quieter surface that lets content lead.
- **Canonical status palette** added to the Tailwind theme
  (`status-{requested|assigned|confirmed|completed|cancelled}-{50|500|700}`)
  and exposed through a new `<StatusPill>` shared component so every
  page renders status identically (dot, soft fill, border, label).
- New `.ops-*` primitive classes (card, input, label, button, tab, choice,
  table, empty) — 8px radius across the board, no nested cards. **Legacy
  `.gf-*` classes preserved** for pages still using the Google-Form look
  (login, manual, changelog, admin detail, booking success, OT).
- Font defaults to Google Sans then Inter (was Inter only).

**Information architecture:**

- `/` is no longer the booking form. New home is an **Overview** page with:
  3 KPI cards (Today / This week / Needs attention), Today's schedule,
  My upcoming, Needs attention (REQUESTED bookings — the operator's main
  queue). Cards link through to their detail pages.
- The booking form moved to **`/new`** and is reachable from a persistent
  `+ New Booking` CTA in the nav.
- Nav reorganized: Overview · Calendar · My Bookings · Producer (gated) ·
  Dashboard (admin) · Admin (admin). Secondary links (OT, Manual,
  Changelog, Upload) now sit in a "More" dropdown on desktop. Compact
  brand mark replaces the long "THE STANDARD · Production" wordmark.
  Active route gets a filled dark chip rather than an underline.

**Booking wizard (`src/app/_components/booking/BookingWizard.tsx`, new):**

- Long form replaced by a **5-step wizard**: Project → Schedule →
  Location → People & Crew → Review. Each step is a single card with a
  clear heading + per-step validation; only the Review step's "Confirm &
  Submit" actually POSTs.
- **Desktop layout: two columns** — form on the left, **sticky live
  summary on the right** (auto-fills as the user types; dot turns green
  per group once filled).
- **Mobile layout: single column** with a **fixed bottom action bar**
  (Back · Step counter · Next/Submit) and a tap-to-expand summary above
  it. Form fields stack and inputs have larger tap targets.
- Stepper at the top shows completion ticks per step and is **clickable**
  for jumping between visited steps.
- Per-step error display preserved (inline `AlertCircle` under the field,
  `aria-invalid`, top-of-form summary banner).
- All cascade logic preserved (Outlet change clears Episode Type /
  Project / Producer / Director / Episode picks + amber warning banner;
  CA Producer change clears Project ID; CA Project change clears Episode
  picks).
- Submission payload bit-for-bit identical to v1.27.

**Calendar (`src/app/calendar/page.tsx`):**

- **View toggle**: Month (desktop default) vs **Agenda** (mobile default,
  auto-detected). Agenda is a 30-day list grouped by day with a "Today"
  badge — much easier to scan on a phone than the dense month grid.
- **Detail drawer** replaces the hover tooltip + selected-day list. Click
  any event chip or row → a side-sheet slides in (right on desktop,
  bottom on mobile) with status, schedule, location, people, episode
  list, and an "Open detail →" CTA to the existing detail page. Closes
  on Escape and scrim click.
- Day cells: event chips use neutral borders + a single status-color
  dot (rather than full-color tinted backgrounds) — denser and reads
  better when a day has 3+ bookings.

**My Bookings (`src/app/my-bookings/page.tsx`):**

- Inbox-style **6 tabs**: Upcoming · Requested · Assigned · Confirmed ·
  Completed · Cancelled. Each tab shows a count chip. Upcoming sorts
  ascending (soonest first); status tabs use API order.
- Full-text search across episode ID, program, producer, location.
- One fetch (`scope=mine`, limit 200), client-side bucketing — no
  separate request per tab.
- Empty state per tab points the right way (Upcoming → "create one").

**Dashboard (`src/app/dashboard/page.tsx`):**

- Status palette colors aligned with the rest of the app (status-token
  values); donut now includes ASSIGNED.
- All cards/tables converted to the `.ops-card` / `.ops-table` look —
  consistent with Overview, Calendar, My Bookings.
- Status column uses `<StatusPill>`.
- Charts and filtering behavior unchanged.

**Shared (`src/app/_components/StatusPill.tsx`, new):**

- Single source of truth for status visuals. Used by Overview, Calendar
  (legend + drawer), My Bookings, Dashboard.

### Changed — `package.json`

Version bump 1.27.0 → 1.28.0.

### Verification

- `tsc --noEmit` clean.
- `next build` passes (33 routes built; only pre-existing dynamic-server
  warnings on `/api/ot/export` and `/api/ot/summary` — unrelated to this
  PR, they use `headers()` for session).
- No automated tests added — project has no test runner configured.
  Manual verification path documented in `docs/ops-log.md` for this
  release.

### Tradeoffs / follow-ups

- The wizard's per-step validation is duplicated from the legacy
  whole-form `validate()`; consolidating into a typed Zod schema is a
  natural next step but out of scope for a UI-only PR.
- Calendar still uses a hand-rolled grid + date-fns rather than a calendar
  library — view-toggle + drawer were added without changing that
  foundation. Week view is not implemented yet (spec mentioned it as
  optional for desktop); the agenda view + month view cover the
  scan-by-day use case for now.
- The Overview page assumes "Needs attention" === REQUESTED bookings the
  current user can see. Admins see org-wide REQUESTED; non-admins see
  only their own + confirmed-everywhere (existing API behavior). If we
  want admins-only items here, we'd add a server-side `attention=true`
  flag — flagged for a follow-up.
- The legacy `/booking/[outlet]/page.tsx` (outlet-scoped form) was not
  touched and still uses the old `.gf-*` styling. Removal candidate
  if it's unused — verify before deleting.

---

## [1.27.0] — 2026-05-23

### Changed — booking flow UX overhaul (form sections, Review step, inline errors)

A workflow-focused pass on the user-facing surfaces. No data-model, API, or
submission-behavior changes — same fields, same POST payload, same downstream
effects (calendar event, sheet write, OT sync). Internal QA only: typecheck +
`next build` pass; no automated tests were added because the project has no
test runner configured (deliberately deferred — see Tradeoffs below).

**Booking form (`src/app/page.tsx`):**

- Restructured the long single form into **6 numbered sections**: Project,
  Schedule, Location, Production Details, People / Crew, Notes — each with a
  short hint under the heading. Dense card layout preserved (no marketing
  hero, no decorative spacing inflation).
- **Review step before Submit.** Clicking the primary button now shows a
  read-only summary of every field (Outlet, Episode Type, dates, times, room,
  Producer/Director, Project ID, Episodes, crew, notes) split into the same 6
  sections. The user can `← Back to edit` or `Confirm & Submit`. **No POST
  fires until Confirm.** A two-dot step indicator (Fill → Review) lives in
  the header so the user always knows where they are.
- **Per-field error display.** Replaced the single top-of-form error string
  with a `fieldErrors: Record<string, string>` map. Each invalid field shows
  its own message with an `AlertCircle` icon right under the input, plus an
  `aria-invalid` attribute for assistive tech. The top-of-form message becomes
  a summary pointing the user to the highlighted fields.
- **Date/time validation** is sharper: end-date error now sits on the end-date
  field; estimated-wrap-before-call-time is caught when the shoot is a single
  day.
- **Outlet-change warning banner.** When Outlet changes and dependent fields
  (Episode Type, Producer, Director, Project ID, Episode picks) get cleared,
  a transient amber banner names exactly which fields were wiped and which
  flow the user just switched into (Content Agency vs standard) — so silent
  data loss is gone.
- **Helper text on confusing fields:** Episode Type (L/S/A/T meaning),
  Category (when to use each), Estimated Wrap (workload calc, optional),
  Crew Required (videographer count guidance), Project ID (sheet source +
  Producer filter), Shoot Type vs Location/Room (independence). Existing
  Thai-only labels (แขก / Subject) preserved.

**Calendar (`src/app/calendar/page.tsx`):**

- Event chips now read `10:00 · AGN · Talk Show` (truncated full program
  name) instead of the cryptic `10:00 AGN·T`. Time and outlet stay full;
  program name takes the remaining width with truncation. Status color
  coding preserved. The hover preview (already present) was left untouched —
  it already shows program, time, producer, location, status, episode IDs.

**Navigation (`src/app/_components/Nav.tsx`):**

- **Persistent `+ New Booking` primary CTA** on every page (mobile and
  desktop), styled with `.gf-submit` so it pops without being marketing-y.
- Reordered primary links to match daily workflow: Calendar · My Bookings ·
  Producer · Dashboard · Admin.
- Pushed secondary items (OT, คู่มือ, อัปเดต, Upload [DEV]) behind a vertical
  divider with smaller/greyer styling so they don't compete with daily-use
  links. Same items, less visual weight.

**Dashboard role clarity (`src/app/dashboard/page.tsx`):**

- Renamed to **Admin Dashboard**, subtitle clarifies it's org-wide and points
  Producer-role users to `/producer` for their personal view.
- Three numbered sections with hints under each: **Booking Overview**
  (charts), **Team Workload** (range + workload bar + table), **All Bookings**
  (filters + table). Same content; clearer signposting.
- Nav still gates this page to admins; producers continue to land on
  `/producer` and everyone has `/my-bookings`.

### Tradeoffs / deferred for a later phase

- **No automated tests added.** The project has no Jest/Vitest/Playwright
  setup; adding one purely to cover the new Review step and field validation
  would have ballooned this change. Manual QA matrix recommended: validation
  paths for both CA and non-CA flows, Outlet-change cascade, Review →
  Back-to-edit → Confirm round trip, calendar chip readability across statuses.
- **Conflict detection (room/crew/time overlap) was scoped OUT.** It needs
  a backend overlap query against existing bookings and a client warning
  surface; deferred to a follow-up. The current Outlet-change banner pattern
  is the right home for it once the API endpoint exists.
- **No 2-mode landing page (New Booking vs View Schedule).** The user
  explicitly chose to keep `/` as the dense booking form, with the persistent
  `+ New Booking` CTA + Calendar link in the nav serving the same need
  without a hero-style landing.
- Producer dashboard (`/producer`) was left structurally as-is — it already
  filters to the producer's own bookings with status badges and history, which
  is exactly the "my workload / my bookings" view the spec asked for.

---

## [1.26.5] — 2026-05-23

### Added — monitoring + email alert when calendar guests fail to attach

Calendar guests now work (v1.26.4), but the failure path is still silent: if
DWD ever gets revoked, the impersonate user loses access, or the Workspace
account is disabled, `createCalendarEvent` falls back to creating the event
**without guests** and only logs a `console.warn`. Operators wouldn't notice
until crew started missing invites. This change makes failures observable:

- New helper `notifyCalendarAlert` in `src/lib/google-calendar.ts` —
  fire-and-forget; never throws.
  - Writes an `AuditLog` row with `action = "calendar.invite_failed"` (insert
    fallback) or `"calendar.attendees_update_failed"` (patch failure), with
    full context: `eventId`, attendee list, error message, current
    `GOOGLE_IMPERSONATE_SUBJECT`.
  - Emails a human-readable alert to `CALENDAR_ALERT_EMAIL` (new optional env
    var); falls back to `GOOGLE_IMPERSONATE_SUBJECT` if unset. No-op when no
    email provider is configured.
- `createCalendarEvent` input now accepts an optional `bookingCode` so alerts
  show the readable booking code, not just the CUID.
- `updateCalendarEventAttendees(eventId, emails, meta?)` gained an optional
  `meta` arg `{ bookingId, bookingCode }` so failed patches alert with the
  same context.
- Callers (`/api/admin/[id]/approve`, `/api/admin/[id]/assign`) now pass
  `bookingCode` through.

No schema changes, no new packages. Alerts piggyback on the existing AuditLog
table (90-day retention) and `sendEmail` infra.

---

## [1.26.4] — 2026-05-23

### Fixed — calendar guests now work out of the box (impersonate subject defaulted in compose)

Approved bookings appeared on the shared calendar but the assigned crew were
never added as **guests**: `GOOGLE_IMPERSONATE_SUBJECT` (the Workspace user the
service account impersonates for Domain-Wide Delegation) was never reaching the
container, so `createCalendarEvent` / `updateCalendarEventAttendees` silently
skipped attendees. Confirmed with a live DWD probe — a bare service account hits
`403 forbiddenForServiceAccounts`, while impersonating `narasit.k@thestandard.co`
succeeds. So DWD was already granted in Workspace; only the env var was missing,
and the compose file sourced it from an easily-missed *stack-level* env var.

- `docker-compose.portainer.yml`: `GOOGLE_IMPERSONATE_SUBJECT` now **defaults to
  `narasit.k@thestandard.co`** (`${GOOGLE_IMPERSONATE_SUBJECT:-narasit.k@thestandard.co}`).
  Guests work after a redeploy with no stack env var needed; still overridable.
- Retroactively backfilled guests onto the 5 existing confirmed bookings that
  had assigned crew but no attendees (added silently — `sendUpdates:'none'` — so
  no invite blast).

No app code changed.

---

## [1.26.3] — 2026-05-22

### Added — Booking ID shown on the admin booking detail (all outlets)

The admin booking detail page now shows the **Booking ID** (`bookingCode` — the
Production ID for Content Agency, or the first Episode ID for other outlets)
as a badge under the title, so it's easy to reference when working with a
booking — regardless of outlet. `src/app/admin/[id]/page.tsx`.

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
