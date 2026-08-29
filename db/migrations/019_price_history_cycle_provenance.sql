-- Apocalypse Monitor persistence foundation: price_history provenance.
-- Production DDL source of truth for nullable price_history.cycle_id /
-- price_history.source and the (cycle_id, coin_id, created_at) index.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- What this adds:
--   * price_history.cycle_id INTEGER NULL + FK to apocalypse_cycles(cycle_id):
--     the authoritative apocalypse cycle the price row was written under.
--     Nullable forever: legacy pre-monitor rows keep NULL and are never
--     backfilled (no cycle or timestamp inference is attempted).
--   * price_history.source VARCHAR(12) NULL + CHECK: exactly 'MARKET_TICK'
--     (normal writer) or 'COLLAPSE' (scheduled-collapse writer); NULL for
--     legacy rows. The CHECK admits NULL by the usual SQL rule.
--   * idx_price_history_cycle_coin_created on (cycle_id, coin_id, created_at)
--     for the monitor's per-cycle history reads.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive and additive: only ADDs nullable columns, one
--     FK, one CHECK and one index. No existing row is rewritten.
--   * Every pre-existing object's shape is verified explicitly; an
--     incompatible same-named column/constraint/index aborts with a clear
--     error instead of being silently altered.
--   * If an object already exists with the expected shape (partial retry
--     after manual repair) it is left untouched, so a rerun converges.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
DECLARE
  col record;
  fkdef text;
BEGIN
  IF to_regclass('public.price_history') IS NULL THEN
    RAISE EXCEPTION 'migration 019: required table public.price_history does not exist. Apply earlier migrations first.';
  END IF;
  IF to_regclass('public.apocalypse_cycles') IS NULL THEN
    RAISE EXCEPTION 'migration 019: required table public.apocalypse_cycles does not exist. Apply earlier migrations first.';
  END IF;

  -- cycle_id --------------------------------------------------------------
  SELECT c.data_type, c.is_nullable
    INTO col
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'price_history'
     AND c.column_name = 'cycle_id';
  IF FOUND THEN
    IF col.data_type <> 'integer' OR col.is_nullable <> 'YES' THEN
      RAISE EXCEPTION 'migration 019: existing column price_history.cycle_id has an incompatible shape (type=%, nullable=%). Expected integer NULL. Fix it manually; the migration will not modify it.', col.data_type, col.is_nullable;
    END IF;
  ELSE
    ALTER TABLE price_history ADD COLUMN cycle_id INTEGER;
  END IF;

  -- FK to apocalypse_cycles ----------------------------------------------
  SELECT pg_get_constraintdef(oid) INTO fkdef
    FROM pg_constraint
   WHERE conrelid = 'public.price_history'::regclass
     AND contype = 'f'
     AND conname = 'price_history_cycle_id_fkey';
  IF fkdef IS NOT NULL THEN
    IF fkdef <> 'FOREIGN KEY (cycle_id) REFERENCES apocalypse_cycles(cycle_id)' THEN
      RAISE EXCEPTION 'migration 019: existing constraint price_history_cycle_id_fkey has an incompatible definition (%). Expected FOREIGN KEY (cycle_id) REFERENCES apocalypse_cycles(cycle_id). Fix it manually; the migration will not modify it.', fkdef;
    END IF;
  ELSE
    ALTER TABLE price_history
      ADD CONSTRAINT price_history_cycle_id_fkey
      FOREIGN KEY (cycle_id) REFERENCES apocalypse_cycles(cycle_id);
  END IF;

  -- source ----------------------------------------------------------------
  SELECT c.data_type, c.is_nullable, c.character_maximum_length
    INTO col
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'price_history'
     AND c.column_name = 'source';
  IF FOUND THEN
    IF col.data_type <> 'character varying' OR col.is_nullable <> 'YES'
       OR col.character_maximum_length < 11 THEN
      RAISE EXCEPTION 'migration 019: existing column price_history.source has an incompatible shape (type=%(%), nullable=%). Expected varchar NULL with room for MARKET_TICK. Fix it manually; the migration will not modify it.', col.data_type, col.character_maximum_length, col.is_nullable;
    END IF;
  ELSE
    ALTER TABLE price_history ADD COLUMN source VARCHAR(12);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.price_history'::regclass
      AND contype = 'c'
      AND conname = 'price_history_source_allowed'
  ) THEN
    ALTER TABLE price_history
      ADD CONSTRAINT price_history_source_allowed
      CHECK (source IN ('MARKET_TICK', 'COLLAPSE'));
  ELSE
    SELECT pg_get_constraintdef(oid) INTO fkdef
      FROM pg_constraint
     WHERE conrelid = 'public.price_history'::regclass
       AND contype = 'c'
       AND conname = 'price_history_source_allowed';
    IF fkdef NOT LIKE '%MARKET_TICK%' OR fkdef NOT LIKE '%COLLAPSE%' THEN
      RAISE EXCEPTION 'migration 019: existing constraint price_history_source_allowed has an incompatible definition (%). Expected CHECK (source IN (''MARKET_TICK'', ''COLLAPSE'')). Fix it manually; the migration will not modify it.', fkdef;
    END IF;
  END IF;

  -- (cycle_id, coin_id, created_at) index ---------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'price_history'
      AND indexname = 'idx_price_history_cycle_coin_created'
  ) THEN
    CREATE INDEX idx_price_history_cycle_coin_created
      ON price_history (cycle_id, coin_id, created_at);
  ELSE
    SELECT indexdef INTO fkdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'price_history'
       AND indexname = 'idx_price_history_cycle_coin_created';
    IF fkdef NOT LIKE '%(cycle_id, coin_id, created_at)%' THEN
      RAISE EXCEPTION 'migration 019: existing index idx_price_history_cycle_coin_created has an incompatible definition (%). Expected (cycle_id, coin_id, created_at). Fix it manually; the migration will not modify it.', fkdef;
    END IF;
  END IF;
END $$;
