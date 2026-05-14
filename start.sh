#!/bin/sh
set -e

# ──────────────────────────────────────────────────────────────────────────────
# 0) Diagnostics — print the auth-relevant env so you don't need to exec into
#    the container to debug OAuth callback issues. These show up as the very
#    first lines of `docker logs production-booking-app`.
# ──────────────────────────────────────────────────────────────────────────────
echo "=========================================="
echo "  Production Booking — startup diagnostics"
echo "=========================================="
echo "  NEXTAUTH_URL        = ${NEXTAUTH_URL:-(unset)}"
echo "  NEXT_PUBLIC_APP_URL = ${NEXT_PUBLIC_APP_URL:-(unset)}"
echo "  NODE_ENV            = ${NODE_ENV:-(unset)}"
echo "=========================================="

# Catch the most common deployment footgun: NEXTAUTH_URL set to https:// when
# the container only listens on plain HTTP. Google will redirect the browser
# to https://… which the browser can't reach → "loading forever" after Allow.
case "$NEXTAUTH_URL" in
  https://*)
    echo ""
    echo "  ⚠  WARNING: NEXTAUTH_URL starts with https:// but this container"
    echo "     serves plain HTTP on port 3000. After Google OAuth consent,"
    echo "     the browser will be redirected to an https:// callback URL"
    echo "     that this app cannot answer — sign-in will hang."
    echo ""
    echo "     Fix in Portainer → Stack → Environment variables:"
    echo "       NEXTAUTH_URL=http://...   (remove the 's')"
    echo "       NEXT_PUBLIC_APP_URL=http://...   (same)"
    echo "     Then Update the stack to apply."
    echo "=========================================="
    ;;
esac

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
