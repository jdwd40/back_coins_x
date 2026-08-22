-- Crypto Chaos issue #19: profitable-only leaderboard qualification.
-- Production DDL source of truth for the leaderboard_eligible column.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- Canonical scoring rule: a completed-round result qualifies for the
-- leaderboard only when final_cash > starting_cash. starting_cash is the
-- AUTHORITATIVE per-round value persisted at participant creation (from
-- gameConstants.GAME_STARTING_CASH), so the threshold is configuration-
-- derived per row — never a scattered magic number, and pre-rule history
-- (starting_cash 1000.00 rows) gets identical threshold semantics without
-- rewriting a single historical value.
--
-- The column is GENERATED ALWAYS ... STORED: it can never drift from the
-- stored amounts, it backfills every existing row automatically, and the
-- Core 6 immutability triggers are untouched (generated columns are
-- computed at INSERT; no UPDATE ever happens on apocalypse_results).
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: one column is ADDED to apocalypse_results; no
--     row, column, constraint or trigger is dropped or rewritten. Stored
--     ranks (the 1..N finishing order across ALL participants) are
--     unchanged — leaderboard filtering/re-ranking happens at read time in
--     gameResultsService, keeping the immutable snapshot complete.
--   * If the column already exists, its shape is verified explicitly; an
--     incompatible pre-existing column aborts the migration with a clear
--     error instead of being silently accepted.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
BEGIN
  -- Precondition: the Core 6 results table exists with the columns the
  -- generated expression references.
  IF to_regclass('public.apocalypse_results') IS NULL THEN
    RAISE EXCEPTION 'migration 015: apocalypse_results does not exist. Apply migration 011 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'apocalypse_results' AND column_name = 'final_cash'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'apocalypse_results' AND column_name = 'starting_cash'
  ) THEN
    RAISE EXCEPTION 'migration 015: apocalypse_results lacks final_cash/starting_cash. Unexpected schema; aborting.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'apocalypse_results' AND column_name = 'leaderboard_eligible'
  ) THEN
    -- Re-run / partially-applied recovery: the column must be exactly the
    -- expected stored generated boolean, never some hand-made variant.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'apocalypse_results' AND column_name = 'leaderboard_eligible'
        AND data_type = 'boolean' AND is_generated = 'ALWAYS'
        AND generation_expression ILIKE '%final_cash > starting_cash%'
    ) THEN
      RAISE EXCEPTION 'migration 015: existing apocalypse_results.leaderboard_eligible column is INCOMPATIBLE (expected BOOLEAN GENERATED ALWAYS AS (final_cash > starting_cash) STORED). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    ALTER TABLE apocalypse_results
      ADD COLUMN leaderboard_eligible BOOLEAN
      GENERATED ALWAYS AS (final_cash > starting_cash) STORED;
  END IF;
END $$;
