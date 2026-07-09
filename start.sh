#!/bin/sh
set -e

# ──────────────────────────────────────────────────────────────────────────────
# 0) Diagnostics — print the key env at boot. Shows up as the first lines of
#    `docker logs production-booking-app`.
# ──────────────────────────────────────────────────────────────────────────────
echo "=========================================="
echo "  Production Booking — startup diagnostics"
echo "=========================================="
echo "  NEXTAUTH_URL        = ${NEXTAUTH_URL:-(unset)}"
echo "  NEXT_PUBLIC_APP_URL = ${NEXT_PUBLIC_APP_URL:-(unset)}"
echo "  AUTH_DISABLED       = ${AUTH_DISABLED:-0}"
echo "  NODE_ENV            = ${NODE_ENV:-(unset)}"
echo "=========================================="
if [ "${AUTH_DISABLED:-0}" = "1" ]; then
  echo "  ⚠️  AUTH_DISABLED=1 — LOGIN BYPASSED, every request is ADMIN."
  echo "      For trusted LAN only. NEVER on a public deploy."
  echo "=========================================="
fi

# ──────────────────────────────────────────────────────────────────────────────
# 1) Wait for Postgres to accept connections
# ──────────────────────────────────────────────────────────────────────────────
if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: DATABASE_URL is not set"
  exit 1
fi

echo "==> Waiting for Postgres to accept connections..."
RETRIES=30
until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "FATAL: Postgres did not become ready in time"
    exit 1
  fi
  sleep 2
done
echo "    Postgres is ready"

# ──────────────────────────────────────────────────────────────────────────────
# 2) Defensive db-create — make the target database if it doesn't exist
#    Self-heals the case where the postgres volume was initialized with a
#    different POSTGRES_DB value than the app's DATABASE_URL expects.
# ──────────────────────────────────────────────────────────────────────────────
DB_NAME=$(echo "$DATABASE_URL" | sed -E 's|.*/([^?]+).*|\1|')
ADMIN_URL=$(echo "$DATABASE_URL" | sed -E 's|/[^/?]+(\?.*)?$|/postgres\1|')

if psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
  echo "==> Database '$DB_NAME' already exists"
else
  echo "==> Database '$DB_NAME' missing — creating it"
  psql "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\""
fi

# ──────────────────────────────────────────────────────────────────────────────
# 3) Sync schema + seed + boot
# ──────────────────────────────────────────────────────────────────────────────
# ──────────────────────────────────────────────────────────────────────────────
# Pre-migration: rename Category enum values in-place so `prisma db push`
# doesn't drop+recreate the column (which would erase data). Safe to re-run.
# ──────────────────────────────────────────────────────────────────────────────
echo "==> Renaming Category enum values (if old names exist)..."
psql "$DATABASE_URL" <<'SQL' || echo "Enum rename skipped (type missing or already renamed)"
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Category') THEN
    IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'RECURRING' AND enumtypid = '"Category"'::regtype) THEN
      ALTER TYPE "Category" RENAME VALUE 'RECURRING' TO 'ORIGINAL_CONTENT';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'AGENCY_JOB' AND enumtypid = '"Category"'::regtype) THEN
      ALTER TYPE "Category" RENAME VALUE 'AGENCY_JOB' TO 'ADVERTORIAL';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'SERVICE_JOB' AND enumtypid = '"Category"'::regtype) THEN
      ALTER TYPE "Category" RENAME VALUE 'SERVICE_JOB' TO 'EVENT';
    END IF;
  END IF;
END $$;
SQL

# ──────────────────────────────────────────────────────────────────────────────
# v1.35.0 — extend UploadStatus enum with the new dual-cloud states
# (DRIVE_OK, WASABI_OK, ORPHANED) BEFORE prisma db push, so Postgres
# doesn't recreate the type and orphan existing rows.
# Idempotent via IF NOT EXISTS guards.
# ──────────────────────────────────────────────────────────────────────────────
echo "==> Extending UploadStatus enum (v1.35.0 dual-cloud states)..."
psql "$DATABASE_URL" <<'SQL' || echo "UploadStatus extension skipped (type missing — fresh DB)"
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UploadStatus') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DRIVE_OK' AND enumtypid = '"UploadStatus"'::regtype) THEN
      ALTER TYPE "UploadStatus" ADD VALUE 'DRIVE_OK';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'WASABI_OK' AND enumtypid = '"UploadStatus"'::regtype) THEN
      ALTER TYPE "UploadStatus" ADD VALUE 'WASABI_OK';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ORPHANED' AND enumtypid = '"UploadStatus"'::regtype) THEN
      ALTER TYPE "UploadStatus" ADD VALUE 'ORPHANED';
    END IF;
  END IF;
