-- Crypto Chaos gameplay overhaul Wave 2 (SIM-06/07): durable per-cycle
-- market state — the market index, its monotonic peak, drawdown, recent
-- momentum, the hidden lifecycle state, and the per-cycle generated plateau
-- target.
-- Production DDL source of truth for the cycle-scoped market-state table
-- (apocalypse_market_state). Applied to the test database by db/seed.js so
-- tests share this exact DDL.
--
-- Design rules:
--   * apocalypse_market_state holds exactly ONE row per cycle
--     (UNIQUE (cycle_id) is the idempotency backstop): the deterministic
--     market index derived from the canonical surviving coin state, the
--     monotonic cycle peak and its timestamp, the drawdown from peak, the
--     recent momentum, the hidden lifecycle state
--     (GROWTH -> PLATEAU -> DECLINE -> COLLAPSE), and the plateau target
--     generated once from the cycle's persisted Core 1 seed. Restarts and
--     reconciliations observe and extend the persisted row — the plateau
--     target is never rerolled and the peak never resets.
--   * All index/peak/target values are non-negative NUMERIC(20, 8); the
--     drawdown is a fraction in [0, 1]; momentum is a fraction >= -1 (a
--     market can never lose more than 100% between evaluations). The peak
--     is database-enforced monotonic against both the starting and the
--     current index, and the generated plateau target can never sit below
--     the starting index (the plateauTargetMultiplier floor is >= 1).
--   * This table is internal-only: no public endpoint exposes it, and no
--     column here feeds users, portfolios, transactions, price history,
--     cash events, or coin-event rows. Market state is fully separate from
--     all of them (its own table, its own identity).
--   * Legacy coins/portfolios/transactions/price_history/cash-event tables
--     and every pre-existing object are never touched.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: only a NEW table is created; no row, column,
--     constraint or trigger of any existing table is dropped or rewritten.
--   * If the table already exists, its shape is verified explicitly. An
--     incompatible pre-existing table aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. apocalypse_market_state: one durable market-state row per cycle. The
--    UNIQUE (cycle_id) backstop makes concurrent/repeated reconciliation
--    idempotent by construction.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_cycles') IS NULL THEN
    RAISE EXCEPTION 'migration 021: apocalypse_cycles does not exist. Apply migration 007 first.';
  END IF;

  IF to_regclass('public.apocalypse_market_state') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('state_id',          'integer',                  'NO'),
        ('cycle_id',          'integer',                  'NO'),
        ('starting_index',    'numeric',                  'NO'),
        ('current_index',     'numeric',                  'NO'),
        ('peak_index',        'numeric',                  'NO'),
        ('peak_at',           'timestamp with time zone', 'NO'),
        ('drawdown',          'numeric',                  'NO'),
        ('momentum',          'numeric',                  'NO'),
        ('lifecycle_state',   'character varying',        'NO'),
        ('plateau_target',    'numeric',                  'NO'),
        ('last_evaluated_at', 'timestamp with time zone', 'NO'),
        ('created_at',        'timestamp with time zone', 'NO'),
        ('updated_at',        'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_market_state'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'state_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_market_state'
          AND c.column_name = 'state_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_market_state'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'updated_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_market_state'
          AND c.column_name = 'updated_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on state_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_market_state'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'state_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_state'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_state'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: lifecycle_state IN (GROWTH, PLATEAU, DECLINE, COLLAPSE)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_state'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%GROWTH%PLATEAU%DECLINE%COLLAPSE%'
      )
      UNION ALL
      SELECT 'missing check constraint: non-negative index values'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_state'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'starting_index >= \(?0'
          AND pg_get_constraintdef(oid) ~ 'current_index >= \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: drawdown in [0, 1]'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_state'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'drawdown >= \(?0'
          AND pg_get_constraintdef(oid) ~ 'drawdown <= \(?1'
      )
      UNION ALL
      SELECT 'missing check constraint: momentum >= -1'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_state'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'momentum >='
          AND pg_get_constraintdef(oid) ~ '-1'
      )
      UNION ALL
      SELECT 'missing check constraint: peak monotonicity (peak >= starting, peak >= current)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_state'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'peak_index >= starting_index'
          AND pg_get_constraintdef(oid) ~ 'peak_index >= current_index'
      )
      UNION ALL
      SELECT 'missing check constraint: plateau target never below the starting index'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_state'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'plateau_target >= starting_index'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 021: existing apocalypse_market_state table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_market_state (
      state_id          SERIAL PRIMARY KEY,
      cycle_id          INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      -- The market index at the first evaluation of this cycle (the cycle's
      -- opening combined value of surviving coins).
      starting_index    NUMERIC(20, 8) NOT NULL,
      -- The latest deterministic index evaluation.
      current_index     NUMERIC(20, 8) NOT NULL,
      -- The monotonic cycle peak: only ever lifted, never reset.
      peak_index        NUMERIC(20, 8) NOT NULL,
      -- When the current peak was first observed.
      peak_at           TIMESTAMPTZ NOT NULL,
      -- (peak - current) / peak; 0 at a new high, 1 when the market is gone.
      drawdown          NUMERIC(12, 8) NOT NULL,
      -- (current - previous evaluation) / previous evaluation; 0 when the
      -- previous evaluation was 0 (a zero base carries no momentum signal).
      momentum          NUMERIC(20, 8) NOT NULL,
      -- The hidden lifecycle state. Transitions are engine-enforced in
      -- legal order only (GROWTH -> PLATEAU -> DECLINE -> COLLAPSE).
      lifecycle_state   VARCHAR(8) NOT NULL CHECK (lifecycle_state IN ('GROWTH', 'PLATEAU', 'DECLINE', 'COLLAPSE')),
      -- The per-cycle generated plateau target index, drawn once from the
      -- cycle's persisted Core 1 seed and never rerolled.
      plateau_target    NUMERIC(20, 8) NOT NULL,
      last_evaluated_at TIMESTAMPTZ NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- The idempotency backstop: exactly one market-state row per cycle,
      -- ever. Recovery/restart never rerolls the generated target.
      UNIQUE (cycle_id),
      -- Index values are never negative, NaN or Infinity (NUMERIC storage
      -- rejects non-finite values; the sign is enforced here).
      CHECK (starting_index >= 0 AND current_index >= 0 AND peak_index >= 0 AND plateau_target >= 0),
      -- The peak is monotonic: it covers the starting index and can never
      -- sit below the current index.
      CHECK (peak_index >= starting_index AND peak_index >= current_index),
      -- Drawdown is a fraction of the peak.
      CHECK (drawdown >= 0 AND drawdown <= 1),
      -- A market can never lose more than 100% between evaluations.
      CHECK (momentum >= -1),
      -- The generated peak region never sits below the starting index
      -- (plateauTargetMultiplier.min >= 1 is config-enforced).
      CHECK (plateau_target >= starting_index)
    );
  END IF;
END $$;
