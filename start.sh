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

# Auto-fix the most common deployment footgun: NEXTAUTH_URL set to https://
# when the container only listens on plain HTTP. Without this, Google would
# redirect the browser to an https:// callback URL the app can't answer, and
# sign-in hangs forever. Set DISABLE_HTTPS_AUTOFIX=1 to opt out (e.g. when
# you've put a real TLS-terminating reverse proxy in front of the container).
if [ "${DISABLE_HTTPS_AUTOFIX:-0}" != "1" ]; then
  case "$NEXTAUTH_URL" in
    https://*)
      FIXED_URL=$(echo "$NEXTAUTH_URL" | sed 's|^https://|http://|')
      echo ""
      echo "  ⚠  AUTO-FIX: NEXTAUTH_URL was https:// — rewriting to http://"
      echo "     ($NEXTAUTH_URL → $FIXED_URL)"
      echo "     This container serves plain HTTP on port 3000. To disable"
      echo "     this auto-fix (e.g. after adding a TLS proxy), set"
      echo "     DISABLE_HTTPS_AUTOFIX=1 in the stack env."
      export NEXTAUTH_URL="$FIXED_URL"
      ;;
  esac
  case "$NEXT_PUBLIC_APP_URL" in
    https://*)
      export NEXT_PUBLIC_APP_URL=$(echo "$NEXT_PUBLIC_APP_URL" | sed 's|^https://|http://|')
      echo "  ⚠  AUTO-FIX: NEXT_PUBLIC_APP_URL → $NEXT_PUBLIC_APP_URL"
      ;;
  esac
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
echo "==> Syncing database schema..."
npx prisma db push --accept-data-loss

echo "==> Seeding database (idempotent)..."
npx tsx prisma/seed.ts || echo "Seed skipped or already done"

echo "==> Starting Next.js..."
exec npm start
