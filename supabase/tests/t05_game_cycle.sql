-- t05_game_cycle.sql — Crypto Chaos Core 1: Global Apocalypse Cycle
-- Lifecycle, recovery, timing math boundaries, single-active invariant,
-- privileges. Runs as the migration owner unless a block sets a role.

\echo '--- t05: game cycle'

-- Clean slate + default config for every run of this file.
DELETE FROM coins.game_cycles;
UPDATE coins.game_config
   SET cycle_duration_ms = 1800000, align_to_boundary = true WHERE id;

-- ok 1: first ensure creates APOC-0001 active, aligned to a 30-min boundary
DO $$
DECLARE r jsonb; c coins.game_cycles%ROWTYPE;
BEGIN
  r := coins.ensure_active_cycle();
  IF NOT (r->>'created')::boolean THEN RAISE EXCEPTION 'FAIL: first ensure did not create'; END IF;
  IF r->>'apocalypse_id' <> 'APOC-0001' THEN RAISE EXCEPTION 'FAIL: id %', r; END IF;
  SELECT * INTO c FROM coins.game_cycles WHERE status = 'active';
  IF c.duration_ms <> 1800000 THEN RAISE EXCEPTION 'FAIL: default duration %', c.duration_ms; END IF;
  IF extract(epoch FROM (c.ends_at - c.starts_at)) <> 1800 THEN
    RAISE EXCEPTION 'FAIL: cycle span is not 30 min';
  END IF;
  IF (extract(minute FROM c.starts_at)::int % 30) <> 0
     OR extract(second FROM c.starts_at) <> 0 THEN
    RAISE EXCEPTION 'FAIL: starts_at % not on a half-hour boundary', c.starts_at;
  END IF;
  IF c.seed IS NULL OR c.seed < 0 THEN RAISE EXCEPTION 'FAIL: seed not recorded'; END IF;
  IF c.ends_at <= now() THEN RAISE EXCEPTION 'FAIL: new cycle already expired'; END IF;
  RAISE NOTICE 'ok: first cycle APOC-0001 created, 30 min, boundary-aligned, seeded';
END $$;

-- ok 2: ensure is idempotent while the round is live
DO $$
DECLARE r1 jsonb; r2 jsonb; n int;
BEGIN
  r1 := coins.ensure_active_cycle();
  r2 := coins.ensure_active_cycle();
  IF (r1->>'created')::boolean OR (r2->>'created')::boolean THEN
    RAISE EXCEPTION 'FAIL: duplicate creation';
  END IF;
  SELECT count(*) INTO n FROM coins.game_cycles;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: % cycles after idempotent ensure', n; END IF;
  RAISE NOTICE 'ok: repeated ensure is a no-op while active';
END $$;

-- ok 3: get_game_state exposes authoritative derived values
DO $$
DECLARE g jsonb; expected_pct numeric; c coins.game_cycles%ROWTYPE;
BEGIN
  g := coins.get_game_state();
  SELECT * INTO c FROM coins.game_cycles WHERE status = 'active';
  IF g->>'apocalypse_id' <> c.apocalypse_id THEN RAISE EXCEPTION 'FAIL: id mismatch'; END IF;
  IF (g->>'remaining_ms')::bigint < 0 THEN RAISE EXCEPTION 'FAIL: negative remaining'; END IF;
  IF (g->>'apocalypse_pct')::numeric < 0 OR (g->>'apocalypse_pct')::numeric > 100 THEN
    RAISE EXCEPTION 'FAIL: pct out of range';
  END IF;
  -- pct must be exactly derived from the returned server_time (server-owned)
  expected_pct := least(100, greatest(0, round(
    extract(epoch FROM ((g->>'server_time')::timestamptz - c.starts_at))
    / extract(epoch FROM (c.ends_at - c.starts_at)) * 100, 2)));
  IF (g->>'apocalypse_pct')::numeric <> expected_pct THEN
    RAISE EXCEPTION 'FAIL: pct % != derived %', g->>'apocalypse_pct', expected_pct;
  END IF;
  IF (g->>'server_time')::timestamptz IS NULL THEN RAISE EXCEPTION 'FAIL: no server_time'; END IF;
  RAISE NOTICE 'ok: game state exposes server time, non-negative remaining, clamped pct';
END $$;

-- ok 4: expiry roll-forward — expired round completes, next starts contiguously
DO $$
DECLARE
  v_old coins.game_cycles%ROWTYPE; v_new coins.game_cycles%ROWTYPE;
  r jsonb; n_active int;
