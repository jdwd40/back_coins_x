-- t04_history.sql — candle aggregation, range contracts, point budgets,
-- late/out-of-order correction, rebucketing (plan §15.4)

\echo '--- t04: history & retention'

-- Fixture: 104 quarter-hour ticks for TCA over the last 26 h.
DO $$
DECLARE v_asset bigint;
BEGIN
  SELECT id INTO v_asset FROM coins.assets WHERE symbol = 'TCA';
  INSERT INTO coins.price_ticks (asset_id, price, captured_at, tick_sequence, source)
  SELECT v_asset,
         10 + (i % 10) * 0.1,
         now() - (i * interval '15 minutes'),
         100000 + i,
         'fixture'
  FROM generate_series(0, 103) i;
END $$;

-- Aggregate all intervals.
SELECT coins.refresh_price_candles('15m', now() - interval '26 hours');
SELECT coins.refresh_price_candles('1h',  now() - interval '26 hours');
SELECT coins.refresh_price_candles('6h',  now() - interval '26 hours');
SELECT coins.refresh_price_candles('1d',  now() - interval '26 hours');

-- ok 1: 15m candle OHLC correct for a known complete bucket
DO $$
DECLARE
  v_asset bigint := (SELECT id FROM coins.assets WHERE symbol='TCA');
  c RECORD;
BEGIN
  -- bucket containing now()-25h (i≈100): price = 10 + (100%10)*0.1 = 10.0
  SELECT * INTO c FROM coins.price_candles
   WHERE asset_id = v_asset AND interval = '15m'
   ORDER BY bucket_start LIMIT 1;  -- oldest bucket: i=103 → price 10.3
  IF c.open <> 10.3 OR c.high <> 10.3 OR c.low <> 10.3 OR c.close <> 10.3
     OR c.sample_count <> 1 OR NOT c.is_complete THEN
    RAISE EXCEPTION 'FAIL: candle content %', c;
  END IF;
  RAISE NOTICE 'ok: 15m candle OHLC/samples/complete correct';
END $$;

-- ok 2: late tick corrects an existing complete bucket (upsert, not ignore)
DO $$
DECLARE
  v_asset bigint := (SELECT id FROM coins.assets WHERE symbol='TCA');
  v_bucket timestamptz;
  c RECORD;
BEGIN
  SELECT bucket_start INTO v_bucket FROM coins.price_candles
   WHERE asset_id = v_asset AND interval = '15m' ORDER BY bucket_start LIMIT 1;
  INSERT INTO coins.price_ticks (asset_id, price, captured_at, tick_sequence, source)
  VALUES (v_asset, 99.5, v_bucket + interval '1 minute', 100999, 'late-fixture');
  PERFORM coins.refresh_price_candles('15m', v_bucket, v_bucket + interval '15 minutes');
  SELECT * INTO c FROM coins.price_candles
   WHERE asset_id = v_asset AND interval = '15m' AND bucket_start = v_bucket;
  IF c.high <> 99.5 OR c.sample_count <> 2 THEN
    RAISE EXCEPTION 'FAIL: late tick not incorporated: %', c;
  END IF;
  RAISE NOTICE 'ok: late/out-of-order tick corrects OHLC via upsert';
END $$;

-- ok 3: per-asset range contract bounds
DO $$
DECLARE
  v_asset bigint := (SELECT id FROM coins.assets WHERE symbol='TCA');
  r jsonb; n int;
BEGIN
  r := coins.get_price_history(v_asset, '24H');
  n := jsonb_array_length(r->'points');
  IF n = 0 OR n > 96 THEN RAISE EXCEPTION 'FAIL: 24H points %', n; END IF;
  IF r->>'resolution' <> '15m' THEN RAISE EXCEPTION 'FAIL: 24H resolution'; END IF;
  IF (r->>'latest')::numeric <> (SELECT current_price FROM coins.assets WHERE id = v_asset) THEN
    RAISE EXCEPTION 'FAIL: latest != current_price';
  END IF;

  r := coins.get_price_history(v_asset, '7D');
  n := jsonb_array_length(r->'points');
  IF n = 0 OR n > 168 THEN RAISE EXCEPTION 'FAIL: 7D points %', n; END IF;

  r := coins.get_price_history(v_asset, '30D');
  n := jsonb_array_length(r->'points');
  IF n = 0 OR n > 120 THEN RAISE EXCEPTION 'FAIL: 30D points %', n; END IF;

  r := coins.get_price_history(v_asset, 'ALL');
  n := jsonb_array_length(r->'points');
  IF n = 0 OR n > 200 THEN RAISE EXCEPTION 'FAIL: ALL points %', n; END IF;
  RAISE NOTICE 'ok: per-asset ranges bounded (24H≤96, 7D≤168, 30D≤120, ALL≤200)';
END $$;

-- ok 4: invalid range is a typed error, never a silent ALL
DO $$
BEGIN
  PERFORM coins.get_price_history(1, 'EVERYTHING');
  RAISE EXCEPTION 'FAIL: invalid range accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  IF SQLERRM <> 'INVALID_RANGE' THEN RAISE; END IF;
  RAISE NOTICE 'ok: invalid per-asset range rejected';
END $$;

