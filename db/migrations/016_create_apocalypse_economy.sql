-- Crypto Chaos issue #18: passive economic pressure — the durable cash-event
-- ledger (apocalypse_cash_events), the durable fee/tax tick claims
-- (apocalypse_economy_ticks), and the persisted deterministic Apocalypse
-- event schedule (apocalypse_economy_events).
-- Production DDL source of truth for the economy schema.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- Design rules:
--   * apocalypse_participants.current_cash remains the authoritative balance;
--     apocalypse_cash_events is the EXPLANATORY ledger: every FEE/TAX/EVENT
--     debit is recorded with amount, balance_before, balance_after, a
--     human-readable description and its durable logical identity
--     (event_key). The UNIQUE (cycle_id, participant_id, type, event_key)
--     constraint is the database backstop that makes every logical debit
--     idempotent across retries, restarts, duplicate workers and concurrent
--     processes.
--   * apocalypse_economy_ticks is the durable duplicate-tick authority for
--     the recurring fee/tax cadences (same claim pattern as Core 5's
--     apocalypse_bot_ticks): one row per (cycle_id, kind, tick_id), claimed
--     with INSERT ... ON CONFLICT DO NOTHING inside the advisory-locked
--     economy transaction, so a given tick charges at most once.
--   * apocalypse_economy_events persists the per-cycle event schedule
--     derived deterministically from the cycle's Core 1 seed at cycle start
--     (same pattern as Core 3's coin_collapse_schedule): restarts observe
--     and reuse the persisted rows — they never reroll. executed_at NULL +
--     the partial due index mark pending events; execution stamps
--     executed_at with a guarded UPDATE. Future schedule rows are internal
--     only and are never exposed through any public endpoint.
--   * Legacy users.funds, apocalypse_transactions (the BUY/SELL trade
--     ledger) and every pre-existing table are never touched.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: only NEW tables/indexes are created; no row,
--     column, constraint or trigger of any existing table is dropped or
--     rewritten.
--   * If any economy object already exists, its shape is verified
--     explicitly. An incompatible pre-existing object aborts the migration
--     with a clear error instead of being silently accepted by
--     CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. apocalypse_cash_events: the durable explanatory ledger. Exactly one row
--    per (cycle_id, participant_id, type, event_key) — the idempotency
--    backstop. amount is always the ACTUAL debit applied (a debit clamps at
--    the participant's available cash, never driving it negative), and the
--    balance chain is database-enforced:
--    balance_after = balance_before - amount.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_participants') IS NULL THEN
    RAISE EXCEPTION 'migration 016: apocalypse_participants does not exist. Apply migration 009 first.';
  END IF;

  IF to_regclass('public.apocalypse_cash_events') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('cash_event_id',  'integer',                  'NO'),
        ('participant_id', 'integer',                  'NO'),
        ('cycle_id',       'integer',                  'NO'),
        ('user_id',        'integer',                  'NO'),
        ('type',           'character varying',        'NO'),
        ('amount',         'numeric',                  'NO'),
        ('balance_before', 'numeric',                  'NO'),
        ('balance_after',  'numeric',                  'NO'),
        ('description',    'character varying',        'NO'),
        ('event_key',      'character varying',        'NO'),
        ('created_at',     'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_cash_events'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'cash_event_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_cash_events'
          AND c.column_name = 'cash_event_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_cash_events'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on cash_event_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_cash_events'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'cash_event_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, participant_id, type, event_key)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cash_events'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, participant_id, type, event_key)%'
      )
      UNION ALL
      SELECT 'missing composite foreign key (participant_id, cycle_id, user_id) -> apocalypse_participants'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cash_events'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_participants'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (participant_id, cycle_id, user_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: type IN (FEE, TAX, EVENT)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cash_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%FEE%TAX%EVENT%'
      )
      UNION ALL
      SELECT 'missing check constraint: amount > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cash_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'amount > \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: balance_before >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cash_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'balance_before >= \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: balance_after >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cash_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'balance_after >= \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: balance_after = balance_before - amount'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cash_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%balance_after%balance_before%amount%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 016: existing apocalypse_cash_events table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_cash_events (
      cash_event_id  SERIAL PRIMARY KEY,
      participant_id INTEGER NOT NULL,
      cycle_id       INTEGER NOT NULL,
      user_id        INTEGER NOT NULL,
      type           VARCHAR(5) NOT NULL CHECK (type IN ('FEE', 'TAX', 'EVENT')),
      amount         DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
      balance_before DECIMAL(18, 2) NOT NULL CHECK (balance_before >= 0),
      balance_after  DECIMAL(18, 2) NOT NULL CHECK (balance_after >= 0),
      description    VARCHAR(200) NOT NULL,
      event_key      VARCHAR(40) NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- The idempotency backstop: one ledger row per logical debit, ever.
      UNIQUE (cycle_id, participant_id, type, event_key),
      -- The ledger row must explain its own mutation exactly.
      CHECK (balance_after = balance_before - amount),
      FOREIGN KEY (participant_id, cycle_id, user_id)
        REFERENCES apocalypse_participants (participant_id, cycle_id, user_id)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. apocalypse_economy_ticks: durable fee/tax tick claims — the duplicate-
--    tick authority (Core 5 apocalypse_bot_ticks pattern). One row per
--    (cycle_id, kind, tick_id); claiming is INSERT ... ON CONFLICT DO
--    NOTHING inside the advisory-locked economy transaction, so retries,
--    restarts and multiple processes can never charge the same tick twice.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_economy_ticks') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('tick_pk',     'integer',                  'NO'),
        ('cycle_id',    'integer',                  'NO'),
        ('kind',        'character varying',        'NO'),
        ('tick_id',     'bigint',                   'NO'),
        ('executed_at', 'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_economy_ticks'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'tick_pk is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_economy_ticks'
          AND c.column_name = 'tick_pk'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'executed_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_economy_ticks'
          AND c.column_name = 'executed_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on tick_pk'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_economy_ticks'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'tick_pk'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, kind, tick_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_economy_ticks'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, kind, tick_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_economy_ticks'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: kind IN (FEE, TAX)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_economy_ticks'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%FEE%TAX%'
      )
      UNION ALL
      SELECT 'missing check constraint: tick_id >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_economy_ticks'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'tick_id >= \(?0'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 016: existing apocalypse_economy_ticks table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_economy_ticks (
      tick_pk     SERIAL PRIMARY KEY,
      cycle_id    INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      kind        VARCHAR(4) NOT NULL CHECK (kind IN ('FEE', 'TAX')),
      tick_id     BIGINT NOT NULL CHECK (tick_id >= 0),
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (cycle_id, kind, tick_id)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. apocalypse_economy_events: the persisted, deterministic per-cycle
--    Apocalypse event schedule (Core 3 coin_collapse_schedule pattern).
--    Rows are derived from the cycle's persisted Core 1 seed at cycle start
--    and never rerolled; execution stamps executed_at exactly once via a
--    guarded UPDATE. The schedule is internal-only: future rows are never
--    exposed by any public endpoint.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_economy_events') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('event_pk',     'integer',                  'NO'),
        ('cycle_id',     'integer',                  'NO'),
        ('event_key',    'character varying',        'NO'),
        ('scheduled_at', 'timestamp with time zone', 'NO'),
        ('amount',       'numeric',                  'NO'),
        ('description',  'character varying',        'NO'),
        ('executed_at',  'timestamp with time zone', 'YES'),
        ('created_at',   'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_economy_events'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'event_pk is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_economy_events'
          AND c.column_name = 'event_pk'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_economy_events'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on event_pk'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_economy_events'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'event_pk'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, event_key)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_economy_events'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, event_key)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_economy_events'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: amount > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_economy_events'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'amount > \(?0'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 016: existing apocalypse_economy_events table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_economy_events (
      event_pk     SERIAL PRIMARY KEY,
      cycle_id     INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      event_key    VARCHAR(40) NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      amount       DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
      description  VARCHAR(200) NOT NULL,
      executed_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (cycle_id, event_key)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Lookup indexes. Same-named pre-existing indexes must be exactly these
--    indexes; anything else is an incompatibility and aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_cash_events_cycle') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'idx_apocalypse_cash_events_cycle'
        AND i.indrelid = 'public.apocalypse_cash_events'::regclass
        AND NOT i.indisunique
        AND a.attname = 'cycle_id'
    ) THEN
      RAISE EXCEPTION 'migration 016: existing index idx_apocalypse_cash_events_cycle is INCOMPATIBLE (expected a non-unique index on (cycle_id)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_cash_events_cycle ON apocalypse_cash_events (cycle_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_cash_events_participant') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'idx_apocalypse_cash_events_participant'
        AND i.indrelid = 'public.apocalypse_cash_events'::regclass
        AND NOT i.indisunique
        AND a.attname = 'participant_id'
    ) THEN
      RAISE EXCEPTION 'migration 016: existing index idx_apocalypse_cash_events_participant is INCOMPATIBLE (expected a non-unique index on (participant_id)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_cash_events_participant ON apocalypse_cash_events (participant_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_economy_events_due') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'idx_apocalypse_economy_events_due'
        AND i.indrelid = 'public.apocalypse_economy_events'::regclass
        AND NOT i.indisunique
        AND a.attname = 'scheduled_at'
        AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%executed_at IS NULL%'
    ) THEN
      RAISE EXCEPTION 'migration 016: existing index idx_apocalypse_economy_events_due is INCOMPATIBLE (expected a non-unique partial index on (scheduled_at) WHERE executed_at IS NULL). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_economy_events_due ON apocalypse_economy_events (scheduled_at) WHERE executed_at IS NULL;
  END IF;
END $$;