END $$;
SQL

# ──────────────────────────────────────────────────────────────────────────────
# v1.33.0 — pre-push migration for OT signature workflow.
#
# Old enum: OTApprovalStatus { PENDING, APPROVED }
# New enum: OTApprovalStatus { DRAFT, SUBMITTED, APPROVED, REJECTED }
#
# Strategy: add new enum values first (committed in their own transaction so
# they're usable below), migrate PENDING rows to SUBMITTED, then let
# `prisma db push --accept-data-loss` drop the unused PENDING label.
# Idempotent — `IF NOT EXISTS` guards make re-runs no-ops.
# ──────────────────────────────────────────────────────────────────────────────
echo "==> Adding new OTApprovalStatus enum values (DRAFT, SUBMITTED, REJECTED)..."
psql "$DATABASE_URL" <<'SQL' || echo "OT enum extension skipped (type missing — fresh DB)"
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OTApprovalStatus') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DRAFT' AND enumtypid = '"OTApprovalStatus"'::regtype) THEN
      ALTER TYPE "OTApprovalStatus" ADD VALUE 'DRAFT';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'SUBMITTED' AND enumtypid = '"OTApprovalStatus"'::regtype) THEN
      ALTER TYPE "OTApprovalStatus" ADD VALUE 'SUBMITTED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'REJECTED' AND enumtypid = '"OTApprovalStatus"'::regtype) THEN
      ALTER TYPE "OTApprovalStatus" ADD VALUE 'REJECTED';
    END IF;
  END IF;
END $$;
SQL

echo "==> Migrating PENDING OT records to SUBMITTED (legacy status removal)..."
psql "$DATABASE_URL" <<'SQL' || echo "PENDING migration skipped (table missing or already migrated)"
DO $$
DECLARE
  migrated INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ot_records' AND column_name = 'approvalStatus'
  ) AND EXISTS (
    SELECT 1 FROM pg_enum WHERE enumlabel = 'PENDING' AND enumtypid = '"OTApprovalStatus"'::regtype
  ) THEN
    UPDATE ot_records SET "approvalStatus" = 'SUBMITTED' WHERE "approvalStatus" = 'PENDING';
    GET DIAGNOSTICS migrated = ROW_COUNT;
    RAISE NOTICE 'Migrated % PENDING OT record(s) to SUBMITTED', migrated;
  END IF;
END $$;
SQL

echo "==> Syncing database schema..."
npx prisma db push --accept-data-loss

# ──────────────────────────────────────────────────────────────────────────────
# Post-push: backfill booking_code for existing bookings created before the
# field was added. Sets booking_code = first episode's episode_id (matches the
# format used for new bookings). Idempotent — only fills NULL rows.
# ──────────────────────────────────────────────────────────────────────────────
echo "==> Backfilling Booking.bookingCode from first episode..."
psql "$DATABASE_URL" <<'SQL' || echo "Backfill skipped (table missing or already filled)"
DO $$
DECLARE
  filled INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'bookingCode'
  ) THEN
    UPDATE bookings b
       SET "bookingCode" = (
         SELECT e."episodeId" FROM episodes e
         WHERE e."bookingId" = b.id
         ORDER BY e.sequence ASC
         LIMIT 1
       )
     WHERE b."bookingCode" IS NULL;
    GET DIAGNOSTICS filled = ROW_COUNT;
    RAISE NOTICE 'Backfilled % booking(s) with bookingCode', filled;
  END IF;
END $$;
SQL

# ──────────────────────────────────────────────────────────────────────────────
# Post-push: purge audit_logs older than 90 days. Same query as
# /api/audit/purge — running on startup gives us a baseline tick even if no
# admin opens the dashboard.
# ──────────────────────────────────────────────────────────────────────────────
echo "==> Purging audit_logs older than 90 days..."
psql "$DATABASE_URL" -c "DELETE FROM audit_logs WHERE at < now() - INTERVAL '90 days'" \
  || echo "Audit purge skipped (table missing)"

