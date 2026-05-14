#!/bin/sh
set -e

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
echo "==> Syncing database schema..."
npx prisma db push --accept-data-loss

echo "==> Seeding database (idempotent)..."
npx tsx prisma/seed.ts || echo "Seed skipped or already done"

echo "==> Starting Next.js..."
exec npm start
