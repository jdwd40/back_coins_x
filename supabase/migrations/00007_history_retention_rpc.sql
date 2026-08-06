-- 00007_history_retention_rpc.sql — bounded history RPCs, candle refresh,
-- retention with archive/coverage guards (plan §8.4, §10).

BEGIN;

-- ---------------------------------------------------------------------------
-- Internal: rebucket an ordered candle set to at most p_max points.
-- Deterministic: open = first by bucket order, close = last, high/low = extremes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins._candles_to_points(
  p_asset_id bigint,
  p_interval coins.candle_interval,
  p_from timestamptz,
  p_max int
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = coins, pg_temp
AS $$
  WITH src AS (
    SELECT bucket_start, open, high, low, close, sample_count, is_complete
      FROM coins.price_candles
     WHERE asset_id = p_asset_id AND interval = p_interval
       AND (p_from IS NULL OR bucket_start >= p_from)
     ORDER BY bucket_start
  ), grp AS (
    SELECT *, ((row_number() OVER ()) - 1)
              / greatest(1, ceil((SELECT count(*) FROM src)::numeric / p_max))::int AS g
      FROM src
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'time', bucket_start, 'open', open, 'high', high, 'low', low,
           'close', close, 'samples', samples, 'complete', complete)
         ORDER BY bucket_start), '[]'::jsonb)
  FROM (
    SELECT min(bucket_start) AS bucket_start,
           (array_agg(open  ORDER BY bucket_start))[1]      AS open,
           max(high)                                        AS high,
           min(low)                                         AS low,
           (array_agg(close ORDER BY bucket_start DESC))[1] AS close,
           sum(sample_count)                                AS samples,
           bool_and(is_complete)                            AS complete
      FROM grp GROUP BY g
  ) buckets $$;

