-- Phase 2: Create price history rollups table for aggregated OHLC data
-- This migration creates the rollup table for faster chart queries

-- Connect to the main database
\c coins_x jd;

-- Drop existing table if it exists
DROP TABLE IF EXISTS price_history_rollups CASCADE;

-- Create rollup table
CREATE TABLE price_history_rollups (
    coin_id INT NOT NULL REFERENCES coins(coin_id) ON DELETE CASCADE,
    interval_type VARCHAR(10) NOT NULL CHECK (interval_type IN ('1m', '5m', '15m', '1h')),
    bucket_start TIMESTAMPTZ NOT NULL,
    open NUMERIC(12, 4) NOT NULL,
    high NUMERIC(12, 4) NOT NULL,
    low NUMERIC(12, 4) NOT NULL,
    close NUMERIC(12, 4) NOT NULL,
    tick_count INT NOT NULL,
    PRIMARY KEY (coin_id, interval_type, bucket_start)
);

-- Create index for efficient queries
CREATE INDEX idx_rollups_coin_interval 
ON price_history_rollups(coin_id, interval_type, bucket_start DESC);

-- Connect to the test database
\c coins_x_test jd;

-- Drop existing table if it exists
DROP TABLE IF EXISTS price_history_rollups CASCADE;

-- Create rollup table
CREATE TABLE price_history_rollups (
    coin_id INT NOT NULL REFERENCES coins(coin_id) ON DELETE CASCADE,
    interval_type VARCHAR(10) NOT NULL CHECK (interval_type IN ('1m', '5m', '15m', '1h')),
    bucket_start TIMESTAMPTZ NOT NULL,
    open NUMERIC(12, 4) NOT NULL,
    high NUMERIC(12, 4) NOT NULL,
    low NUMERIC(12, 4) NOT NULL,
    close NUMERIC(12, 4) NOT NULL,
    tick_count INT NOT NULL,
    PRIMARY KEY (coin_id, interval_type, bucket_start)
);

-- Create index for efficient queries
CREATE INDEX idx_rollups_coin_interval 
ON price_history_rollups(coin_id, interval_type, bucket_start DESC);

