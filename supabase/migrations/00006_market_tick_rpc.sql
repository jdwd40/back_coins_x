-- 00006_market_tick_rpc.sql — run_market_tick, set_market_running (plan §8.4, §9)

BEGIN;

-- ---------------------------------------------------------------------------
-- run_market_tick(p_worker_id, p_expected_sequence) — coins_worker only.
-- Advisory lock + sequence check make duplicate/overlapping workers safe.
-- Randomness is injectable in tests via SELECT setseed(x) in the session.
-- All writes (prices, ticks, snapshot, state) commit atomically.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.run_market_tick(
  p_worker_id text,
  p_expected_sequence bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_state coins.market_state%ROWTYPE;
  v_new_seq bigint;
  v_now timestamptz := now();
  v_drift numeric;
  v_total numeric(30,8);
  v_assets_updated int := 0;
  v_asset RECORD;
  v_noise numeric;
  v_delta numeric;
  v_new_price numeric(24,8);
  v_cycles coins.market_cycle[] := ARRAY['STRONG_BOOM','MILD_BOOM','STABLE','MILD_BUST','STRONG_BUST']::coins.market_cycle[];
BEGIN
  -- Transaction-scoped advisory lock: two workers can never tick together.
  IF NOT pg_try_advisory_xact_lock(hashtext('coins_market_tick')) THEN
    RAISE EXCEPTION 'TICK_IN_PROGRESS' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_state FROM coins.market_state WHERE id FOR UPDATE;

  -- Heartbeat always updates (even when halted) so ops can see liveness.
  UPDATE coins.market_state
     SET worker_heartbeat_at = v_now, worker_instance_id = p_worker_id
   WHERE id;

  IF NOT v_state.is_running THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'market_halted',
                              'tick_sequence', v_state.tick_sequence);
  END IF;

  -- Sequence/idempotency: retry of an already-applied tick is a no-op;
  -- a skewed sequence is an error.
  IF p_expected_sequence IS NOT NULL THEN
    IF p_expected_sequence < v_state.tick_sequence THEN
      RETURN jsonb_build_object('skipped', true, 'reason', 'already_applied',
                                'tick_sequence', v_state.tick_sequence);
    ELSIF p_expected_sequence <> v_state.tick_sequence THEN
      RAISE EXCEPTION 'SEQUENCE_MISMATCH expected=% actual=%',
        p_expected_sequence, v_state.tick_sequence USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_new_seq := v_state.tick_sequence + 1;

  -- Cycle rollover (persisted: restart never resets the countdown).
  IF v_now >= v_state.cycle_ends_at THEN
    UPDATE coins.market_state
       SET cycle = v_cycles[1 + floor(random() * 5)::int],
           cycle_started_at = v_now,
           cycle_ends_at = v_now + (10 + floor(random() * 21)) * interval '1 minute'
     WHERE id
    RETURNING cycle INTO v_state.cycle;
  END IF;

  v_drift := CASE v_state.cycle
    WHEN 'STRONG_BOOM' THEN 0.0020
    WHEN 'MILD_BOOM'   THEN 0.0008
    WHEN 'MILD_BUST'   THEN -0.0008
    WHEN 'STRONG_BUST' THEN -0.0020
    ELSE 0 END;

  FOR v_asset IN
    SELECT a.id AS asset_id, a.current_price, a.circulating_supply,
           s.baseline_price, s.volatility, s.trend_direction, s.trend_strength,
           s.trend_ends_at, s.event_type, s.event_multiplier, s.event_ends_at
      FROM coins.assets a
      JOIN coins.asset_simulation_state s ON s.asset_id = a.id
     ORDER BY a.id
     FOR UPDATE OF a, s
  LOOP
    -- Trend expiry → fresh persisted trend (no process memory).
    IF v_asset.trend_ends_at IS NULL OR v_now >= v_asset.trend_ends_at THEN
      UPDATE coins.asset_simulation_state
         SET trend_direction = (floor(random() * 3) - 1)::smallint,
             trend_strength  = random() * 0.5,
             trend_ends_at   = v_now + (5 + floor(random() * 26)) * interval '1 minute'
       WHERE asset_id = v_asset.asset_id
      RETURNING trend_direction, trend_strength
           INTO v_asset.trend_direction, v_asset.trend_strength;
    END IF;

    -- Event expiry.
    IF v_asset.event_ends_at IS NOT NULL AND v_now >= v_asset.event_ends_at THEN
      UPDATE coins.asset_simulation_state
         SET event_type = NULL, event_multiplier = NULL, event_ends_at = NULL
       WHERE asset_id = v_asset.asset_id;
      v_asset.event_type := NULL;
      v_asset.event_multiplier := NULL;
    END IF;

    v_noise := (random() * 2 - 1) * v_asset.volatility
             + v_drift
             + v_asset.trend_direction * v_asset.trend_strength * 0.001
             + COALESCE((v_asset.event_multiplier - 1) * 0.005, 0);
    -- Legacy bounds: ±0.5 % per tick, price within 20 %–500 % of baseline.
    v_delta := least(0.005, greatest(-0.005, v_noise));
    v_new_price := round(
      least(v_asset.baseline_price * 5,
            greatest(v_asset.baseline_price * 0.2,
                     v_asset.current_price * (1 + v_delta)))::numeric, 8);

    UPDATE coins.assets
       SET current_price = v_new_price,
           market_cap = round(v_new_price * v_asset.circulating_supply, 2)
     WHERE id = v_asset.asset_id;

    INSERT INTO coins.price_ticks (asset_id, price, captured_at, tick_sequence)
    VALUES (v_asset.asset_id, v_new_price, v_now, v_new_seq);

    v_assets_updated := v_assets_updated + 1;
  END LOOP;

  -- Aggregate quote index: sum of current prices (parity with legacy
  -- market_history semantics, plan §4.3).
  SELECT COALESCE(sum(current_price), 0) INTO v_total FROM coins.assets;
  INSERT INTO coins.market_snapshots (tick_sequence, total_value, cycle, captured_at)
  VALUES (v_new_seq, v_total, v_state.cycle, v_now);

  UPDATE coins.market_state
     SET tick_sequence = v_new_seq, last_tick_at = v_now
   WHERE id;

  RETURN jsonb_build_object(
    'skipped', false, 'tick_sequence', v_new_seq,
    'assets_updated', v_assets_updated, 'total_value', v_total,
    'cycle', v_state.cycle, 'ticked_at', v_now);
END $$;

-- ---------------------------------------------------------------------------
-- set_market_running — service/admin only; replaces the public start/stop
-- routes from the legacy API.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.set_market_running(p_running boolean, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
BEGIN
  UPDATE coins.market_state
     SET is_running = p_running,
         halted_reason = CASE WHEN p_running THEN NULL ELSE COALESCE(p_reason, 'manual') END
   WHERE id;
  RETURN jsonb_build_object('is_running', p_running,
                            'reason', CASE WHEN p_running THEN NULL ELSE p_reason END);
END $$;

REVOKE ALL ON FUNCTION coins.run_market_tick(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.set_market_running(boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coins.run_market_tick(text, bigint) TO coins_worker;
-- set_market_running: granted to service_role only (never anon/authenticated).
GRANT EXECUTE ON FUNCTION coins.set_market_running(boolean, text) TO service_role;

COMMIT;
