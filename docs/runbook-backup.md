# Runbook — database backup + restore

> **⚠ Status:** This document is the **plan**, not the implemented
> reality. As of v1.31 there is no automated backup running. Treat
> everything below as the agreed strategy; section "Action items" at
> the bottom lists what needs to be set up to actually have backups.

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

## Backup procedure (manual — until automated)

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

## Action items (to actually have backups in place)

- [ ] Choose backup target (S3 / GDrive / external disk)
- [ ] Set up credentials on the Portainer host
- [ ] Cron the dump command + retention policy
- [ ] Test the restore procedure end-to-end once
- [ ] Document the credentials location in this file (or in 1Password)
- [ ] Set up a monitoring alert if a backup is missed (e.g. dead-man's
      switch via cron-job.org or healthchecks.io)

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
