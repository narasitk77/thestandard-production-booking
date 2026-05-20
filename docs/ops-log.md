# Operations Log — Production Booking

A running journal of infrastructure events, fixes, and operator actions on
the self-hosted Portainer deployment at `probook.xtec9.xyz`. Newest first.

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
