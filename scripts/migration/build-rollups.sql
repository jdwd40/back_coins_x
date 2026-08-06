-- build-rollups.sql — backfill every candle interval from imported raw data
-- (plan §7.2 step 8). Idempotent upserts; safe to rerun.
-- Run as a privileged role after import-coins.mjs, BEFORE any retention.

BEGIN;

-- Per-asset candles over the full imported span.
SELECT coins.refresh_price_candles('15m', (SELECT min(captured_at) FROM coins.price_ticks));
SELECT coins.refresh_price_candles('1h',  (SELECT min(captured_at) FROM coins.price_ticks));
SELECT coins.refresh_price_candles('6h',  (SELECT min(captured_at) FROM coins.price_ticks));
SELECT coins.refresh_price_candles('1d',  (SELECT min(captured_at) FROM coins.price_ticks));

-- Aggregate market candles over the full imported span.
SELECT coins.refresh_market_candles('1m',  (SELECT min(captured_at) FROM coins.market_snapshots));
SELECT coins.refresh_market_candles('15m', (SELECT min(captured_at) FROM coins.market_snapshots));
SELECT coins.refresh_market_candles('1h',  (SELECT min(captured_at) FROM coins.market_snapshots));
SELECT coins.refresh_market_candles('1d',  (SELECT min(captured_at) FROM coins.market_snapshots));

COMMIT;

-- Verification helpers (run separately, read-only):
--   SELECT interval, count(*), min(bucket_start), max(bucket_start)
--     FROM coins.price_candles GROUP BY interval ORDER BY interval;
--   SELECT interval, count(*), min(bucket_start), max(bucket_start)
--     FROM coins.market_candles GROUP BY interval ORDER BY interval;
-- Then exercise every chart range via coins.get_price_history /
-- coins.get_market_history and confirm point budgets (plan §10).
