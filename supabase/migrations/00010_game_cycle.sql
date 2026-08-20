-- 00010_game_cycle.sql — Crypto Chaos Core 1: Global Apocalypse Cycle
-- Server-owned global game cycle (plan §4, §5, §19; Epic issue 1).
--
-- Design (mirrors the market-tick architecture):
--   * All authoritative state lives in PostgreSQL. No process memory.
--   * coins.ensure_active_cycle() is the single writer: advisory-lock
--     serialised, idempotent, rolls forward deterministically after downtime.
--   * coins.get_game_state() is the public, self-healing read: any caller
--     (browser poll, worker tick, startup probe) advances the cycle, so the
--     game never depends on a logged-in user or a specific process.
--   * A partial unique index guarantees at most one active round even if a
--     caller bypasses the functions.
-- Randomness (round seeds) is injectable in tests via SELECT setseed(x).

BEGIN;

-- ---------------------------------------------------------------------------
-- game_config — singleton runtime configuration (service/admin owned)
-- ---------------------------------------------------------------------------
CREATE TABLE coins.game_config (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Cycle length in milliseconds. Default 30 minutes (plan §4).
  cycle_duration_ms integer NOT NULL DEFAULT 1800000
                    CHECK (cycle_duration_ms >= 60000 AND cycle_duration_ms <= 86400000),
  -- When true (default) the first cycle of a fresh install starts on a
  -- predictable duration-aligned wall-clock boundary (for 30 min: :00/:30).
  -- Chained cycles stay aligned because each starts at the previous ends_at.
  align_to_boundary boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO coins.game_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
CREATE TRIGGER game_config_updated_at BEFORE UPDATE ON coins.game_config
  FOR EACH ROW EXECUTE FUNCTION coins.set_updated_at();
COMMENT ON TABLE coins.game_config IS
  'Singleton Crypto Chaos game configuration. cycle_duration_ms default 1800000 (30 min).';

-- ---------------------------------------------------------------------------
-- game_cycles — one row per apocalypse round (active + completed history)
-- ---------------------------------------------------------------------------
CREATE TABLE coins.game_cycles (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cycle_number  bigint NOT NULL UNIQUE CHECK (cycle_number > 0),
  apocalypse_id text NOT NULL UNIQUE,          -- e.g. 'APOC-0042' (plan §19)
  seed          bigint NOT NULL CHECK (seed >= 0),  -- reproducibility seed
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  duration_ms   integer NOT NULL CHECK (duration_ms >= 60000),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
-- Exactly one active round, enforced at the row level regardless of caller.
CREATE UNIQUE INDEX game_cycles_single_active_key
  ON coins.game_cycles (status) WHERE status = 'active';
CREATE INDEX game_cycles_ends_at_idx ON coins.game_cycles (ends_at DESC);
CREATE TRIGGER game_cycles_updated_at BEFORE UPDATE ON coins.game_cycles
  FOR EACH ROW EXECUTE FUNCTION coins.set_updated_at();
COMMENT ON TABLE coins.game_cycles IS
  'Apocalypse rounds. At most one status=active row (partial unique index). Completed rows are the round history.';

-- ---------------------------------------------------------------------------
-- ensure_active_cycle() — single writer for cycle lifecycle.
-- Advisory-lock serialised: concurrent workers/reads cannot create duplicate
-- active rounds. Idempotent: if a valid active round exists it is returned
-- unchanged. Recovery: if the active round expired (offline or not), each
-- fully-elapsed cycle is recorded as completed and a fresh active round is
-- created covering now — the app can never be left stuck without a cycle.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.ensure_active_cycle() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_now    timestamptz := now();
  v_cfg    coins.game_config%ROWTYPE;
  v_active coins.game_cycles%ROWTYPE;
  v_last   coins.game_cycles%ROWTYPE;
  v_dur    interval;
  v_dur_s  double precision;
  v_start  timestamptz;
  v_no     bigint;
  v_rolled int := 0;
  v_guard  int := 0;
  -- Safety cap for catch-up backfill after extreme downtime
  -- (10000 cycles ≈ 208 days at 30 min). Beyond it we stop back-filling and
  -- resume at the current boundary; history before the gap is untouched.
  c_max_catchup CONSTANT int := 10000;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('coins_game_cycle'));

  SELECT * INTO v_cfg FROM coins.game_config WHERE id;
  v_dur   := make_interval(secs => v_cfg.cycle_duration_ms / 1000.0);
  v_dur_s := v_cfg.cycle_duration_ms / 1000.0;

  -- Complete any expired active round. The partial unique index guarantees
  -- at most one, but keep this set-based for defence in depth.
  UPDATE coins.game_cycles SET status = 'completed'
   WHERE status = 'active' AND ends_at <= v_now;

  SELECT * INTO v_active FROM coins.game_cycles WHERE status = 'active';
  IF FOUND THEN
    RETURN jsonb_build_object(
      'created', false, 'completed_count', 0,
      'apocalypse_id', v_active.apocalypse_id,
      'cycle_number',  v_active.cycle_number,
      'starts_at', v_active.starts_at, 'ends_at', v_active.ends_at);
  END IF;

  -- Anchor on the highest-numbered cycle (the head of the chain), not merely
  -- the latest ends_at: numbering must never collide even if history rows
  -- were repaired out of order.
  SELECT * INTO v_last FROM coins.game_cycles ORDER BY cycle_number DESC LIMIT 1;

  IF v_last IS NULL THEN
    -- First ever round: start on the aligned boundary (or immediately).
    v_start := CASE WHEN v_cfg.align_to_boundary
               THEN to_timestamp(floor(extract(epoch FROM v_now) / v_dur_s) * v_dur_s)
               ELSE v_now END;
  ELSE
    -- Continue contiguously from the last cycle's end so chain alignment is
    -- preserved and elapsed rounds can be back-filled below.
    v_start := v_last.ends_at;
  END IF;

  v_no := COALESCE(v_last.cycle_number, 0) + 1;

  -- Deterministic roll-forward: record every fully-elapsed cycle as
  -- completed until a fresh active round covers now.
  WHILE v_start + v_dur <= v_now LOOP
    INSERT INTO coins.game_cycles
      (cycle_number, apocalypse_id, seed, starts_at, ends_at, duration_ms, status)
    VALUES
      (v_no, 'APOC-' || lpad(v_no::text, 4, '0'),
       floor(random() * 2147483647)::bigint,
       v_start, v_start + v_dur, v_cfg.cycle_duration_ms, 'completed');
    v_no := v_no + 1;
    v_start := v_start + v_dur;
    v_rolled := v_rolled + 1;
    v_guard := v_guard + 1;
    IF v_guard >= c_max_catchup THEN
      v_start := CASE WHEN v_cfg.align_to_boundary
                 THEN to_timestamp(floor(extract(epoch FROM v_now) / v_dur_s) * v_dur_s)
                 ELSE v_now END;
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO coins.game_cycles
    (cycle_number, apocalypse_id, seed, starts_at, ends_at, duration_ms, status)
  VALUES
    (v_no, 'APOC-' || lpad(v_no::text, 4, '0'),
     floor(random() * 2147483647)::bigint,
     v_start, v_start + v_dur, v_cfg.cycle_duration_ms, 'active')
  RETURNING * INTO v_active;

  RETURN jsonb_build_object(
    'created', true, 'completed_count', v_rolled,
    'apocalypse_id', v_active.apocalypse_id,
    'cycle_number',  v_active.cycle_number,
    'starts_at', v_active.starts_at, 'ends_at', v_active.ends_at);
END $$;

-- ---------------------------------------------------------------------------
-- get_game_state() — public, self-healing read for browser polling.
-- Server time is the source of truth; clients never own the timer.
-- remaining_ms is never negative; apocalypse_pct is clamped to 0-100.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.get_game_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_c            coins.game_cycles%ROWTYPE;
  v_now          timestamptz;
  v_remaining_ms bigint;
  v_pct          numeric;
BEGIN
  -- Any read advances the cycle if needed: the game progresses even with no
  -- workers and no humans online, and recovers automatically after downtime.
  PERFORM coins.ensure_active_cycle();

  SELECT * INTO v_c FROM coins.game_cycles WHERE status = 'active';
  v_now := now();

  v_remaining_ms := GREATEST(
    0, floor(extract(epoch FROM (v_c.ends_at - v_now)) * 1000))::bigint;
  v_pct := LEAST(100, GREATEST(0, round(
    extract(epoch FROM (v_now - v_c.starts_at))
    / extract(epoch FROM (v_c.ends_at - v_c.starts_at)) * 100, 2)));

  RETURN jsonb_build_object(
    'apocalypse_id',  v_c.apocalypse_id,
    'cycle_number',   v_c.cycle_number,
    'seed',           v_c.seed,
    'starts_at',      v_c.starts_at,
    'ends_at',        v_c.ends_at,
    'duration_ms',    v_c.duration_ms,
    'server_time',    v_now,
    'remaining_ms',   v_remaining_ms,
    'apocalypse_pct', v_pct);
END $$;

-- ---------------------------------------------------------------------------
-- Grants + RLS (deny-by-default, then grant exactly what is needed)
-- ---------------------------------------------------------------------------
ALTER TABLE coins.game_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.game_config ENABLE ROW LEVEL SECURITY;

-- Round state is public game data (no user data) — same safe pattern as
-- coins.assets. Clients may read history; all writes go through functions.
GRANT SELECT ON coins.game_cycles TO anon, authenticated;
CREATE POLICY game_cycles_public_read ON coins.game_cycles
  FOR SELECT TO anon, authenticated USING (true);
-- game_config: no grants and no policies → internal/service only.

REVOKE ALL ON FUNCTION coins.ensure_active_cycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.get_game_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coins.get_game_state() TO anon, authenticated, coins_worker;
GRANT EXECUTE ON FUNCTION coins.ensure_active_cycle() TO coins_worker, service_role;

COMMIT;
