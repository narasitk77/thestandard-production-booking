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
logged-in `probook.thestandard.co` tab:

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

## Multi-day bookings — one folder per day (v1.280)

A booking whose shoot spans several days but is filed under **one EP** used to get
every day's cards in the same `EP/CAM-X`. `video-merge` dedups by name+size per
folder, so day 2's card-index files (`MEDIAPRO.XML`, `CUEUP.XML`, `DISCMETA.XML`,
`SONY/SONYCARD.IND`, `DATABASE.BIN`) either landed beside day 1's (two
`MEDIAPRO.XML` in one `XDROOT`) or were judged "dup" and stranded in landing forever
(AGN-261104-01, 4–6 Nov 2026).

**Layout** — only for such bookings; every single-day booking is unchanged:

```
<box or landing>/<EP>/CAM-A/D1-261104/<card>
                          /D2-261105/<card>
                          /D3-261106/<card>
                 /<EP>/AUDIO/D1-261104 …
```

- **Name**: `D<n>-<yymmdd>` — `n` counts from `shootDate` (2-digit, `D01`, once
  the shoot is 10+ days), `yymmdd` is that day's Gregorian date (never Buddhist).
  Logic: `shootDayFolders()` in `src/lib/outlet-folders.ts`.
- **Where**: under every slot the booking pre-creates (`CAM-A…` from cameraCount,
  `AUDIO` when it has mics), in **every** EP folder.
- **When**: once, when the landing folder is created — the 19:00 sweep and
  `?create=` / approve-time (`ensureLandingForBooking`; approve waits for its box
  pre-create first, `ensureLandingAfterBox`). First a **read-only plan**
  (`planDayFolders`: the reschedule guard, then box link / liveness / every EP in
  the box) — it runs identically in dryRun and in the real run, before anything is
  created, so a dryRun answers exactly what the run will do (same `dayFolders`,
  same `warnings`; the sweep's dryRun prints "+ โฟลเดอร์วัน …" only when they will
  be made, and the same `WARN day folders` line). Then the landing exactly as
  before (camera slots + the stored landing link), so the day layer can never cost
  the crew a drop slot. Then the day layer, **box first, then landing**: the box
  `CAM-X` holding empty `D<n>` is not empty, so `video-merge` walks into it and
  moves each FILLED landing `D<n>` into its own empty box twin, while the empty
  landing `D<n>` stay put as tomorrow's drop target.
