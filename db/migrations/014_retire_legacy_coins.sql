-- ===========================================================================
-- Migration 014: retire legacy seed-only coins (Crypto Chaos catalogue trim).
--
-- Production carries three legacy seed-only coins beyond the canonical 10:
--
--   coin_id | name      | symbol
--   --------+-----------+--------
--        11 | HashAd    | HAD
--        12 | ChrisByte | CBT
--        13 | HodlWayne | HDW
--
-- These rows have real history (price_history, coin_collapse_schedule,
-- apocalypse_holdings, apocalypse_transactions, coin_statistics), so they
-- must NOT be deleted. Retirement is a soft flag:
--
--   * adds coins.retired BOOLEAN NOT NULL DEFAULT FALSE (schema);
--   * sets retired = TRUE on exactly the legacy identities above (data).
--
-- Retired coins are excluded from the player-facing catalogue, new-cycle
-- collapse schedules, bot market state and new buys — but every row and all
-- history is preserved, and detail/history endpoints still resolve them.
--
-- Safety contract (same shape rules as migrations 008-013):
--   * public.coins must exist with the coin_id column (verified, never
--     recreated blindly).
--   * If coins.retired already exists it must be boolean NOT NULL — an
--     incompatible pre-existing column aborts loudly.
--   * Each legacy id must hold EITHER its exact legacy identity (retire it)
--     OR no row at all (fresh/test databases never had these coins — skip).
--     An already-retired matching row is a verified no-op, so a lost
--     tracking row is safe. ANY other identity aborts loudly: the migration
--     never retires an ambiguous record.
--   * No historical row in any table is modified or deleted.
-- The whole batch runs inside a single transaction via db/migrate.js, so a
-- failure leaves the database unchanged.
-- ===========================================================================

DO $$
DECLARE
  m RECORD;
  cur RECORD;
BEGIN
  -- -- Table shape ----------------------------------------------------------
  IF to_regclass('public.coins') IS NULL THEN
    RAISE EXCEPTION 'migration 014: public.coins does not exist — the Coins schema is missing entirely';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coins'
      AND column_name = 'coin_id' AND data_type = 'integer'
  ) THEN
    RAISE EXCEPTION 'migration 014: coins.coin_id is missing or not integer — the table shape is INCOMPATIBLE';
  END IF;

  -- -- retired column: add, or verify a pre-existing one ---------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coins' AND column_name = 'retired'
  ) THEN
    ALTER TABLE coins ADD COLUMN retired BOOLEAN NOT NULL DEFAULT FALSE;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coins' AND column_name = 'retired'
      AND data_type = 'boolean' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'migration 014: coins.retired already exists with an INCOMPATIBLE shape — expected boolean NOT NULL';
  END IF;

  -- -- Deterministic soft-retire of the legacy seed-only coins ---------------
  FOR m IN
    SELECT * FROM (VALUES
      (11, 'HashAd',    'HAD'),
      (12, 'ChrisByte', 'CBT'),
      (13, 'HodlWayne', 'HDW')
    ) AS v(coin_id, legacy_name, legacy_symbol)
  LOOP
    SELECT name, symbol, retired INTO cur FROM coins WHERE coin_id = m.coin_id;

    IF NOT FOUND THEN
      -- Fresh/test databases never contained these seed-only rows: skip.
      CONTINUE;
    END IF;

    IF cur.name <> m.legacy_name OR cur.symbol <> m.legacy_symbol THEN
      RAISE EXCEPTION 'migration 014: coin_id % has an UNEXPECTED identity (name=%, symbol=%) — expected legacy %/%. Fix the row manually; the migration will not retire an unrecognised record.',
        m.coin_id, cur.name, cur.symbol, m.legacy_name, m.legacy_symbol;
    END IF;

    IF cur.retired THEN
      -- Already retired: applied state, verified no-op.
      CONTINUE;
    END IF;

    UPDATE coins SET retired = TRUE WHERE coin_id = m.coin_id;
  END LOOP;
END $$;
