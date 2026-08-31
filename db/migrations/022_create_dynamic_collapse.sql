-- Crypto Chaos gameplay overhaul Wave 4 (SIM-13/14): the durable dynamic
-- collapse record — the SINGLE death authority replacing the retired fixed
-- scheduled-collapse controller (game/collapseScheduleService.js, removed in
-- the same wave).
-- Production DDL source of truth for the cycle-scoped coin-collapse table
-- (apocalypse_coin_collapses). Applied to the test database by db/seed.js so
-- tests share this exact DDL.
--
-- Design rules:
--   * apocalypse_coin_collapses holds exactly ONE row per (cycle, coin),
--     written ONLY at the moment of death by the dynamic collapse engine
--     (game/dynamicCollapseService.js): there are no future-dated rows and
--     no pre-committed order. A row's existence IS the death record — death
--     is never inferred from current_price === 0 and never held in memory.
--   * collapse_rank is the EXECUTION ORDER within the cycle (0 for the first
--     coin to die, assigned at death time), not a pre-assigned schedule
--     rank. collapsed_at is the authoritative death instant (the real
--     execution time for dynamic mid-cycle deaths, exactly the cycle's
--     end_time for the final all-coins-£0 safety reconciliation during
--     settlement).
--   * UNIQUE (cycle_id, coin_id) is the idempotency/resurrection backstop:
--     a coin can die at most once per cycle, across restarts, replays and
--     any number of processes (all inserts run inside the caller's Core 1
--     advisory-locked transaction, lock key 727001). UNIQUE (cycle_id,
--     collapse_rank) keeps the execution order unambiguous.
--   * This table is internal-only: no public endpoint exposes it, and no
--     column here feeds users, portfolios, transactions, price-history
--     semantics, cash events, or coin-event rows.
--   * The legacy coin_collapse_schedule table (migration 008) is left in
--     place untouched: its historical production rows are preserved data.
--     It is simply no longer written or consulted by any runtime path —
--     the old fixed future-timestamp scheduler is retired.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive and additive: only a NEW table is created; no
--     row, column, constraint or trigger of any existing table is dropped,
--     rewritten or backfilled.
--   * If the table already exists, its shape is verified explicitly. An
--     incompatible pre-existing table aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. apocalypse_coin_collapses: one durable death record per (cycle, coin).
--    Rows exist only for coins that have actually died; the UNIQUE
--    constraints are the idempotency and no-resurrection backstops.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_cycles') IS NULL THEN
    RAISE EXCEPTION 'migration 022: apocalypse_cycles does not exist. Apply migration 007 first.';
  END IF;
  IF to_regclass('public.coins') IS NULL THEN
    RAISE EXCEPTION 'migration 022: coins does not exist. Apply the base schema first.';
  END IF;

  IF to_regclass('public.apocalypse_coin_collapses') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('collapse_id',   'integer',                  'NO'),
        ('cycle_id',      'integer',                  'NO'),
        ('coin_id',       'integer',                  'NO'),
        ('collapse_rank', 'integer',                  'NO'),
        ('collapsed_at',  'timestamp with time zone', 'NO'),
        ('created_at',    'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_coin_collapses'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'collapse_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_coin_collapses'
          AND c.column_name = 'collapse_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_coin_collapses'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on collapse_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_coin_collapses'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'collapse_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, coin_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_collapses'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, coin_id)%'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, collapse_rank)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_collapses'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, collapse_rank)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_collapses'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key coin_id -> coins'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_collapses'::regclass
          AND contype = 'f'
          AND confrelid = 'public.coins'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (coin_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: collapse_rank >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_collapses'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'collapse_rank >= \(?0'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 022: existing apocalypse_coin_collapses table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_coin_collapses (
      collapse_id   SERIAL PRIMARY KEY,
      cycle_id      INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      coin_id       INTEGER NOT NULL REFERENCES coins(coin_id),
      -- The EXECUTION ORDER within the cycle (0 = first coin to die),
      -- assigned at death time. Not a pre-assigned schedule rank.
      collapse_rank INTEGER NOT NULL,
      -- The authoritative death instant: the real execution time for a
      -- dynamic mid-cycle death; exactly the cycle's end_time for the
      -- settlement-time all-coins-£0 safety reconciliation.
      collapsed_at  TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- A coin dies at most once per cycle, ever (no resurrection, no
      -- duplicate execution across restarts/processes).
      UNIQUE (cycle_id, coin_id),
      -- The execution order is unambiguous within a cycle.
      UNIQUE (cycle_id, collapse_rank),
      CHECK (collapse_rank >= 0)
    );
  END IF;
END $$;