# ──────────────────────────────────────────────────────────────────────────────
# v1.32.2 — one-time backfill of calendarSyncStatus for pre-existing
# CONFIRMED bookings. After this runs once, every CONFIRMED row has a
# value (OK if it has an event, FAILED if it doesn't), so the admin
# UI never shows a NULL "legacy" state. The WHERE NULL guard makes the
# UPDATE a no-op on subsequent restarts and on rows already touched by
# the reconciler.
# ──────────────────────────────────────────────────────────────────────────────
echo "==> Backfilling calendarSyncStatus for legacy CONFIRMED bookings..."
psql "$DATABASE_URL" <<'SQL' || echo "calendarSyncStatus backfill skipped (column missing — old image)"
DO $$
DECLARE
  filled_ok INT;
  filled_failed INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'calendarSyncStatus'
  ) THEN
    UPDATE bookings
       SET "calendarSyncStatus" = 'OK',
           "calendarLastSyncedAt" = NOW()
     WHERE status = 'CONFIRMED'
       AND "calendarEventId" IS NOT NULL
       AND "calendarSyncStatus" IS NULL;
    GET DIAGNOSTICS filled_ok = ROW_COUNT;

    UPDATE bookings
       SET "calendarSyncStatus" = 'FAILED',
           "calendarSyncError" = 'Backfilled at startup — CONFIRMED but no calendarEventId. Reconciler will retry.',
           "calendarLastSyncedAt" = NOW()
     WHERE status = 'CONFIRMED'
       AND "calendarEventId" IS NULL
       AND "calendarSyncStatus" IS NULL;
    GET DIAGNOSTICS filled_failed = ROW_COUNT;

    RAISE NOTICE 'calendarSyncStatus backfill: % rows OK, % rows FAILED', filled_ok, filled_failed;
  END IF;
END $$;
SQL

# ──────────────────────────────────────────────────────────────────────────────
# v1.33.6 — rename "MUA" → "Virtual Production" in legacy bookings'
# `crewRequired` String[] column. v1.33.5 already swapped the wizard option
# list (so new bookings can't add MUA anymore); this backfill cleans up
# rows that were created before the rename so the booking detail UI no
# longer shows both labels side-by-side.
#
# Idempotent: `array_replace` is a no-op when MUA isn't present, and the
# WHERE clause limits scanning to rows that actually contain MUA.
# ──────────────────────────────────────────────────────────────────────────────
echo "==> Renaming Booking.crewRequired MUA → Virtual Production..."
psql "$DATABASE_URL" <<'SQL' || echo "MUA rename skipped (table missing or already migrated)"
DO $$
DECLARE
  affected INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'crewRequired'
  ) THEN
    UPDATE bookings
       SET "crewRequired" = array_replace("crewRequired", 'MUA', 'Virtual Production')
     WHERE 'MUA' = ANY("crewRequired");
    GET DIAGNOSTICS affected = ROW_COUNT;
    RAISE NOTICE 'Backfilled % booking(s): crewRequired MUA -> Virtual Production', affected;
  END IF;
END $$;
SQL

# (v1.130 — the v1.35 boot seed that flipped AGN/TSS/NWS to
#  storagePolicy='DUAL_WRITE' was removed along with the Wasabi dual-write.
#  The column/enum stay in the schema as legacy; nothing reads or writes them.)

# ──────────────────────────────────────────────────────────────────────────────
# v1.131 — needsVan (Boolean) replaced by vanCount (Int, how many vans). The
# new column defaults to 0 for every row (old and new) once `prisma db push`
# above adds it — this backfill carries forward any pre-existing needsVan=true
# rows so they don't silently lose their van request.
#
# Idempotent: only touches rows still at the default vanCount=0, so re-running
# (or an admin later setting vanCount=0 on purpose) is never clobbered.
# ──────────────────────────────────────────────────────────────────────────────
echo "==> Backfilling Booking.vanCount from legacy needsVan..."
psql "$DATABASE_URL" <<'SQL' || echo "vanCount backfill skipped (column missing — old image)"
DO $$
DECLARE
  affected INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'vanCount'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'needsVan'
  ) THEN
    UPDATE bookings
       SET "vanCount" = 1
     WHERE "needsVan" = true
       AND "vanCount" = 0;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RAISE NOTICE 'Backfilled % booking(s): vanCount 0 -> 1 from legacy needsVan=true', affected;
  END IF;
END $$;
SQL

