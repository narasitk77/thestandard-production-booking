# Landing drop-folder policy — "Production Team" drive

_v1.139 · 2026-07-09 · owner: Production Booking_

The **"Production Team"** Shared Drive (`0AGendsFHFQYKUk9PVA`, env
`DRIVE_PRODUCTION_TEAM_ROOT`) is the **landing / drop zone**: one flat folder per
shoot — `<show · job> (<Production ID>)` — where the NAS Cloud Sync and crew drop
footage. `video-merge` later MOVEs that footage into the VIDEO 2026 box tree.

This drive must stay **lean** — crew need to find *their* shoot fast, so it should
only ever show shoots that are relevant right now, not a folder for every past job.

## The rule

| | |
|---|---|
| **Create** | Only for the **NEXT day's** shoots, the **evening before** (default 19:00 BKK). Never pre-create further ahead — a booking confirmed weeks out gets **no** landing folder until the night before its shoot. |
| **Keep** | Through the shoot day + an **upload-grace window** (`LANDING_KEEP_PAST_DAYS`, default **3** days). A folder that still holds real footage is **always** kept, regardless of age. |
| **Remove** | Once a shoot is **older than the grace window** AND its folder is **empty** (footage delivered to the box). Only empty, regenerable folders are trashed — to Shared-Drive trash (recoverable ~30 days). |

`video-merge` no longer trashes a landing folder when it moves footage (that made
drop targets vanish mid-shoot — 2026-07-09 incident); removal is owned solely by
this nightly lifecycle, which is time-based (past + empty), so an active shoot's
folder never disappears out from under crew.

## How it runs

- **Worker**: `scripts/landing-worker.js` (supervised, ON by default), nightly at
  `LANDING_WORKER_HOUR` (default 19:00 BKK). Emails a digest to
  `LANDING_REPORT_EMAIL` (default `FEEDBACK_EMAIL`) on any night it changes something.
- **Logic**: `src/lib/landing-lifecycle.ts` → `manageLandingFolders()`.
- **Endpoint**: `GET /api/internal/landing/manage` (ADMIN session or shared secret).
  - `?dryRun=1` (default) — plan only, no writes.
  - `?dryRun=0` — apply.
  - `?offset=N` — create for today+N days (default 1 = tomorrow).
  - `?keepDays=N` — override the grace window for this run.
  - `?report=1` — force the digest email even on a manual/dry run.

## "ขอเพิ่มพิเศษ" — pre-creating a folder early

Default policy is next-day-only. To make a folder now for a shoot further out
(e.g. a big shoot the crew want to pre-stage), an admin runs, in a logged-in
`probook.xtec9.xyz` tab:

```js
// create for shoots N days ahead (e.g. 2 = the day after tomorrow)
await fetch('/api/internal/landing/manage?dryRun=0&offset=2', { credentials: 'include' }).then(r => r.json())
```

## Env knobs (Portainer stack 125)

| Var | Default | Meaning |
|---|---|---|
| `LANDING_WORKER_ENABLED` | `1` | on/off |
| `LANDING_WORKER_HOUR` | `19` | nightly run hour, BKK |
| `LANDING_KEEP_PAST_DAYS` | `3` | upload-grace days before an empty past folder is cleaned |
| `LANDING_REPORT_EMAIL` | `FEEDBACK_EMAIL` | nightly digest recipient |

## Related

- `src/lib/prep-folders.ts` — still pre-creates the VIDEO 2026 **box** folders for
  today's shoots (camera slots); it no longer touches the landing drive.
- `src/lib/landing-dedup.ts` — keeps one landing folder per Production ID (guards
  against a concurrent double-create).
- `src/lib/video-merge.ts` — `VIDEO_MERGE_TRASH_LANDING` (default off) — legacy
  immediate cleanup, superseded by this lifecycle.
