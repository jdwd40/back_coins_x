-- Crypto Chaos V2-1: gameplay price precision 2dp -> 4dp.
-- Production DDL source of truth for the V2 price-precision widen.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- Why: the V2 cyclical market (game/marketDomain.js) prices every coin
-- through archetype swing bands as low as 4-8% (ZIP). Half the canonical
-- catalogue trades near £0.10, where 2dp persistence only allows 10%
-- quantisation steps — a £0.10 coin literally cannot express a 4-8% swing
-- at 2dp. Widening price columns to 4dp makes the archetype bands
-- representable on every coin. MONEY columns (cash, totals, funds) stay at
-- 2dp; only PRICE/VALUE columns carrying per-unit coin prices change.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: a numeric scale increase is lossless. Every
--     historical price, transaction, baseline and market row keeps its
--     exact value (2dp values are exact at 4dp).
--   * Every affected column's pre-existing shape is verified explicitly
--     (numeric type, expected precision, scale 2 — or already 4 from a
--     partial retry). An incompatible pre-existing column aborts the
--     migration with a clear error instead of being silently altered.
--   * If a column is already at scale 4 it is left untouched, so a
--     partially-applied retry converges instead of failing.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
DECLARE
  target record;
  col record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('coins',                    'current_price',           18),
      ('coins',                    'cycle_baseline_price',    18),
      ('coin_collapse_schedule',   'baseline_price',          18),
      ('price_history',            'price',                   20),
      ('market_history',           'total_value',             20),
      ('apocalypse_transactions',  'price',                   18),
      ('transactions',             'price',                   18),
      ('portfolios',               'average_purchase_price',  18),
      ('coin_statistics',          'all_time_high',           18),
      ('coin_statistics',          'all_time_low',            18)
    ) AS t(table_name, column_name, expected_precision)
  LOOP
    IF to_regclass('public.' || target.table_name) IS NULL THEN
      RAISE EXCEPTION 'migration 017: required table public.% does not exist. Apply earlier migrations first.', target.table_name;
    END IF;

    SELECT c.data_type, c.numeric_precision, c.numeric_scale, c.is_nullable
      INTO col
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = target.table_name
       AND c.column_name = target.column_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'migration 017: expected column public.%.% does not exist.', target.table_name, target.column_name;
    END IF;

    IF col.data_type <> 'numeric' THEN
      RAISE EXCEPTION 'migration 017: column public.%.% has type %, expected numeric. Fix it manually; the migration will not modify it.',
        target.table_name, target.column_name, col.data_type;
    END IF;

    IF col.numeric_scale = 4 THEN
      -- Already widened (partial retry): nothing to do for this column.
      CONTINUE;
    END IF;

    IF col.numeric_scale <> 2 OR col.numeric_precision <> target.expected_precision THEN
      RAISE EXCEPTION 'migration 017: column public.%.% is numeric(%,%), expected numeric(%,2) to widen or numeric(%,4) already widened. Fix it manually; the migration will not modify it.',
        target.table_name, target.column_name, col.numeric_precision, col.numeric_scale, target.expected_precision, target.expected_precision;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I TYPE DECIMAL(%s, 4)',
      target.table_name, target.column_name, target.expected_precision
    );
  END LOOP;
END $$;
