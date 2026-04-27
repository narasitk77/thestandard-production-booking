#!/bin/sh
set -e

echo "==> Syncing database schema..."
npx prisma db push --accept-data-loss

echo "==> Seeding database (idempotent)..."
npx tsx prisma/seed.ts || echo "Seed skipped or already done"

echo "==> Starting Next.js..."
exec npm start
