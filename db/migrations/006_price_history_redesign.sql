-- Non-destructive schema hardening for price-history redesign (Kimi design)
-- Run manually against production/test DBs before code deploy. DO NOT drop data.
-- This migration is purely additive/alignment. It does not drop price_history or any production data.

-- Connect to the main database
\c coins_x jd;

-- If an old schema used 'recorded_at', rename it to 'created_at'
-- (the deployed code already uses created_at, so this is defensive).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_history' AND column_name = 'recorded_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_history' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE price_history RENAME COLUMN recorded_at TO created_at;
  END IF;
END $$;

-- Ensure TIMESTAMPTZ for UTC correctness (conditional/idempotent to avoid unnecessary rewrite/lock if already TIMESTAMPTZ)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_history' AND column_name = 'created_at'
      AND data_type <> 'timestamp with time zone'
  ) THEN
    ALTER TABLE price_history
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
  END IF;
END $$;

-- Ensure price precision matches the code/seed (safe widen, no truncation; conditional/idempotent)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_history' AND column_name = 'price'
      AND NOT (data_type = 'numeric' AND numeric_precision = 20 AND numeric_scale = 2)
  ) THEN
    ALTER TABLE price_history
      ALTER COLUMN price TYPE DECIMAL(20,2);
  END IF;
END $$;

-- Covering index required for query-time bucketing performance
-- (existing idx may be there, IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_price_history_covering
ON price_history(coin_id, created_at DESC) INCLUDE (price);

-- Keep cleanup function aligned with the column name and 7-day retention (from design)
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
  DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- Connect to the test database
\c coins_x_test jd;

-- If an old schema used 'recorded_at', rename it to 'created_at'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_history' AND column_name = 'recorded_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_history' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE price_history RENAME COLUMN recorded_at TO created_at;
  END IF;
END $$;

-- Ensure TIMESTAMPTZ for UTC correctness (conditional/idempotent to avoid unnecessary rewrite/lock if already TIMESTAMPTZ)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_history' AND column_name = 'created_at'
      AND data_type <> 'timestamp with time zone'
  ) THEN
    ALTER TABLE price_history
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
  END IF;
END $$;

-- Ensure price precision matches the code/seed (safe widen, no truncation; conditional/idempotent)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_history' AND column_name = 'price'
      AND NOT (data_type = 'numeric' AND numeric_precision = 20 AND numeric_scale = 2)
  ) THEN
    ALTER TABLE price_history
      ALTER COLUMN price TYPE DECIMAL(20,2);
  END IF;
END $$;

-- Covering index required for query-time bucketing performance
CREATE INDEX IF NOT EXISTS idx_price_history_covering
ON price_history(coin_id, created_at DESC) INCLUDE (price);

-- Keep cleanup function aligned with the column name and 7-day retention
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
  DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