-- ---------------------------------------------------------------------------
-- get_price_history(p_asset_id, p_range) — plan §10.1 range contract.
-- 24H=15m≤96, 7D=1h≤168, 30D=6h≤120, ALL adaptive ≤200. Numeric only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.get_price_history(p_asset_id bigint, p_range text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_interval coins.candle_interval;
  v_from timestamptz;
  v_resolution text;
  v_max int;
  v_price numeric(24,8);
  v_span interval;
BEGIN
  IF p_range NOT IN ('24H','7D','30D','ALL') THEN
    RAISE EXCEPTION 'INVALID_RANGE' USING ERRCODE = 'P0001';
  END IF;

  SELECT current_price INTO v_price FROM coins.assets WHERE id = p_asset_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF p_range = '24H' THEN
    v_interval := '15m'; v_from := now() - interval '24 hours';
    v_resolution := '15m'; v_max := 96;
  ELSIF p_range = '7D' THEN
    v_interval := '1h';  v_from := now() - interval '7 days';
    v_resolution := '1h';  v_max := 168;
  ELSIF p_range = '30D' THEN
    v_interval := '6h';  v_from := now() - interval '30 days';
    v_resolution := '6h';  v_max := 120;
  ELSE -- ALL: pick resolution from actual span so points never exceed 200
    SELECT now() - min(bucket_start) INTO v_span
      FROM coins.price_candles WHERE asset_id = p_asset_id;
    IF v_span IS NULL OR v_span <= interval '120 days' THEN
      v_interval := '6h'; v_resolution := '6h-adaptive';
    ELSE
      v_interval := '1d'; v_resolution := '1d-adaptive';
    END IF;
    v_from := NULL; v_max := 200;
  END IF;

  RETURN jsonb_build_object(
    'range', p_range,
    'from', v_from,
    'to', now(),
    'server_time', now(),
    'resolution', v_resolution,
    'latest', v_price,
    'points', coins._candles_to_points(p_asset_id, v_interval, v_from, v_max));
END $$;

-- ---------------------------------------------------------------------------
-- get_market_history(p_range) — plan §10.2 aggregate contract.
-- 5M/10M/30M/1H from raw snapshots; 2H=1m; 12H/24H=15m; ALL adaptive ≤200.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.get_market_history(p_range text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_from timestamptz;
  v_resolution text;
  v_max int;
  v_points jsonb;
  v_interval coins.market_candle_interval;
  v_span interval;
BEGIN
  IF p_range NOT IN ('5M','10M','30M','1H','2H','12H','24H','ALL') THEN
    RAISE EXCEPTION 'INVALID_RANGE' USING ERRCODE = 'P0001';
  END IF;

  IF p_range IN ('5M','10M','30M','1H') THEN
    v_from := now() - CASE p_range
      WHEN '5M'  THEN interval '5 minutes'
      WHEN '10M' THEN interval '10 minutes'
      WHEN '30M' THEN interval '30 minutes'
      ELSE interval '1 hour' END;
    v_resolution := '30s';
    v_max := CASE p_range WHEN '5M' THEN 10 WHEN '10M' THEN 20
                          WHEN '30M' THEN 60 ELSE 120 END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'time', captured_at, 'open', total_value, 'high', total_value,
             'low', total_value, 'close', total_value,
             'samples', 1, 'complete', true) ORDER BY captured_at, id), '[]'::jsonb)
      INTO v_points
      FROM (SELECT captured_at, id, total_value FROM coins.market_snapshots
             WHERE captured_at >= v_from ORDER BY captured_at DESC, id DESC LIMIT v_max) s;
  ELSE
    IF p_range = '2H' THEN
      v_interval := '1m';  v_from := now() - interval '2 hours';
      v_resolution := '1m';  v_max := 120;
    ELSIF p_range = '12H' THEN
      v_interval := '15m'; v_from := now() - interval '12 hours';
      v_resolution := '15m'; v_max := 48;
    ELSIF p_range = '24H' THEN
      v_interval := '15m'; v_from := now() - interval '24 hours';
      v_resolution := '15m'; v_max := 96;
    ELSE -- ALL
      SELECT now() - min(bucket_start) INTO v_span FROM coins.market_candles;
      IF v_span IS NULL OR v_span <= interval '400 days' THEN
        v_interval := '1h'; v_resolution := '1h-adaptive';
      ELSE
        v_interval := '1d'; v_resolution := '1d-adaptive';
      END IF;
      v_from := NULL; v_max := 200;
    END IF;

    WITH src AS (
      SELECT bucket_start, open, high, low, close, sample_count, is_complete
        FROM coins.market_candles
       WHERE interval = v_interval AND (v_from IS NULL OR bucket_start >= v_from)
       ORDER BY bucket_start
    ), grp AS (
      SELECT *, ((row_number() OVER ()) - 1)
                / greatest(1, ceil((SELECT count(*) FROM src)::numeric / v_max))::int AS g
        FROM src
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'time', bucket_start, 'open', open, 'high', high, 'low', low,
             'close', close, 'samples', samples, 'complete', complete)
           ORDER BY bucket_start), '[]'::jsonb)
      INTO v_points
    FROM (
      SELECT min(bucket_start) AS bucket_start,
             (array_agg(open  ORDER BY bucket_start))[1]      AS open,
             max(high)                                        AS high,
             min(low)                                         AS low,
             (array_agg(close ORDER BY bucket_start DESC))[1] AS close,
             sum(sample_count)                                AS samples,
             bool_and(is_complete)                            AS complete
        FROM grp GROUP BY g
    ) buckets;
  END IF;

  RETURN jsonb_build_object(
    'range', p_range, 'from', v_from, 'to', now(), 'server_time', now(),
    'resolution', v_resolution, 'label', 'aggregate_quote_index',
    'points', v_points);
END $$;