- **Box first or nothing**: when the box half does not fully succeed — no box
  linked (`driveFolders.box`), box trashed, Drive could not answer ("ตรวจกล่องไม่ได้
  (Drive)"), an EP missing in the box (then nothing is created in the box either),
  or any Drive error — the landing gets **no** day folders (the old layout) and it
  is loud: the 19:00 sweep counts `WARN day folders …` in `createErrors` (digest
  email); `ensureLandingForBooking` returns `warnings`, and approve sends them to
  ops (`alertOps` key `landing-day-folders:<code>`). A failure in the landing day
  pass itself is reported the same way; the camera slots are already there.
  When the delivered-check cannot read Drive, `ensureLandingForBooking` still makes
  the landing but with no day folders (a `D<n>` may already be in the box) and a
  warning.
  folder-integrity, prep-folders and the hourly paths never create day folders:
  a `D<n>` already merged into the box must not reappear in landing.
- **No day folders** (today's layout) when: no end date · end ≤ start · more than
  14 days · a 2-day booking that is one overnight session (wrap earlier than call)
  · the booking already has one EP per day (EP count ≥ days).
- **Kill switch**: `LANDING_DAY_FOLDERS=0` on the stack (app container) turns all
  of the above off. Default on.
- **Rescheduled after the landing folder exists**: the plan finds the existing
  landing (by Production ID → first EP → first camera slot, read-only) and lists
  that slot. If it already holds a
  `D<n>-<yymmdd>` folder that is not in the new set, it creates no day folders for
  that booking — neither box nor landing — and warns (`WARN day folders …` /
  `warnings`) asking for a manual rename. Nothing renames them for you: rename the
  existing `D<n>` in every camera slot, landing and box, to the new dates. The same
  set already there (the next night's re-run) is not a reschedule.

**Crew rule: 1 card = 1 new folder.** Copy each card, whole, into its day folder.
A second card of the same camera on the same day goes into a NEW folder of its
own (e.g. `D2-261105-2`) — never pour a card into a folder that already holds one.
The SAME card offloaded a second time on the same day (lunch dump, then the whole
card at wrap) after the hourly merge already moved that day folder into the box:
re-create the day folder in landing with the **same name** (`D2-261105`) and copy
the card into it — the box twin exists, so the merge compares `MEDIAPRO.XML`,
sees the same card, and fills in only what is new.

**The hold** (all bookings, `video-merge`), decided at the **card root** — a
landing folder holding `XDROOT`, `M4ROOT` or `PRIVATE/M4ROOT` — before any part of
it moves. When that index folder and its box twin (same names under the box twin
of the card root) BOTH hold `MEDIAPRO.XML`, both are downloaded and parsed (a few
KB; the same reads in dryRun and real runs). At least one clip in common — the
same `umid` when both sides carry one, otherwise the same `uri` AND `dur` — means
the SAME card offloaded again (lunch dump then the whole card at wrap, or only the
new clips plus a grown `MEDIAPRO.XML` that still lists the old ones): it merges
exactly as before v1.280. No clip in common means a DIFFERENT card poured onto an
existing one: none of its parts move — `XDROOT`, `M4ROOT`, `PRIVATE`, `SONY`,
`DCIM`, `AVF_INFO`, `MISC` and any loose non-junk file at the card root — and it
is reported by its card root, e.g. `AGN-261104-01: EP01 · x/CAM-A`. Other
children of that folder (a correct `D2-<yymmdd>` or `Card 2` folder beside a
flat-dumped card) and sibling cameras keep merging. A `MEDIAPRO.XML` that cannot
be downloaded or parsed keeps that card in landing for the run and counts as an
**error** (never a guessed hold). A 0-byte `MEDIAPRO.XML` (interrupted copy) counts
as no index on that side. Kill switch: `CARD_HOLD=0` (app service) = merge exactly
as before v1.280, no redeploy needed.
Reported in: `cardHolds` in the result, one ops alert per run keyed by the held
set (ops repeats every 6 h), the 🎬 team notify (only when the held SET is new —
fingerprint `card-hold-set` in `system_heartbeats`, like the sync-storm set; a
booking's merge button keeps its own `card-hold-set:<code>`), the merge buttons
and the worker log. Every hold text gives the evidence ("MEDIAPRO
ไม่มีคลิปร่วมกับการ์ดในกล่อง").
Fix: move the **whole card** — `XDROOT`/`M4ROOT` together with its `SONY`/`PRIVATE`
siblings — into a new folder of its own (e.g. `D2-<yymmdd>` or `Card 2`); the next
merge takes it. **Do not delete either index file** — footage-integrity says the
same when it finds two in one box folder, without claiming a cause ("ไฟล์ index
ชื่อเดียวกันขนาดต่างกัน — อาจเป็นการ์ดคนละใบ หรือการ์ดเดิมที่ก็อปซ้ำหลังถ่ายต่อ ·
ห้ามลบไฟล์ index" when their sizes differ — a same-card re-offload merges its
grown index beside the old one, as it always did; "อาจเป็นการ์ดคนละใบหรืออัปซ้ำ
ห้ามลบจนกว่าจะเทียบ md5" when they match).
Known ceiling: when only one side has `MEDIAPRO.XML` (or neither — a non-Sony
card, an index still uploading, a card dumped without its `XDROOT` folder) there
is nothing to compare and it merges as before v1.280.

**Empty means the same everywhere**: a landing folder holding only `.DS_Store` /
`Thumbs.db` / `desktop.ini` (someone opened an unused slot in Finder) is empty for
`video-merge` (not moved) and for the 19:00 sweep and noon prune (trashable).

## Env knobs (Portainer stack 125)

| Var | Default | Meaning |
|---|---|---|
| `LANDING_WORKER_ENABLED` | `1` | on/off |
| `LANDING_WORKER_HOUR` | `19` | nightly run hour, BKK |
| `LANDING_KEEP_PAST_DAYS` | `3` | upload-grace days before an empty past folder is cleaned — **prod runs `1`**; the `3` here is only the compose default, and a compose default is not the stack value |
| `LANDING_PRUNE_ENABLED` | `1` | on/off for the noon prune (v1.220) |
| `LANDING_PRUNE_HOUR` | `12` | noon prune hour, BKK |
| `LANDING_REPORT_EMAIL` | `FEEDBACK_EMAIL` | nightly digest recipient |
| `LANDING_DAY_FOLDERS` | `1` | `0` = no per-day folders for multi-day bookings (v1.280) |

## Related

- `src/lib/prep-folders.ts` — still pre-creates the VIDEO 2026 **box** folders for
  today's shoots (camera slots); it no longer touches the landing drive.
- `src/lib/landing-dedup.ts` — keeps one landing folder per Production ID (guards
  against a concurrent double-create).
- `src/lib/video-merge.ts` — `VIDEO_MERGE_TRASH_LANDING` (default off) — legacy
  immediate cleanup, superseded by this lifecycle.