BEGIN
  SELECT * INTO v_old FROM coins.game_cycles WHERE status = 'active';
  UPDATE coins.game_cycles SET ends_at = now() - interval '1 second'
   WHERE id = v_old.id
  RETURNING ends_at INTO v_old.ends_at;
  r := coins.ensure_active_cycle();
  IF NOT (r->>'created')::boolean THEN RAISE EXCEPTION 'FAIL: no roll-forward'; END IF;
  SELECT * INTO v_new FROM coins.game_cycles WHERE status = 'active';
  SELECT count(*) INTO n_active FROM coins.game_cycles WHERE status = 'active';
  IF n_active <> 1 THEN RAISE EXCEPTION 'FAIL: % active rounds', n_active; END IF;
  IF v_new.cycle_number <> v_old.cycle_number + 1 THEN
    RAISE EXCEPTION 'FAIL: cycle_number did not increment';
  END IF;
  IF v_new.apocalypse_id <> 'APOC-' || lpad((v_old.cycle_number + 1)::text, 4, '0') THEN
    RAISE EXCEPTION 'FAIL: apocalypse id sequence broken: %', v_new.apocalypse_id;
  END IF;
  IF v_new.starts_at <> v_old.ends_at THEN
    RAISE EXCEPTION 'FAIL: new cycle not contiguous with expired one';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM coins.game_cycles
                 WHERE id = v_old.id AND status = 'completed') THEN
    RAISE EXCEPTION 'FAIL: expired round not recorded as completed';
  END IF;
  RAISE NOTICE 'ok: expired round completed, next round contiguous and active';
END $$;

-- ok 5: recovery after multi-cycle downtime back-fills elapsed rounds
DO $$
DECLARE
  v_old coins.game_cycles%ROWTYPE; v_new coins.game_cycles%ROWTYPE;
  n_completed int; n_active int;
BEGIN
  SELECT * INTO v_old FROM coins.game_cycles WHERE status = 'active';
  -- Simulate the process being offline for ~3 full cycles (shift the whole
  -- window into the past so ends_at > starts_at still holds).
  UPDATE coins.game_cycles
     SET starts_at = now() - interval '2 hours',
         ends_at   = now() - (interval '30 minutes' * 3) - interval '1 second'
   WHERE id = v_old.id;
  PERFORM coins.ensure_active_cycle();
  SELECT count(*) INTO n_active FROM coins.game_cycles WHERE status = 'active';
  IF n_active <> 1 THEN RAISE EXCEPTION 'FAIL: % active after downtime', n_active; END IF;
  SELECT * INTO v_new FROM coins.game_cycles WHERE status = 'active';
  IF v_new.starts_at > now() OR v_new.ends_at <= now() THEN
    RAISE EXCEPTION 'FAIL: active round does not cover now (% -> %)',
      v_new.starts_at, v_new.ends_at;
  END IF;
  -- 3 elapsed cycles + the expired original = 4 newly completed rows.
  SELECT count(*) INTO n_completed FROM coins.game_cycles
   WHERE status = 'completed' AND cycle_number >= v_old.cycle_number;
  IF n_completed <> 4 THEN
    RAISE EXCEPTION 'FAIL: expected 4 completed rows, got %', n_completed;
  END IF;
  IF v_new.cycle_number <> v_old.cycle_number + 4 THEN
    RAISE EXCEPTION 'FAIL: numbering did not advance across downtime';
  END IF;
  RAISE NOTICE 'ok: 3-cycle downtime back-filled, single active round covers now';
END $$;

-- ok 6: timing math boundaries — early ~0%, mid ~50%, late clamped at <=100%
DO $$
DECLARE g jsonb; v_id bigint;
BEGIN
  DELETE FROM coins.game_cycles;
  -- Mid-cycle: exactly 50% elapsed.
  INSERT INTO coins.game_cycles
    (cycle_number, apocalypse_id, seed, starts_at, ends_at, duration_ms, status)
  VALUES (1, 'APOC-0001', 1, now() - interval '15 minutes',
          now() + interval '15 minutes', 1800000, 'active')
  RETURNING id INTO v_id;
  g := coins.get_game_state();
  IF abs((g->>'apocalypse_pct')::numeric - 50) > 0.5 THEN
    RAISE EXCEPTION 'FAIL: mid-cycle pct %', g->>'apocalypse_pct';
  END IF;
  -- Late-cycle: 99.9% elapsed; pct must clamp at <= 100, remaining >= 0.
  UPDATE coins.game_cycles
     SET starts_at = now() - interval '29 minutes 59 seconds',
         ends_at   = now() + interval '1 second'
   WHERE id = v_id;
  g := coins.get_game_state();
  IF (g->>'apocalypse_pct')::numeric > 100 OR (g->>'apocalypse_pct')::numeric < 99 THEN
    RAISE EXCEPTION 'FAIL: late pct %', g->>'apocalypse_pct';
  END IF;
  IF (g->>'remaining_ms')::bigint < 0 OR (g->>'remaining_ms')::bigint > 2000 THEN
    RAISE EXCEPTION 'FAIL: late remaining %', g->>'remaining_ms';
  END IF;
  -- Early-cycle: just started; pct near 0.
  UPDATE coins.game_cycles
     SET starts_at = now() - interval '1 second',
         ends_at   = now() + interval '29 minutes 59 seconds'
   WHERE id = v_id;
  g := coins.get_game_state();
  IF (g->>'apocalypse_pct')::numeric < 0 OR (g->>'apocalypse_pct')::numeric > 1 THEN
    RAISE EXCEPTION 'FAIL: early pct %', g->>'apocalypse_pct';
  END IF;
  RAISE NOTICE 'ok: pct ~0/50/~100 boundaries, remaining never negative';