echo "==> Seeding database (idempotent)..."
npx tsx prisma/seed.ts || echo "Seed skipped or already done"

echo "==> Starting calendar guest reconcile worker (supervised)..."
# Wrap the worker in a tiny restart loop so a crash doesn't take it out for
# the rest of the container's lifetime. 5s back-off prevents a hot loop if
# the script throws immediately. Runs in the background so we can `exec npm
# start` next; the supervisor + worker tree gets reaped when the container
# stops (the worker also installs SIGTERM/SIGINT handlers for clean exit).
(
  while true; do
    node scripts/calendar-reconcile-worker.js
    echo "[calendar-reconcile] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

# v1.34.2 — footage sheet sync worker. Stays dormant when
# FOOTAGE_WORKER_ENABLED is unset/0; supervisor still re-launches so
# flipping the env var live in Portainer is enough to turn it on.
echo "==> Starting footage sheet sync worker (supervised)..."
(
  while true; do
    node scripts/footage-sheet-sync-worker.js
    echo "[footage-sync] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

# v1.62.0 — reminder engine worker. Stays dormant when REMINDERS_WORKER_ENABLED
# is unset/0; supervisor still re-launches so flipping the env var live in
# Portainer is enough to turn it on. Daily scan → Discord + email digest.
echo "==> Starting reminder worker (supervised)..."
(
  while true; do
    node scripts/reminders-worker.js
    echo "[reminders] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

# v1.77 — DB backup worker. Stays dormant when BACKUP_WORKER_ENABLED is unset/0;
# supervisor still re-launches so flipping the env var live is enough. Daily
# pg_dump → gzip → Google Drive (BACKUP_DRIVE_FOLDER_ID).
echo "==> Starting DB backup worker (supervised)..."
(
  while true; do
    node scripts/backup-worker.js
    echo "[backup] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

# v1.86 — prep-folders worker. ON BY DEFAULT (safe + idempotent: pre-creates the
# Drive boxes for today's shoots). Set PREP_FOLDERS_WORKER_ENABLED=0 to disable.
echo "==> Starting prep-folders worker (supervised)..."
(
  while true; do
    node scripts/prep-folders-worker.js
    echo "[prep-folders] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

# v1.108 — sound-merge worker. ON BY DEFAULT (idempotent + copy-only: folds staged
# audio into each booking's video box AUDIO). Set SOUND_MERGE_WORKER_ENABLED=0 to disable.
echo "==> Starting sound-merge worker (supervised)..."
(
  while true; do
    node scripts/sound-merge-worker.js
    echo "[sound-merge] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

# v1.127 — video-merge worker. ON BY DEFAULT (idempotent MOVE; re-runs only handle
# the remainder). With NAS_DSM_URL/USER/PASS set it fires the merge the moment the
# NAS Cloud Sync turns green (uptodate); without them it falls back to a plain
# hourly interval. Set VIDEO_MERGE_WORKER_ENABLED=0 to disable.
echo "==> Starting video-merge worker (supervised)..."
(
  while true; do
    node scripts/video-merge-worker.js
    echo "[video-merge] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

# v1.135 — _SHOOT marker reconcile worker. Stays dormant when
# SHOOT_MARKER_WORKER_ENABLED is unset/0; supervisor still re-launches so
# flipping the env var live in Portainer is enough. Enforces one _SHOOT marker
# per booking across AGN project boxes (trashes pre-migration box-level dupes so
# the footage crawler stops filing two cards per shoot — Neo memo 2026-07-09).
echo "==> Starting _SHOOT marker reconcile worker (supervised)..."
(
  while true; do
    node scripts/shoot-marker-worker.js
    echo "[shoot-marker] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

# v1.139 — landing drop-folder lifecycle worker. ON BY DEFAULT. Nightly (evening,
# LANDING_WORKER_HOUR default 19:00 BKK) it creates the NEXT day's shoot folders
# on the "Production Team" drop drive + trashes past-empty ones, keeping the drive
# lean (only upcoming + in-flight shoots). Policy: docs/landing-folder-policy.md.
# Set LANDING_WORKER_ENABLED=0 to disable.
echo "==> Starting landing drop-folder lifecycle worker (supervised)..."
(
  while true; do
    node scripts/landing-worker.js
    echo "[landing] supervisor: worker exited, restarting in 5s"
    sleep 5
  done
) &

echo "==> Starting Next.js..."
exec npm start
