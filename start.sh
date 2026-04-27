#!/bin/sh
set -e

echo "==> Syncing database schema..."
node_modules/.bin/prisma db push --accept-data-loss

echo "==> Seeding database (idempotent)..."
node_modules/.bin/tsx prisma/seed.ts || echo "Seed skipped or already done"

echo "==> Starting Next.js server..."
exec node server.js
