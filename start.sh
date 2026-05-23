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

echo "==> Starting Next.js..."
exec npm start
