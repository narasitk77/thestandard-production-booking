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
- **Noon prune** (v1.220, same worker, second timer): `LANDING_PRUNE_HOUR` (default
  12:00 BKK) calls `?prune=today`. It clears empty folders the nightly sweep
  refuses — ones whose Production ID no longer matches a Booking row, or whose
  shoot is still inside the grace window. On 2026-09-09 that was 14 folders the
  nightly had left behind, so it earns its slot. Both passes only ever trash
  EMPTY folders, so they cannot fight. Own heartbeat key `landing-prune` — never
  `landing`, so a healthy noon run cannot hide a dead evening sweep.
  This used to be a Hermes cron job on a laptop; prod rotated `NEXTAUTH_SECRET`
  on 2026-08-25, the laptop kept the old copy, and it 401'd for 13 runs before
  anyone noticed. In-container it resolves the secret from the same process env
  as the nightly, so it cannot drift.

### What neither pass can ever clean

A folder is **immortal** to both passes if it holds any real file, or if its name
has no trailing `(CODE)`. That is deliberate — but it means a single leftover file
pins a folder forever. The usual cause is not an unfinished upload: `video-merge`
leaves a landing file in place when the box already holds a twin with the same
name AND size (`mirrorMove` → `stats.dup++`, "already in box — leave in landing").
The folder is then non-empty forever and pressing 🎬 merge again is a no-op.
To tell the two apart: `GET /api/internal/video-merge/run?dryRun=1&code=<ID>` —
`moved=0` with `dup>0` means the landing copy is redundant and a human may trash
it; `moved>0` means there really is unmerged footage, so merge first.
Since v1.220 the prune reports these by NAME to Discord/Lark via
`notifyChat(…, 'footage')` instead of leaving them as a silent count.
- **Logic**: `src/lib/landing-lifecycle.ts` → `manageLandingFolders()`.
- **Endpoint**: `GET /api/internal/landing/manage` (ADMIN session or shared secret).
  - `?dryRun=1` (default) — plan only, no writes.
  - `?dryRun=0` — apply.
  - `?offset=N` — create for today+N days (default 1 = tomorrow).
  - `?keepDays=N` — override the grace window for this run.
  - `?report=1` — force the digest email even on a manual/dry run.

## "ขอเพิ่มพิเศษ" — creating a folder on demand

Default policy is next-day-only. When a specific shoot needs its drop folder
now — a big shoot the crew want to pre-stage, or a **past/completed** shoot whose
folder was already pruned but still needs a late upload — an admin runs, in a
logged-in `probook.xtec9.xyz` tab:

```js
// create the landing folder for ONE booking (works for past shoots too) — the preferred tool
await fetch('/api/internal/landing/manage?dryRun=0&create=TSS-KDM-260708-01', { credentials: 'include' }).then(r => r.json())
```

`?create=<Production ID>` is idempotent (reuses an existing folder) and is the
right tool for a single named job. To pre-stage a whole future **day** instead,
use the day-based offset (offset only reaches forward, never a past day):

```js
// create for ALL shoots N days ahead (e.g. 2 = the day after tomorrow)
await fetch('/api/internal/landing/manage?dryRun=0&offset=2', { credentials: 'include' }).then(r => r.json())
```

## Env knobs (Portainer stack 125)

| Var | Default | Meaning |
|---|---|---|
| `LANDING_WORKER_ENABLED` | `1` | on/off |
| `LANDING_WORKER_HOUR` | `19` | nightly run hour, BKK |
| `LANDING_KEEP_PAST_DAYS` | `3` | upload-grace days before an empty past folder is cleaned — **prod runs `1`**; the `3` here is only the compose default, and a compose default is not the stack value |
| `LANDING_PRUNE_ENABLED` | `1` | on/off for the noon prune (v1.220) |
| `LANDING_PRUNE_HOUR` | `12` | noon prune hour, BKK |
| `LANDING_REPORT_EMAIL` | `FEEDBACK_EMAIL` | nightly digest recipient |

## Related

- `src/lib/prep-folders.ts` — still pre-creates the VIDEO 2026 **box** folders for
  today's shoots (camera slots); it no longer touches the landing drive.
- `src/lib/landing-dedup.ts` — keeps one landing folder per Production ID (guards
  against a concurrent double-create).
- `src/lib/video-merge.ts` — `VIDEO_MERGE_TRASH_LANDING` (default off) — legacy
  immediate cleanup, superseded by this lifecycle.
