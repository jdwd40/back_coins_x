-- ===========================================================================
-- Migration 012: fractional Crypto Chaos round quantities.
--
-- Widens apocalypse_holdings.quantity and apocalypse_transactions.quantity
-- from DECIMAL(18, 2) to DECIMAL(18, 8) so round trades can carry
-- crypto-style fractional coin amounts (e.g. 0.004 JDC) exactly, instead of
-- the Core 4 behaviour of rounding to 2dp (which rejected 0.004 as 0.00 and
-- silently rounded 0.005 up to 0.01).
--
-- MONEY columns are untouched: price, total_amount, current_cash and friends
-- stay DECIMAL(18, 2). Only the COIN amount gains sub-penny precision, so
-- trade totals still resolve under the application's existing 2-decimal
-- money rules (round2 at execution).
--
-- Existing rows convert exactly: every 2-decimal value is representable at 8
-- decimals, so the widening is lossless for all stored game data.
--
-- Shape rules (same contract as migrations 009-011): the two tables must
-- already exist with quantity numeric(18,2) — the verified Core 4
-- predecessor state. A missing table/column or an unexpected type aborts
-- loudly; a column already at numeric(18,8) is the applied state and makes
-- re-execution (tracking row lost) a verified no-op.
-- ===========================================================================

DO $$
DECLARE
  prec integer;
  scale integer;
BEGIN
  -- -- apocalypse_holdings.quantity ----------------------------------------
  IF to_regclass('public.apocalypse_holdings') IS NULL THEN
    RAISE EXCEPTION 'migration 012: apocalypse_holdings does not exist — apply migration 009 (Core 4 round state) first';
  END IF;

  SELECT c.numeric_precision, c.numeric_scale INTO prec, scale
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'apocalypse_holdings'
    AND c.column_name = 'quantity'
    AND c.data_type = 'numeric';

  IF prec IS NULL THEN
    RAISE EXCEPTION 'migration 012: apocalypse_holdings.quantity is missing or not numeric — the Core 4 table shape is INCOMPATIBLE';
  ELSIF prec = 18 AND scale = 2 THEN
    ALTER TABLE apocalypse_holdings ALTER COLUMN quantity TYPE DECIMAL(18, 8);
  ELSIF NOT (prec = 18 AND scale = 8) THEN
    RAISE EXCEPTION 'migration 012: existing apocalypse_holdings.quantity is INCOMPATIBLE — numeric(%,%); expected the Core 4 predecessor numeric(18,2). Fix or revert the column manually; the migration will not modify it.', prec, scale;
  END IF;

  -- -- apocalypse_transactions.quantity ------------------------------------
  IF to_regclass('public.apocalypse_transactions') IS NULL THEN
    RAISE EXCEPTION 'migration 012: apocalypse_transactions does not exist — apply migration 009 (Core 4 round state) first';
  END IF;

  SELECT c.numeric_precision, c.numeric_scale INTO prec, scale
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'apocalypse_transactions'
    AND c.column_name = 'quantity'
    AND c.data_type = 'numeric';

  IF prec IS NULL THEN
    RAISE EXCEPTION 'migration 012: apocalypse_transactions.quantity is missing or not numeric — the Core 4 table shape is INCOMPATIBLE';
  ELSIF prec = 18 AND scale = 2 THEN
    ALTER TABLE apocalypse_transactions ALTER COLUMN quantity TYPE DECIMAL(18, 8);
  ELSIF NOT (prec = 18 AND scale = 8) THEN
    RAISE EXCEPTION 'migration 012: existing apocalypse_transactions.quantity is INCOMPATIBLE — numeric(%,%); expected the Core 4 predecessor numeric(18,2). Fix or revert the column manually; the migration will not modify it.', prec, scale;
  END IF;
END $$;
