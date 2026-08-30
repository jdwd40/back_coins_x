-- Crypto Chaos gameplay overhaul Wave 1 (SIM-03/04/05): server-authoritative
-- coin events and market phases.
-- Production DDL source of truth for the cycle-scoped coin-event table
-- (apocalypse_coin_events) and the cycle-scoped market-phase chain table
-- (apocalypse_market_phases). Applied to the test database by db/seed.js so
-- tests share this exact DDL.
--
-- Design rules:
--   * apocalypse_coin_events persists every coin event of a cycle, derived
--     deterministically from the cycle's persisted Core 1 seed at cycle
--     start (same pattern as Core 3's coin_collapse_schedule and #18's
--     apocalypse_economy_events): restarts observe and reuse the persisted
--     rows — they never reroll. UNIQUE (cycle_id, coin_id, event_seq) is
--     the idempotency backstop. Rows are never updated or deleted: expiry
--     is purely time-based (starts_at / ends_at), so an expired event can
--     never be resurrected and an active event is never mutated underneath
--     a reader. Event state is fully separate from portfolio, trade,
--     price-history and cash-event data (its own table, its own identity).
--   * apocalypse_market_phases persists the cycle's primary market-phase
--     chain: exactly one phase covers any instant of the cycle. The chain
--     is contiguous by construction (phase N+1 starts exactly at phase N's
--     ends_at) and UNIQUE (cycle_id, phase_seq) is the identity backstop,
--     so a reconcile/lookup can never create two overlapping primary
--     phases. lifecycle_state records the hidden lifecycle input used for
--     the weighted draw (Wave 1 always GROWTH; SIM-07 supplies the real
--     state). Both tables are internal-only: no public endpoint exposes
--     them in Wave 1, and future schedule rows are never player-facing.
--   * Modifier signs are database-enforced to match the event direction /
--     phase group, so a sign-flipped row is impossible to persist.
--   * Legacy coins/portfolios/transactions/price_history/cash-event tables
--     and every pre-existing object are never touched.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: only NEW tables/indexes are created; no row,
--     column, constraint or trigger of any existing table is dropped or
--     rewritten.
--   * If any of these objects already exists, its shape is verified
--     explicitly. An incompatible pre-existing object aborts the migration
--     with a clear error instead of being silently accepted by
--     CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. apocalypse_coin_events: the persisted, deterministic per-cycle coin
--    event schedule (0-5 active per coin, 1-15 minute durations, positive
--    and negative events coexist and stack). One row per
--    (cycle_id, coin_id, event_seq) — the idempotency backstop.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_cycles') IS NULL THEN
    RAISE EXCEPTION 'migration 020: apocalypse_cycles does not exist. Apply migration 007 first.';
  END IF;
  IF to_regclass('public.coins') IS NULL THEN
    RAISE EXCEPTION 'migration 020: coins does not exist. Apply the core schema first.';
  END IF;

  IF to_regclass('public.apocalypse_coin_events') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('event_id',          'integer',                  'NO'),
        ('cycle_id',          'integer',                  'NO'),
        ('coin_id',           'integer',                  'NO'),
        ('event_seq',         'integer',                  'NO'),
        ('name',              'character varying',        'NO'),
        ('direction',         'character varying',        'NO'),
        ('strength_category', 'character varying',        'NO'),
        ('modifier',          'numeric',                  'NO'),
        ('starts_at',         'timestamp with time zone', 'NO'),
        ('ends_at',           'timestamp with time zone', 'NO'),
        ('created_at',        'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_coin_events'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'event_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_coin_events'
          AND c.column_name = 'event_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_coin_events'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on event_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_coin_events'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'event_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, coin_id, event_seq)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_events'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, coin_id, event_seq)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_events'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key coin_id -> coins'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_events'::regclass
          AND contype = 'f'
          AND confrelid = 'public.coins'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (coin_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: direction IN (POSITIVE, NEGATIVE)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%direction%POSITIVE%NEGATIVE%'
      )
      UNION ALL
      SELECT 'missing check constraint: strength_category IN (MINOR, MODERATE, MAJOR, EXTREME)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%MINOR%MODERATE%MAJOR%EXTREME%'
      )
      UNION ALL
      SELECT 'missing check constraint: event_seq >= 1'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'event_seq >= \(?1'
      )
      UNION ALL
      SELECT 'missing check constraint: ends_at > starts_at'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'ends_at > starts_at'
      )
      UNION ALL
      SELECT 'missing check constraint: modifier sign matches direction'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_coin_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%POSITIVE%modifier%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 020: existing apocalypse_coin_events table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_coin_events (
      event_id          SERIAL PRIMARY KEY,
      cycle_id          INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      coin_id           INTEGER NOT NULL REFERENCES coins(coin_id),
      event_seq         INTEGER NOT NULL CHECK (event_seq >= 1),
      name              VARCHAR(100) NOT NULL,
      direction         VARCHAR(8) NOT NULL CHECK (direction IN ('POSITIVE', 'NEGATIVE')),
      strength_category VARCHAR(8) NOT NULL CHECK (strength_category IN ('MINOR', 'MODERATE', 'MAJOR', 'EXTREME')),
      modifier          NUMERIC(12, 8) NOT NULL,
      starts_at         TIMESTAMPTZ NOT NULL,
      ends_at           TIMESTAMPTZ NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- The idempotency backstop: one row per deterministic event identity,
      -- ever. Recovery/restart never rerolls.
      UNIQUE (cycle_id, coin_id, event_seq),
      CHECK (ends_at > starts_at),
      -- The persisted modifier sign always matches its direction.
      CHECK ((direction = 'POSITIVE' AND modifier > 0) OR (direction = 'NEGATIVE' AND modifier < 0))
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. apocalypse_market_phases: the persisted primary market-phase chain.
--    One row per (cycle_id, phase_seq); the chain is contiguous by
--    construction, so exactly one primary phase covers any instant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_market_phases') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('phase_id',        'integer',                  'NO'),
        ('cycle_id',        'integer',                  'NO'),
        ('phase_seq',       'integer',                  'NO'),
        ('phase',           'character varying',        'NO'),
        ('lifecycle_state', 'character varying',        'NO'),
        ('modifier',        'numeric',                  'NO'),
        ('starts_at',       'timestamp with time zone', 'NO'),
        ('ends_at',         'timestamp with time zone', 'NO'),
        ('created_at',      'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_market_phases'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'phase_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_market_phases'
          AND c.column_name = 'phase_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_market_phases'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on phase_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_market_phases'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'phase_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, phase_seq)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_phases'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, phase_seq)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_phases'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: phase IN (GOLDEN_AGE, BOOM, BULL, BEAR, BUST, RECESSION)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_phases'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%GOLDEN_AGE%BOOM%BULL%BEAR%BUST%RECESSION%'
      )
      UNION ALL
      SELECT 'missing check constraint: lifecycle_state IN (GROWTH, PLATEAU, DECLINE, COLLAPSE)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_phases'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%GROWTH%PLATEAU%DECLINE%COLLAPSE%'
      )
      UNION ALL
      SELECT 'missing check constraint: phase_seq >= 1'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_phases'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'phase_seq >= \(?1'
      )
      UNION ALL
      SELECT 'missing check constraint: ends_at > starts_at'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_phases'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'ends_at > starts_at'
      )
      UNION ALL
      SELECT 'missing check constraint: modifier sign matches phase group'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_market_phases'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%GOLDEN_AGE%modifier%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 020: existing apocalypse_market_phases table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_market_phases (
      phase_id        SERIAL PRIMARY KEY,
      cycle_id        INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      phase_seq       INTEGER NOT NULL CHECK (phase_seq >= 1),
      phase           VARCHAR(12) NOT NULL CHECK (phase IN ('GOLDEN_AGE', 'BOOM', 'BULL', 'BEAR', 'BUST', 'RECESSION')),
      lifecycle_state VARCHAR(8) NOT NULL CHECK (lifecycle_state IN ('GROWTH', 'PLATEAU', 'DECLINE', 'COLLAPSE')),
      modifier        NUMERIC(12, 8) NOT NULL,
      starts_at       TIMESTAMPTZ NOT NULL,
      ends_at         TIMESTAMPTZ NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- The idempotency/one-primary backstop: one row per chain position.
      UNIQUE (cycle_id, phase_seq),
      CHECK (ends_at > starts_at),
      -- The persisted modifier sign always matches its phase group.
      CHECK ((phase IN ('GOLDEN_AGE', 'BOOM', 'BULL') AND modifier > 0)
          OR (phase IN ('BEAR', 'BUST', 'RECESSION') AND modifier < 0))
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Lookup indexes. Same-named pre-existing indexes must be exactly these
--    indexes; anything else is an incompatibility and aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_coin_events_active') THEN
    -- Exact shape verification: a non-unique btree on exactly the ordered
    -- key list (cycle_id, coin_id, ends_at). The ordered indkey is mapped
    -- to column names and compared as a whole, so a wrong same-named
    -- index (e.g. (cycle_id, created_at), a unique index, or a
    -- reordered/extra-key index) is rejected.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'idx_apocalypse_coin_events_active'
        AND c.relnamespace = 'public'::regnamespace
        AND i.indrelid = 'public.apocalypse_coin_events'::regclass
        AND am.amname = 'btree'
        AND NOT i.indisunique
        AND (
          SELECT string_agg(a.attname, ',' ORDER BY k.n)
          FROM generate_series(0, i.indnkeyatts - 1) AS k(n)
          JOIN pg_attribute a
            ON a.attrelid = i.indrelid
           AND a.attnum = i.indkey[k.n]
        ) = 'cycle_id,coin_id,ends_at'
    ) THEN
      RAISE EXCEPTION 'migration 020: existing index idx_apocalypse_coin_events_active is INCOMPATIBLE (expected a non-unique index on (cycle_id, coin_id, ends_at)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_coin_events_active ON apocalypse_coin_events (cycle_id, coin_id, ends_at);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_market_phases_active') THEN
    -- Exact shape verification: a non-unique btree on exactly the ordered
    -- key list (cycle_id, starts_at). Same catalog-exact pattern as the
    -- coin-events lookup index above.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'idx_apocalypse_market_phases_active'
        AND c.relnamespace = 'public'::regnamespace
        AND i.indrelid = 'public.apocalypse_market_phases'::regclass
        AND am.amname = 'btree'
        AND NOT i.indisunique
        AND (
          SELECT string_agg(a.attname, ',' ORDER BY k.n)
          FROM generate_series(0, i.indnkeyatts - 1) AS k(n)
          JOIN pg_attribute a
            ON a.attrelid = i.indrelid
           AND a.attnum = i.indkey[k.n]
        ) = 'cycle_id,starts_at'
    ) THEN
      RAISE EXCEPTION 'migration 020: existing index idx_apocalypse_market_phases_active is INCOMPATIBLE (expected a non-unique index on (cycle_id, starts_at)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_market_phases_active ON apocalypse_market_phases (cycle_id, starts_at);
  END IF;
END $$;
