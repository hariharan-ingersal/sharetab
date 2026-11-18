-- Migration: add Settlement."requestKey" (the attempt key that stops a retried or double-clicked
-- payment from being recorded twice) and its unique index.
-- Run this BEFORE prisma db push: on a database that already has payments, prisma db push refuses
-- to add a unique constraint without --accept-data-loss, which docker/entrypoint.sh doesn't pass.
-- Once this has run, the column and index match the schema and prisma db push has nothing to add.
-- The new column is NULL for every existing payment, so no existing data changes.
-- Idempotent: safe to re-run
-- Must also be safe on an empty database: docker/entrypoint.sh runs it before
-- prisma db push on every start, including a fresh install's first one

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'Settlement'
  ) THEN
    ALTER TABLE "Settlement" ADD COLUMN IF NOT EXISTS "requestKey" TEXT;
    -- The name prisma db push gives the index for @unique, so it sees the index as its own
    CREATE UNIQUE INDEX IF NOT EXISTS "Settlement_requestKey_key" ON "Settlement"("requestKey");
  END IF;
END $$;
