-- Director Coin Events Wave 1: persistent-world coin-event authority and
-- Director short-term runtime/control state.
-- Production DDL source of truth for the persistent_coin_events and
-- director_control_state tables. Applied to the test database by db/seed.js
-- so tests share this exact DDL.
--
-- Design rules:
--   * persistent_coin_events is the PERSISTENT-WORLD coin-event authority,
--     deliberately separate from the cycle-scoped apocalypse_coin_events
--     (migration 020). Rows are world-scoped (FK market_worlds) and
--     catalogue-scoped (FK coins); NOTHING here references any apocalypse_*
--     table or cycle. Event identity is per-world/per-coin sequence:
--     UNIQUE (world_id, coin_id, event_seq) is the replay/idempotency
--     backstop — restarts and repeated reconciliations observe persisted
--     rows and never reroll them. Rows are never updated or deleted:
--     expiry is purely time-based (starts_at / ends_at), so expired history
--     is preserved forever and an active event is never mutated underneath
--     a reader.
--   * Every event carries a public name, a direction (POSITIVE/NEGATIVE),
--     a source spanning the full NORMAL/GOLDEN/DEMON/RESCUE/DIRECTOR
--     vocabulary, and a signed bounded modifier whose sign is
--     database-enforced to match its direction. The structural bound
--     (|modifier| < 1) rejects impossible rows; the tighter configured
--     bound (simulationConfig persistentEvents.maxIndividualModifier) is
--     enforced by the model layer before SQL.
--   * director_control_state is the persisted Director SHORT-TERM
--     runtime/control state — the NORMAL/BOOM/BUST/RESCUE intervention
--     cursor. It is fully SEPARATE from market_director_state (the
--     deterministic six-regime Director cursor, migration 025): nothing
--     here alters, repurposes or reads that table. One row per world
--     carries the current intervention mode/direction/intensity, its
--     window, the idempotent decision cursor (decision_index), the
--     decision reason, the Golden/Demon assignments with their expiries
--     (never the same coin), the last broad swing direction, and the
--     stagnation tracking timestamp — everything a restarted Director
--     runtime needs to resume safely. Internal-only: no public endpoint
--     exposes any of it.
--   * Legacy Apocalypse tables (apocalypse_*) remain untouched historical /
--     archive data. Nothing in this migration reads, writes, renames or
--     drops them.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive and additive: only NEW tables/indexes are
--     created; no row, column, constraint or trigger of any existing table
--     is dropped, rewritten or backfilled.
--   * If any of these objects already exists, its shape is verified
--     explicitly. An incompatible pre-existing object aborts the migration
--     with a clear error instead of being silently accepted by
--     CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. persistent_coin_events: the world-scoped persistent coin-event
--    authority. One row per (world_id, coin_id, event_seq) — the
--    idempotency backstop.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.market_worlds') IS NULL THEN
    RAISE EXCEPTION 'migration 029: market_worlds does not exist. Apply migration 024 first.';
  END IF;
  IF to_regclass('public.coins') IS NULL THEN
    RAISE EXCEPTION 'migration 029: coins does not exist. Apply the core schema first.';
  END IF;

  IF to_regclass('public.persistent_coin_events') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: persistent_coin_events.' || expected.name AS problem
      FROM (VALUES
        ('event_id',   'integer',                  'NO'),
        ('world_id',   'integer',                  'NO'),
        ('coin_id',    'integer',                  'NO'),
        ('event_seq',  'integer',                  'NO'),
        ('name',       'character varying',        'NO'),
        ('direction',  'character varying',        'NO'),
        ('source',     'character varying',        'NO'),
        ('modifier',   'numeric',                  'NO'),
        ('starts_at',  'timestamp with time zone', 'NO'),
        ('ends_at',    'timestamp with time zone', 'NO'),
        ('created_at', 'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_coin_events'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'event_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_coin_events'
          AND c.column_name = 'event_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_coin_events'
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
          AND tc.table_name = 'persistent_coin_events'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'event_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (world_id, coin_id, event_seq)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (world_id, coin_id, event_seq)%'
      )
      UNION ALL
      SELECT 'missing foreign key world_id -> market_worlds'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'f'
          AND confrelid = 'public.market_worlds'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (world_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key coin_id -> coins'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'f'
          AND confrelid = 'public.coins'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (coin_id)%'
      )
      -- Every CHECK the DDL below creates is verified by EXACT constraint
      -- name AND a semantic definition predicate. The name pins the
      -- contract (a pre-existing table that carries the right semantics
      -- under different names is still flagged — rename it explicitly);
      -- the predicate proves the named constraint carries the intended
      -- semantics. In particular the standalone DIRECTION VOCABULARY
      -- constraint must not mention the modifier: the modifier sign-match
      -- constraint alone (which names direction/POSITIVE/NEGATIVE) can
      -- never satisfy it.
      UNION ALL
      SELECT 'missing or incompatible check constraint: persistent_coin_events_direction_known (direction vocabulary)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'c'
          AND conname = 'persistent_coin_events_direction_known'
          AND pg_get_constraintdef(oid) ILIKE '%direction%'
          AND pg_get_constraintdef(oid) ILIKE '%POSITIVE%'
          AND pg_get_constraintdef(oid) ILIKE '%NEGATIVE%'
          AND pg_get_constraintdef(oid) NOT ILIKE '%modifier%'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: persistent_coin_events_source_known (source vocabulary)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'c'
          AND conname = 'persistent_coin_events_source_known'
          AND pg_get_constraintdef(oid) ILIKE '%source%'
          AND pg_get_constraintdef(oid) ILIKE '%NORMAL%GOLDEN%DEMON%RESCUE%DIRECTOR%'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: persistent_coin_events_event_seq_positive (event_seq >= 1)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'c'
          AND conname = 'persistent_coin_events_event_seq_positive'
          AND pg_get_constraintdef(oid) ~ 'event_seq >= \(?1'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: persistent_coin_events_window_positive (ends_at > starts_at)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'c'
          AND conname = 'persistent_coin_events_window_positive'
          AND pg_get_constraintdef(oid) ~ 'ends_at > starts_at'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: persistent_coin_events_modifier_sign_matches_direction'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'c'
          AND conname = 'persistent_coin_events_modifier_sign_matches_direction'
          AND pg_get_constraintdef(oid) ILIKE '%direction%'
          AND pg_get_constraintdef(oid) ILIKE '%POSITIVE%'
          AND pg_get_constraintdef(oid) ILIKE '%modifier%'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: persistent_coin_events_modifier_bounded (|modifier| < 1)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_coin_events'::regclass
          AND contype = 'c'
          AND conname = 'persistent_coin_events_modifier_bounded'
          AND pg_get_constraintdef(oid) ~ 'modifier.*(-)?1'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 029: existing persistent_coin_events table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;

    RAISE NOTICE 'migration 029: persistent_coin_events already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.persistent_coin_events (
      event_id   SERIAL PRIMARY KEY,
      -- The persistent world this event belongs to (world-scoped authority;
      -- never cycle-scoped).
      world_id   INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      coin_id    INTEGER NOT NULL REFERENCES public.coins (coin_id),
      -- Per-world/per-coin sequence identity (>= 1). Together with the
      -- UNIQUE below this is the replay/idempotency backstop.
      event_seq  INTEGER NOT NULL,
      -- The public event name.
      name       VARCHAR(100) NOT NULL,
      direction  VARCHAR(8) NOT NULL,
      -- The event source/category: NORMAL market events, Director-driven
      -- GOLDEN/DEMON assignments, RESCUE interventions and DIRECTOR broad
      -- swings all share this one authority.
      source     VARCHAR(8) NOT NULL,
      -- The signed price modifier. Structurally bounded (|modifier| < 1);
      -- the tighter configured bound lives in the model layer
      -- (simulationConfig persistentEvents.maxIndividualModifier).
      modifier   NUMERIC(12, 8) NOT NULL,
      starts_at  TIMESTAMPTZ NOT NULL,
      ends_at    TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- The idempotency backstop: one row per deterministic event identity,
      -- ever. Recovery/restart never rerolls.
      UNIQUE (world_id, coin_id, event_seq),
      -- All CHECKs are EXPLICITLY NAMED: the existing-table compatibility
      -- probe above and db/verify-game-schema.js pin these names, so the
      -- standalone direction vocabulary constraint can never be satisfied
      -- by the modifier sign-match constraint (or vice versa).
      CONSTRAINT persistent_coin_events_event_seq_positive CHECK (event_seq >= 1),
      CONSTRAINT persistent_coin_events_direction_known CHECK (direction IN ('POSITIVE', 'NEGATIVE')),
      CONSTRAINT persistent_coin_events_source_known CHECK (source IN ('NORMAL', 'GOLDEN', 'DEMON', 'RESCUE', 'DIRECTOR')),
      CONSTRAINT persistent_coin_events_window_positive CHECK (ends_at > starts_at),
      -- The persisted modifier sign always matches its direction.
      CONSTRAINT persistent_coin_events_modifier_sign_matches_direction CHECK (
        (direction = 'POSITIVE' AND modifier > 0) OR (direction = 'NEGATIVE' AND modifier < 0)
      ),
      -- Structurally impossible magnitudes are unwritable.
      CONSTRAINT persistent_coin_events_modifier_bounded CHECK (modifier > -1 AND modifier < 1)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. director_control_state: the persisted Director short-term
--    runtime/control state — exactly one row per world, fully separate
--    from market_director_state (the deterministic six-regime cursor).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.market_worlds') IS NULL THEN
    RAISE EXCEPTION 'migration 029: market_worlds does not exist. Apply migration 024 first.';
  END IF;
  IF to_regclass('public.coins') IS NULL THEN
    RAISE EXCEPTION 'migration 029: coins does not exist. Apply the core schema first.';
  END IF;

  IF to_regclass('public.director_control_state') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: director_control_state.' || expected.name AS problem
      FROM (VALUES
        ('world_id',                   'integer',                  'NO'),
        ('mode',                       'character varying',        'NO'),
        ('direction',                  'character varying',        'NO'),
        ('intensity',                  'double precision',         'NO'),
        ('started_at',                 'timestamp with time zone', 'NO'),
        ('ends_at',                    'timestamp with time zone', 'NO'),
        ('decision_index',             'integer',                  'NO'),
        ('reason',                     'text',                     'NO'),
        ('golden_coin_id',             'integer',                  'YES'),
        ('golden_expires_at',          'timestamp with time zone', 'YES'),
        ('demon_coin_id',              'integer',                  'YES'),
        ('demon_expires_at',           'timestamp with time zone', 'YES'),
        ('last_swing_direction',       'character varying',        'YES'),
        ('last_meaningful_movement_at','timestamp with time zone', 'YES'),
        ('created_at',                 'timestamp with time zone', 'NO'),
        ('updated_at',                 'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'director_control_state'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'missing primary key on (world_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'director_control_state'
          AND tc.constraint_type = 'PRIMARY KEY'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'director_control_state'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'updated_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'director_control_state'
          AND c.column_name = 'updated_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing foreign key world_id -> market_worlds'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_control_state'::regclass
          AND contype = 'f'
          AND confrelid = 'public.market_worlds'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (world_id)%'
      )
      UNION ALL
      -- Every CHECK the DDL below creates is NAMED; all nine names must be
      -- present exactly. An unnamed (or differently named) check — however
      -- close its definition — is an incompatibility, never silently
      -- accepted.
      SELECT 'missing or renamed check constraint: ' || expected.conname
      FROM (VALUES
        ('director_control_state_mode_known'),
        ('director_control_state_direction_known'),
        ('director_control_state_intensity_bounded'),
        ('director_control_state_decision_index_nonneg'),
        ('director_control_state_window_positive'),
        ('director_control_state_golden_consistent'),
        ('director_control_state_demon_consistent'),
        ('director_control_state_golden_demon_distinct'),
        ('director_control_state_last_swing_known')
      ) AS expected(conname)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.director_control_state'::regclass
          AND c.contype = 'c'
          AND c.conname = expected.conname
      )
      UNION ALL
      SELECT 'missing check constraint: mode IN (NORMAL, BOOM, BUST, RESCUE)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_control_state'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%NORMAL%BOOM%BUST%RESCUE%'
      )
      UNION ALL
      SELECT 'missing check constraint: golden and demon are never identical'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_control_state'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%golden_coin_id%demon_coin_id%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 029: existing director_control_state table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;

    RAISE NOTICE 'migration 029: director_control_state already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.director_control_state (
      -- The world this Director control cursor belongs to (one per world).
      world_id            INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      -- The current short-term intervention mode. NORMAL is the default
      -- broad-swing cadence; BOOM/BUST/RESCUE are deliberate interventions.
      mode                VARCHAR(8) NOT NULL,
      -- The current intervention/swing direction.
      direction           VARCHAR(8) NOT NULL,
      -- Bounded intervention strength [0, 1].
      intensity           DOUBLE PRECISION NOT NULL,
      -- The current intervention window.
      started_at          TIMESTAMPTZ NOT NULL,
      ends_at             TIMESTAMPTZ NOT NULL,
      -- The idempotent decision cursor: monotone per world. A restarted
      -- runtime resumes at the committed decision; a stale replayed
      -- decision index is rejected at the model layer.
      decision_index      INTEGER NOT NULL,
      -- Why this decision was taken (internal audit text).
      reason              TEXT NOT NULL,
      -- The current Golden coin and its expiry (both or neither).
      golden_coin_id      INTEGER REFERENCES public.coins (coin_id),
      golden_expires_at   TIMESTAMPTZ,
      -- The current Demon coin and its expiry (both or neither).
      demon_coin_id       INTEGER REFERENCES public.coins (coin_id),
      demon_expires_at    TIMESTAMPTZ,
      -- The last broad swing direction (null before the first swing).
      last_swing_direction VARCHAR(8),
      -- Stagnation tracking: the last instant the market moved meaningfully.
      last_meaningful_movement_at TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT director_control_state_pkey PRIMARY KEY (world_id),
      CONSTRAINT director_control_state_mode_known CHECK (mode IN ('NORMAL', 'BOOM', 'BUST', 'RESCUE')),
      CONSTRAINT director_control_state_direction_known CHECK (direction IN ('POSITIVE', 'NEGATIVE')),
      CONSTRAINT director_control_state_intensity_bounded CHECK (intensity >= 0 AND intensity <= 1),
      CONSTRAINT director_control_state_decision_index_nonneg CHECK (decision_index >= 0),
      CONSTRAINT director_control_state_window_positive CHECK (ends_at > started_at),
      -- Golden/Demon assignments are pair-consistent: coin and expiry
      -- together, or neither.
      CONSTRAINT director_control_state_golden_consistent CHECK (
        (golden_coin_id IS NULL) = (golden_expires_at IS NULL)
      ),
      CONSTRAINT director_control_state_demon_consistent CHECK (
        (demon_coin_id IS NULL) = (demon_expires_at IS NULL)
      ),
      -- Golden and Demon are never the same coin.
      CONSTRAINT director_control_state_golden_demon_distinct CHECK (
        golden_coin_id IS NULL OR demon_coin_id IS NULL OR golden_coin_id <> demon_coin_id
      ),
      CONSTRAINT director_control_state_last_swing_known CHECK (
        last_swing_direction IS NULL OR last_swing_direction IN ('POSITIVE', 'NEGATIVE')
      )
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Bounded active lookup indexes. Same-named pre-existing indexes must be
--    exactly these indexes; anything else is an incompatibility and aborts
--    the migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_persistent_coin_events_active') THEN
    -- Exact shape verification: a non-unique btree on exactly the ordered
    -- key list (world_id, coin_id, ends_at).
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'idx_persistent_coin_events_active'
        AND c.relnamespace = 'public'::regnamespace
        AND i.indrelid = 'public.persistent_coin_events'::regclass
        AND am.amname = 'btree'
        AND NOT i.indisunique
        AND (
          SELECT string_agg(a.attname, ',' ORDER BY k.n)
          FROM generate_series(0, i.indnkeyatts - 1) AS k(n)
          JOIN pg_attribute a
            ON a.attrelid = i.indrelid
           AND a.attnum = i.indkey[k.n]
        ) = 'world_id,coin_id,ends_at'
    ) THEN
      RAISE EXCEPTION 'migration 029: existing index idx_persistent_coin_events_active is INCOMPATIBLE (expected a non-unique index on (world_id, coin_id, ends_at)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_persistent_coin_events_active ON public.persistent_coin_events (world_id, coin_id, ends_at);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_persistent_coin_events_world_active') THEN
    -- Exact shape verification: a non-unique btree on exactly the ordered
    -- key list (world_id, ends_at).
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'idx_persistent_coin_events_world_active'
        AND c.relnamespace = 'public'::regnamespace
        AND i.indrelid = 'public.persistent_coin_events'::regclass
        AND am.amname = 'btree'
        AND NOT i.indisunique
        AND (
          SELECT string_agg(a.attname, ',' ORDER BY k.n)
          FROM generate_series(0, i.indnkeyatts - 1) AS k(n)
          JOIN pg_attribute a
            ON a.attrelid = i.indrelid
           AND a.attnum = i.indkey[k.n]
        ) = 'world_id,ends_at'
    ) THEN
      RAISE EXCEPTION 'migration 029: existing index idx_persistent_coin_events_world_active is INCOMPATIBLE (expected a non-unique index on (world_id, ends_at)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_persistent_coin_events_world_active ON public.persistent_coin_events (world_id, ends_at);
  END IF;
END $$;