END $$;

-- ok 7: row-level single-active invariant (even bypassing the functions)
DO $$
BEGIN
  INSERT INTO coins.game_cycles
    (cycle_number, apocalypse_id, seed, starts_at, ends_at, duration_ms, status)
  VALUES (999, 'APOC-0999', 1, now(), now() + interval '30 minutes', 1800000, 'active');
  RAISE EXCEPTION 'FAIL: second active round accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'ok: partial unique index rejects a second active round';
END $$;

-- ok 8: browser-role privileges — read game state, no writes, no internals
SET ROLE anon;
DO $$
DECLARE g jsonb; n int;
BEGIN
  g := coins.get_game_state();
  IF g->>'apocalypse_id' IS NULL THEN RAISE EXCEPTION 'FAIL: anon read'; END IF;
  SELECT count(*) INTO n FROM coins.game_cycles;
  RAISE NOTICE 'ok: anon can call get_game_state and read game_cycles (%)', n;
END $$;
DO $$
BEGIN
  BEGIN
    INSERT INTO coins.game_cycles
      (cycle_number, apocalypse_id, seed, starts_at, ends_at, duration_ms, status)
    VALUES (1000, 'APOC-1000', 1, now(), now() + interval '30 minutes', 1800000, 'active');
    RAISE EXCEPTION 'FAIL: anon inserted a cycle';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: anon cannot insert game_cycles';
  END;
  BEGIN
    PERFORM coins.ensure_active_cycle();
    RAISE EXCEPTION 'FAIL: anon executed ensure_active_cycle';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: anon cannot execute ensure_active_cycle';
  END;
  BEGIN
    PERFORM count(*) FROM coins.game_config;
    RAISE EXCEPTION 'FAIL: anon read game_config';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: anon cannot read game_config';
  END;
END $$;
RESET ROLE;

-- ok 9: configurable duration is honoured on the next cycle
DO $$
DECLARE v_old coins.game_cycles%ROWTYPE; v_new coins.game_cycles%ROWTYPE;
BEGIN
  UPDATE coins.game_config SET cycle_duration_ms = 2700000 WHERE id; -- 45 min
  SELECT * INTO v_old FROM coins.game_cycles WHERE status = 'active';
  UPDATE coins.game_cycles SET ends_at = now() - interval '1 second' WHERE id = v_old.id;
  PERFORM coins.ensure_active_cycle();
  SELECT * INTO v_new FROM coins.game_cycles WHERE status = 'active';
  IF v_new.duration_ms <> 2700000
     OR extract(epoch FROM (v_new.ends_at - v_new.starts_at)) <> 2700 THEN
    RAISE EXCEPTION 'FAIL: 45-min config not honoured';
  END IF;
  UPDATE coins.game_config SET cycle_duration_ms = 1800000 WHERE id; -- restore
  RAISE NOTICE 'ok: configurable cycle duration honoured';
END $$;

-- ok 10: seeds are reproducible under setseed (plan §19 debugging goal)
DO $$
DECLARE s1 bigint; s2 bigint;
BEGIN
  DELETE FROM coins.game_cycles;
  PERFORM setseed(0.7);
  PERFORM coins.ensure_active_cycle();
  SELECT seed INTO s1 FROM coins.game_cycles WHERE status = 'active';
  DELETE FROM coins.game_cycles;
  PERFORM setseed(0.7);
  PERFORM coins.ensure_active_cycle();
  SELECT seed INTO s2 FROM coins.game_cycles WHERE status = 'active';
  IF s1 IS NULL OR s1 <> s2 THEN
    RAISE EXCEPTION 'FAIL: seed not reproducible (% vs %)', s1, s2;
  END IF;
  RAISE NOTICE 'ok: round seed reproducible under setseed (%)', s1;
END $$;

\echo 't05 done'
