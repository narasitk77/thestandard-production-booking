# Runbook — database backup + restore

> **Status (v1.177):** the automated backup **exists in the app** — it was
> written in v1.77 and this document said otherwise for a year. Whether it is
> *running* is an env question, answered below, not by this file.

## The automated backup

`src/lib/backup.ts`, poked daily by `scripts/backup-worker.js` via
`POST /api/internal/backup/run`. It runs inside the **app** container because
that is where `DATABASE_URL`, the Drive service-account credentials and
`pg_dump` (from the image's `postgresql-client`) all live together.

What one run does:

1. `pg_dump --no-owner --no-privileges` streamed straight into gzip in-process
   (never lands on disk)
2. upload to Drive as `backup-YYYY-MM-DDTHHMM.sql.gz` (UTC, colon-free)
3. best-effort prune of anything in that folder older than the retention window

| Env | Default | Meaning |
|---|---|---|
| `BACKUP_WORKER_ENABLED` | `0` — **dormant** | must be `1` for any backup to happen |
| `BACKUP_DRIVE_FOLDER_ID` | *(unset)* | Drive folder to upload into — the service account needs edit access. Unset = the run throws |
| `BACKUP_INTERVAL_MS` | `86400000` (24 h) | how often the worker pokes |
| `BACKUP_RETENTION_DAYS` | `30` | older files in that folder are trashed |
| `BACKUP_SECRET` | falls back to `NEXTAUTH_SECRET` | worker → app auth |

### Is it actually on right now?

**Read the stack env, not the compose default.** `${BACKUP_WORKER_ENABLED:-0}`
tells you nothing about the running value — that mistake has cost a day twice.
Two reliable checks:

- `GET /api/health-summary` → the `backup` entry. `enabled: false` means off;
  `enabled: true` with a stale/never `lastTickAgoSec` means on but not working.
- The Drive folder itself: a file dated today is the only proof that matters.

The dead-man check alerts if the worker is enabled and stops ticking (24 h
interval + 2 h grace).

### The backup worker must stay with the app

Unlike the other 11 workers, this one is **not** a thin HTTP scheduler on the
app's behalf — the endpoint it calls needs the database and `pg_dump`. When
workers are split into their own container (`APP_ROLE=worker`), leave
`BACKUP_WORKER_ENABLED=0` there and keep it on the web role.

## What we need to back up

- **`production-booking-db` Postgres** (volume `production-booking-postgres-data`).
  Includes the `bookings`, `episodes`, `outlets`, `programs`, `users`,
  `team_members`, `ot_records`, `audit_logs`, `uploads` tables. Loss =
  catastrophic; this is the system of record.
- **`/app/uploads` volume** in the app container — user-uploaded files
  (currently unused by booking flow but may be in the future).

What we DON'T need to back up (regenerated from elsewhere):

- Container image — pinned by sha tag in Portainer, pull from GHCR.
- Source code — in GitHub `narasitk77/thestandard-production-booking`.
- Google Sheets / Calendar — Google's own backups + version history.

## Backup target

**Recommended:** off-host storage (NAS, S3, Google Drive, or external
disk). Backups on the same machine = no protection from drive failure.

Options ranked:

1. **Cyberduck → S3 (or compatible)** — simple, encrypted, off-site.
2. **rclone → Google Drive** — already in the Workspace ecosystem.
3. **External USB drive rotated weekly** — air-gapped, cheap, slow recovery.

## Backup procedure (manual — the fallback, and what to run if the worker is off)

Run from the Docker host:

```sh
# Dump as a single SQL file (gzipped). Replace credentials from
# the Portainer stack env (POSTGRES_PASSWORD).
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
docker exec production-booking-db \
  pg_dump -U postgres -d production_booking --no-owner \
  | gzip > "production_booking_${TIMESTAMP}.sql.gz"

# Then transfer off-host. Example with rclone:
rclone copy "production_booking_${TIMESTAMP}.sql.gz" gdrive:probook-backups/

# Optional: also dump uploads volume
docker run --rm \
  -v production-booking_uploads:/data \
  -v "$(pwd):/backup" \
  alpine tar czf "/backup/uploads_${TIMESTAMP}.tar.gz" -C /data .
```

## Restore procedure

**⚠ Restoring overwrites the live DB. Always do this on a fresh
container or with the app stopped.**

```sh
# 1. Stop the app container (keeps the DB up so we can write to it)
docker stop production-booking-app

# 2. (Optional) snapshot the current DB before restoring, in case the
#    backup itself is corrupt
docker exec production-booking-db \
  pg_dump -U postgres -d production_booking --no-owner \
  > "before_restore_$(date +%Y%m%d_%H%M%S).sql"

# 3. Drop + recreate the database
docker exec -i production-booking-db psql -U postgres -c \
  "DROP DATABASE IF EXISTS production_booking;"
docker exec -i production-booking-db psql -U postgres -c \
  "CREATE DATABASE production_booking;"

# 4. Restore from the backup (assuming .sql.gz)
gunzip -c production_booking_20260524_030000.sql.gz \
  | docker exec -i production-booking-db psql -U postgres -d production_booking

# 5. Restart the app — start.sh will run prisma db push (idempotent)
#    and the audit purge as usual
docker start production-booking-app

# 6. Smoke test via /admin/health — DB check should be green
```

## Verifying a backup actually works

Quarterly drill:

1. Spin up a throwaway Postgres + restore latest backup
2. `psql` count of bookings + episodes — should match expectation
3. Spot-check the most recent 5 bookings have intact relationships
   (outlet, program, episodes)

If you don't drill, you don't have a backup — you have a hope.

## Retention

- Daily backups kept for **14 days**
- Weekly backups (every Sunday) kept for **3 months**
- Monthly backups (1st of month) kept for **2 years**

Off-host storage costs are negligible at this scale (<100 MB per dump
even with audit_logs).

## Action items

Done in v1.77 (see "The automated backup" above): the dump job, the off-host
target (Google Drive), the retention policy, and the missed-backup alert
(the worker dead-man check).

Still open:

- [ ] Turn it on where it is meant to be on — set `BACKUP_WORKER_ENABLED=1`
      and `BACKUP_DRIVE_FOLDER_ID` on the stack, then confirm a file lands
- [ ] Test the restore procedure end-to-end once against a real dump
- [ ] Run the quarterly verification drill above at least once, and write the
      date here when you do

> Retention in the section above (14 days / 3 months / 2 years) is the agreed
> *strategy*. What the code implements today is one flat window,
> `BACKUP_RETENTION_DAYS` (default 30). Tiering it would mean teaching `prune()`
> to keep Sundays and 1st-of-months — not done.

## In an actual emergency

If the DB is corrupted / dropped and you have no backup:

1. **Don't panic, don't run `prisma migrate reset`**.
2. The Producer Dashboard sheet has CA bookings in its `Bookings` tab —
   row order matches insertion order. Last-resort recovery: replay
   `Bookings` rows back into the DB via a one-off script.
3. Non-CA bookings only exist in the DB + Google Calendar (event
   description has all the fields). Can scrape Google Calendar events
   for the relevant period via the API.
4. `audit_logs` (if intact) has the full history of changes — useful
   for reconstructing edits.

This is the kind of pain backups exist to prevent. Set them up.