-- ok 5: rebucket keeps ALL ≤200 with 250 6h candles (span < 120d → 6h source)
DO $$
DECLARE
  v_asset bigint := (SELECT id FROM coins.assets WHERE symbol='TCB');
  n int; r jsonb;
BEGIN
  INSERT INTO coins.price_candles
    (asset_id, interval, bucket_start, open, high, low, close, sample_count, is_complete)
  SELECT v_asset, '6h',
         to_timestamp(floor(extract(epoch FROM now() - (i * interval '6 hours')) / 21600) * 21600),
         2.5, 2.5 + (i % 5) * 0.1, 2.5, 2.5, 4, true
  FROM generate_series(0, 249) i
  ON CONFLICT (asset_id, interval, bucket_start) DO NOTHING;
  SELECT count(*) INTO n FROM coins.price_candles WHERE asset_id = v_asset AND interval = '6h';
  IF n < 250 THEN RAISE EXCEPTION 'FAIL: fixture candles %', n; END IF;
  r := coins.get_price_history(v_asset, 'ALL');
  n := jsonb_array_length(r->'points');
  IF n > 200 OR n < 100 THEN RAISE EXCEPTION 'FAIL: rebucket points %', n; END IF;
  RAISE NOTICE 'ok: ALL rebucketed to % points (≤200)', n;
END $$;

-- ok 6: aggregate market ranges from raw snapshots
DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..9 LOOP
    INSERT INTO coins.market_snapshots (tick_sequence, total_value, cycle, captured_at)
    VALUES (200000 + i, 12.5 + i * 0.01, 'STABLE', now() - (i * interval '30 seconds'));
  END LOOP;
END $$;
DO $$
DECLARE r jsonb; n int;
BEGIN
  r := coins.get_market_history('5M');
  n := jsonb_array_length(r->'points');
  IF n = 0 OR n > 10 THEN RAISE EXCEPTION 'FAIL: 5M points %', n; END IF;
  IF r->>'label' <> 'aggregate_quote_index' THEN RAISE EXCEPTION 'FAIL: label'; END IF;
  r := coins.get_market_history('1H');
  n := jsonb_array_length(r->'points');
  IF n = 0 OR n > 120 THEN RAISE EXCEPTION 'FAIL: 1H points %', n; END IF;
  RAISE NOTICE 'ok: aggregate snapshot ranges bounded';
END $$;

-- ok 7: aggregate candle ranges
SELECT coins.refresh_market_candles('1m',  now() - interval '3 hours');
SELECT coins.refresh_market_candles('15m', now() - interval '26 hours');
DO $$
DECLARE r jsonb; n int;
BEGIN
  r := coins.get_market_history('2H');
  n := jsonb_array_length(r->'points');
  IF n > 120 THEN RAISE EXCEPTION 'FAIL: 2H points %', n; END IF;
  r := coins.get_market_history('24H');
  n := jsonb_array_length(r->'points');
  IF n > 96 THEN RAISE EXCEPTION 'FAIL: market 24H points %', n; END IF;
  BEGIN
    PERFORM coins.get_market_history('MAX');
    RAISE EXCEPTION 'FAIL: invalid market range accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    IF SQLERRM <> 'INVALID_RANGE' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: aggregate candle ranges bounded, invalid range rejected';
END $$;

-- ok 8: retention deletes covered old ticks only after marker + candles
DO $$
DECLARE
  v_asset bigint := (SELECT id FROM coins.assets WHERE symbol='TCG');
  n_before int; n_after int;
BEGIN
  -- old ticks fully covered by complete 15m candles
  INSERT INTO coins.price_ticks (asset_id, price, captured_at, tick_sequence, source)
  SELECT v_asset, 0.01, now() - interval '3 days' + (i * interval '1 minute'), 300000 + i, 'fixture'
  FROM generate_series(0, 59) i;
  PERFORM coins.refresh_price_candles('15m', now() - interval '4 days', now() - interval '2 days');
  -- force-complete the buckets (they are in the past so already complete)
  SELECT count(*) INTO n_before FROM coins.price_ticks WHERE asset_id = v_asset;
  PERFORM set_config('coins.archive_confirmed', 'on', false);
  PERFORM coins.apply_history_retention();
  PERFORM set_config('coins.archive_confirmed', 'off', false);
  SELECT count(*) INTO n_after FROM coins.price_ticks WHERE asset_id = v_asset;
  -- All fixture ticks (3 days old, candle-covered) must be gone; only the
  -- two recent t03 ticks (younger than 48 h) may survive.
  IF n_after >= n_before THEN
    RAISE EXCEPTION 'FAIL: covered old ticks not pruned (% of % left)', n_after, n_before;
  END IF;
  IF EXISTS (SELECT 1 FROM coins.price_ticks
              WHERE asset_id = v_asset AND captured_at < now() - interval '48 hours') THEN
    RAISE EXCEPTION 'FAIL: old covered ticks remain';
  END IF;
  -- recent uncovered ticks must survive
  IF (SELECT count(*) FROM coins.price_ticks WHERE asset_id =
        (SELECT id FROM coins.assets WHERE symbol='TCA')) = 0 THEN
    RAISE EXCEPTION 'FAIL: uncovered ticks pruned';
  END IF;
  RAISE NOTICE 'ok: retention prunes only candle-covered raw history';
END $$;

\echo 't04 done'