-- ---------------------------------------------------------------------------
-- refresh_price_candles(p_interval, p_from, p_to) — idempotent upsert.
-- Reprocesses any window, so late/out-of-order ticks correct OHLC.
-- Open/close ordering: (captured_at, id) — deterministic on duplicate
-- timestamps. Returns rows upserted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.refresh_price_candles(
  p_interval coins.candle_interval,
  p_from timestamptz,
  p_to timestamptz DEFAULT now()
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_secs int := CASE p_interval
    WHEN '15m' THEN 900 WHEN '1h' THEN 3600
    WHEN '6h' THEN 21600 WHEN '1d' THEN 86400 END;
  v_rows int;
BEGIN
  WITH bucketed AS (
    SELECT asset_id,
           to_timestamp(floor(extract(epoch FROM captured_at) / v_secs) * v_secs) AS bucket,
           price, captured_at, id
      FROM coins.price_ticks
     WHERE captured_at >= p_from AND captured_at < p_to
  )
  INSERT INTO coins.price_candles
    (asset_id, interval, bucket_start, open, high, low, close, sample_count, is_complete)
  SELECT asset_id, p_interval, bucket,
         (array_agg(price ORDER BY captured_at, id))[1],
         max(price), min(price),
         (array_agg(price ORDER BY captured_at DESC, id DESC))[1],
         count(*),
         (bucket + v_secs * interval '1 second') <= now()
    FROM bucketed
    GROUP BY asset_id, bucket
  ON CONFLICT (asset_id, interval, bucket_start) DO UPDATE
     SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, sample_count = EXCLUDED.sample_count,
         is_complete = EXCLUDED.is_complete, updated_at = now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- refresh_market_candles — same semantics over market_snapshots.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.refresh_market_candles(
  p_interval coins.market_candle_interval,
  p_from timestamptz,
  p_to timestamptz DEFAULT now()
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_secs int := CASE p_interval
    WHEN '1m' THEN 60 WHEN '15m' THEN 900
    WHEN '1h' THEN 3600 WHEN '1d' THEN 86400 END;
  v_rows int;
BEGIN
  WITH bucketed AS (
    SELECT to_timestamp(floor(extract(epoch FROM captured_at) / v_secs) * v_secs) AS bucket,
           total_value, captured_at, id
      FROM coins.market_snapshots
     WHERE captured_at >= p_from AND captured_at < p_to
  )
  INSERT INTO coins.market_candles
    (interval, bucket_start, open, high, low, close, sample_count, is_complete)
  SELECT p_interval, bucket,
         (array_agg(total_value ORDER BY captured_at, id))[1],
         max(total_value), min(total_value),
         (array_agg(total_value ORDER BY captured_at DESC, id DESC))[1],
         count(*),
         (bucket + v_secs * interval '1 second') <= now()
    FROM bucketed
    GROUP BY bucket
  ON CONFLICT (interval, bucket_start) DO UPDATE
     SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, sample_count = EXCLUDED.sample_count,
         is_complete = EXCLUDED.is_complete, updated_at = now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- apply_history_retention — refuses destructive deletes without (a) the ops
-- archive marker and (b) complete successor candles covering every row.
-- Policy (plan §10.2, §10.3):
--   price_ticks 48h→15m candles; 15m 45d→1h; 1h 400d→6h; 6h 5y→1d; 1d keep.
--   snapshots 48h→1m; 1m 14d→15m; 15m 400d→1h; 1h 5y→1d; 1d keep.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.apply_history_retention()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_deleted jsonb := '{}'::jsonb;
  v_n int;
BEGIN
  IF current_setting('coins.archive_confirmed', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'ARCHIVE_NOT_CONFIRMED' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM coins.price_ticks t
   WHERE t.captured_at < now() - interval '48 hours'
     AND EXISTS (SELECT 1 FROM coins.price_candles c
                  WHERE c.asset_id = t.asset_id AND c.interval = '15m' AND c.is_complete
                    AND c.bucket_start <= t.captured_at
                    AND t.captured_at < c.bucket_start + interval '15 minutes');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('price_ticks', v_n);

  DELETE FROM coins.price_candles c
   WHERE c.interval = '15m' AND c.bucket_start < now() - interval '45 days'
     AND EXISTS (SELECT 1 FROM coins.price_candles x
                  WHERE x.asset_id = c.asset_id AND x.interval = '1h' AND x.is_complete
                    AND x.bucket_start <= c.bucket_start
                    AND c.bucket_start < x.bucket_start + interval '1 hour');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('price_candles_15m', v_n);

  DELETE FROM coins.price_candles c
   WHERE c.interval = '1h' AND c.bucket_start < now() - interval '400 days'
     AND EXISTS (SELECT 1 FROM coins.price_candles x
                  WHERE x.asset_id = c.asset_id AND x.interval = '6h' AND x.is_complete
                    AND x.bucket_start <= c.bucket_start
                    AND c.bucket_start < x.bucket_start + interval '6 hours');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('price_candles_1h', v_n);

  DELETE FROM coins.price_candles c
   WHERE c.interval = '6h' AND c.bucket_start < now() - interval '5 years'
     AND EXISTS (SELECT 1 FROM coins.price_candles x
                  WHERE x.asset_id = c.asset_id AND x.interval = '1d' AND x.is_complete
                    AND x.bucket_start <= c.bucket_start
                    AND c.bucket_start < x.bucket_start + interval '1 day');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('price_candles_6h', v_n);

  DELETE FROM coins.market_snapshots s
   WHERE s.captured_at < now() - interval '48 hours'
     AND EXISTS (SELECT 1 FROM coins.market_candles c
                  WHERE c.interval = '1m' AND c.is_complete
                    AND c.bucket_start <= s.captured_at
                    AND s.captured_at < c.bucket_start + interval '1 minute');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('market_snapshots', v_n);

  DELETE FROM coins.market_candles c
   WHERE c.interval = '1m' AND c.bucket_start < now() - interval '14 days'
     AND EXISTS (SELECT 1 FROM coins.market_candles x
                  WHERE x.interval = '15m' AND x.is_complete
                    AND x.bucket_start <= c.bucket_start
                    AND c.bucket_start < x.bucket_start + interval '15 minutes');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('market_candles_1m', v_n);

  DELETE FROM coins.market_candles c
   WHERE c.interval = '15m' AND c.bucket_start < now() - interval '400 days'
     AND EXISTS (SELECT 1 FROM coins.market_candles x
                  WHERE x.interval = '1h' AND x.is_complete
                    AND x.bucket_start <= c.bucket_start
                    AND c.bucket_start < x.bucket_start + interval '1 hour');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('market_candles_15m', v_n);

  DELETE FROM coins.market_candles c
   WHERE c.interval = '1h' AND c.bucket_start < now() - interval '5 years'
     AND EXISTS (SELECT 1 FROM coins.market_candles x
                  WHERE x.interval = '1d' AND x.is_complete
                    AND x.bucket_start <= c.bucket_start
                    AND c.bucket_start < x.bucket_start + interval '1 day');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('market_candles_1h', v_n);

  RETURN v_deleted;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION coins._candles_to_points(bigint, coins.candle_interval, timestamptz, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.get_price_history(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.get_market_history(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.refresh_price_candles(coins.candle_interval, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.refresh_market_candles(coins.market_candle_interval, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.apply_history_retention() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION coins.get_price_history(bigint, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION coins.get_market_history(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION coins.refresh_price_candles(coins.candle_interval, timestamptz, timestamptz) TO coins_worker;
GRANT EXECUTE ON FUNCTION coins.refresh_market_candles(coins.market_candle_interval, timestamptz, timestamptz) TO coins_worker;
GRANT EXECUTE ON FUNCTION coins.apply_history_retention() TO coins_worker, service_role;

COMMIT;
