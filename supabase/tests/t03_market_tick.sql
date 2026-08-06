-- t03_market_tick.sql — tick atomicity, sequence/idempotency, halt, bounds
-- (plan §15.3)

\echo '--- t03: market tick'

SELECT coins.set_market_running(true);

-- ok 1: halted tick is a no-op but records heartbeat
SELECT coins.set_market_running(false, 't03-halt');
DO $$
DECLARE r jsonb;
BEGIN
  r := coins.run_market_tick('worker-test');
  IF NOT (r->>'skipped')::boolean THEN RAISE EXCEPTION 'FAIL: halted tick ran'; END IF;
  IF (SELECT worker_heartbeat_at IS NULL FROM coins.market_state WHERE id) THEN
    RAISE EXCEPTION 'FAIL: heartbeat not recorded';
  END IF;
  RAISE NOTICE 'ok: halted tick skipped, heartbeat recorded';
END $$;
SELECT coins.set_market_running(true);

-- ok 2: deterministic seeded tick updates all assets/ticks/snapshot atomically
SELECT setseed(0.42);
DO $$
DECLARE
  r jsonb; n_assets int; n_ticks int; n_snaps int; v_seq bigint;
BEGIN
  SELECT tick_sequence INTO v_seq FROM coins.market_state WHERE id;
  r := coins.run_market_tick('worker-test', v_seq);
  IF (r->>'tick_sequence')::bigint <> v_seq + 1 THEN RAISE EXCEPTION 'FAIL: sequence'; END IF;
  SELECT count(*) INTO n_assets FROM coins.assets;
  IF (r->>'assets_updated')::int <> n_assets THEN RAISE EXCEPTION 'FAIL: assets updated'; END IF;
  SELECT count(*) INTO n_ticks FROM coins.price_ticks WHERE tick_sequence = v_seq + 1;
  IF n_ticks <> n_assets THEN RAISE EXCEPTION 'FAIL: tick rows %', n_ticks; END IF;
  SELECT count(*) INTO n_snaps FROM coins.market_snapshots WHERE tick_sequence = v_seq + 1;
  IF n_snaps <> 1 THEN RAISE EXCEPTION 'FAIL: snapshot rows'; END IF;
  RAISE NOTICE 'ok: tick writes assets+ticks+snapshot atomically';
END $$;

-- ok 3: price bounds respected (±0.5% per tick, 20%-500% of baseline)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM coins.assets a
    JOIN coins.asset_simulation_state s ON s.asset_id = a.id
    WHERE a.current_price < s.baseline_price * 0.2
       OR a.current_price > s.baseline_price * 5
  ) THEN RAISE EXCEPTION 'FAIL: price outside baseline bounds'; END IF;
  IF EXISTS (
    SELECT 1 FROM coins.price_ticks t
    JOIN coins.asset_simulation_state s ON s.asset_id = t.asset_id
    WHERE abs(t.price - s.baseline_price) / s.baseline_price > 0.005 + 1e-9
      AND t.tick_sequence = (SELECT max(tick_sequence) FROM coins.market_state)
  ) THEN RAISE EXCEPTION 'FAIL: per-tick move beyond ±0.5%%'; END IF;
  RAISE NOTICE 'ok: price bounds respected';
END $$;

-- ok 4: retry with stale expected sequence is a no-op (already applied)
DO $$
DECLARE r jsonb; v_seq bigint; n int;
BEGIN
  SELECT tick_sequence INTO v_seq FROM coins.market_state WHERE id;
  r := coins.run_market_tick('worker-test', v_seq - 1);
  IF NOT (r->>'skipped')::boolean OR r->>'reason' <> 'already_applied' THEN
    RAISE EXCEPTION 'FAIL: stale retry not no-op: %', r;
  END IF;
  SELECT count(*) INTO n FROM coins.market_snapshots;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: duplicate snapshot'; END IF;
  RAISE NOTICE 'ok: stale sequence retry is a safe no-op';
END $$;

-- ok 5: skewed future sequence raises SEQUENCE_MISMATCH
DO $$
BEGIN
  PERFORM coins.run_market_tick('worker-test', 999999);
  RAISE EXCEPTION 'FAIL: skewed sequence accepted';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'FAIL: skewed sequence accepted' THEN RAISE; END IF;
  IF SQLERRM NOT LIKE 'SEQUENCE_MISMATCH%' THEN RAISE; END IF;
  RAISE NOTICE 'ok: sequence mismatch rejected';
END $$;

-- ok 6: duplicate tick_sequence cannot be written twice (unique constraints)
DO $$
BEGIN
  INSERT INTO coins.price_ticks (asset_id, price, captured_at, tick_sequence)
  SELECT asset_id, price, captured_at, tick_sequence FROM coins.price_ticks LIMIT 1;
  RAISE EXCEPTION 'FAIL: duplicate tick accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'ok: (asset_id, tick_sequence) unique';
END $$;

-- ok 7: cycle rollover persists (restart cannot reset countdown)
DO $$
DECLARE v_cycle coins.market_cycle; v_end timestamptz; r jsonb;
BEGIN
  UPDATE coins.market_state SET cycle_ends_at = now() - interval '1 second' WHERE id;
  r := coins.run_market_tick('worker-test');
  SELECT cycle, cycle_ends_at INTO v_cycle, v_end FROM coins.market_state WHERE id;
  IF v_end <= now() THEN RAISE EXCEPTION 'FAIL: cycle did not roll over'; END IF;
  RAISE NOTICE 'ok: cycle rollover persisted';
END $$;

-- ok 8: retention refuses to run without archive marker
DO $$
BEGIN
  PERFORM coins.apply_history_retention();
  RAISE EXCEPTION 'FAIL: retention ran without archive marker';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  IF SQLERRM <> 'ARCHIVE_NOT_CONFIRMED' THEN RAISE; END IF;
  RAISE NOTICE 'ok: retention requires archive marker';
END $$;

-- ok 9: retention with marker but without complete candles deletes nothing
DO $$
DECLARE n_before int; n_after int;
BEGIN
  SELECT count(*) INTO n_before FROM coins.price_ticks;
  PERFORM set_config('coins.archive_confirmed', 'on', false);
  PERFORM coins.apply_history_retention();
  SELECT count(*) INTO n_after FROM coins.price_ticks;
  PERFORM set_config('coins.archive_confirmed', 'off', false);
  IF n_after <> n_before THEN
    RAISE EXCEPTION 'FAIL: retention deleted ticks without candle coverage';
  END IF;
  RAISE NOTICE 'ok: retention blocked by missing candle coverage';
END $$;

\echo 't03 done'
