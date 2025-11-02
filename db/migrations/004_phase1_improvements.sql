-- Phase 1: Critical Fixes Migration
-- This migration implements the Phase 1 improvements from the plan

-- Connect to the main database
\c coins jd;

-- ============================================================================
-- 1. Standardize Timestamp Column
-- ============================================================================

-- Change created_at to TIMESTAMPTZ for UTC consistency
DO $$
BEGIN
    -- Only alter if not already timestamptz
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'price_history' 
        AND column_name = 'created_at'
        AND data_type != 'timestamp with time zone'
    ) THEN
        ALTER TABLE price_history 
            ALTER COLUMN created_at TYPE TIMESTAMPTZ 
            USING created_at AT TIME ZONE 'UTC';
        RAISE NOTICE 'Converted created_at to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'created_at is already TIMESTAMPTZ';
    END IF;
END $$;

-- ============================================================================
-- 2. Drop old indexes and create new covering index
-- ============================================================================

-- Drop the old separate indexes if they exist
DROP INDEX IF EXISTS idx_price_history_coin_id;
DROP INDEX IF EXISTS idx_price_history_created_at;
DROP INDEX IF EXISTS idx_price_history_coin_timestamp;

-- Create covering index (INCLUDE clause for better performance)
CREATE INDEX IF NOT EXISTS idx_price_history_covering 
ON price_history(coin_id, created_at DESC) INCLUDE (price);

-- ============================================================================
-- 3. Update cleanup function to 7 days
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
    DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '7 days';
    RAISE NOTICE 'Cleaned up price history older than 7 days';
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TEST DATABASE
-- ============================================================================

\c coins_test jd;

-- Repeat all changes for test database

-- Standardize Timestamp Column
DO $$
BEGIN
    -- Only alter if not already timestamptz
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'price_history' 
        AND column_name = 'created_at'
        AND data_type != 'timestamp with time zone'
    ) THEN
        ALTER TABLE price_history 
            ALTER COLUMN created_at TYPE TIMESTAMPTZ 
            USING created_at AT TIME ZONE 'UTC';
        RAISE NOTICE 'Converted created_at to TIMESTAMPTZ (test db)';
    ELSE
        RAISE NOTICE 'created_at is already TIMESTAMPTZ (test db)';
    END IF;
END $$;

-- Drop old indexes and create covering index
DROP INDEX IF EXISTS idx_price_history_coin_id;
DROP INDEX IF EXISTS idx_price_history_created_at;
DROP INDEX IF EXISTS idx_price_history_coin_timestamp;

CREATE INDEX IF NOT EXISTS idx_price_history_covering 
ON price_history(coin_id, created_at DESC) INCLUDE (price);

-- Update cleanup function
CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
    DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '7 days';
    RAISE NOTICE 'Cleaned up price history older than 7 days (test db)';
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Verification Queries
-- ============================================================================

\c coins jd;

-- Verify created_at column exists and is TIMESTAMPTZ
SELECT 
    column_name, 
    data_type,
    udt_name
FROM information_schema.columns
WHERE table_name = 'price_history' 
    AND column_name = 'created_at';

-- Verify covering index exists
SELECT 
    indexname, 
    indexdef
FROM pg_indexes
WHERE tablename = 'price_history' 
    AND indexname = 'idx_price_history_covering';

-- Show cleanup function
\df cleanup_price_history

