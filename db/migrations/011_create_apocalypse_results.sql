-- Crypto Chaos Core 6: end-of-round settlement — the durable SETTLING
-- lifecycle phase, narrow settlement observability on apocalypse_cycles, and
-- the immutable per-participant results snapshot (apocalypse_results).
-- Production DDL source of truth for the Core 6 schema.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- Lifecycle contract (database-enforced):
--   ACTIVE -> SETTLING -> COMPLETED, never any other transition.
--   SETTLING commits durably BEFORE settlement work runs, so a settlement
--   failure leaves the cycle observably stuck in SETTLING (with
--   settlement_started_at set and settled_at NULL) and retry/resume is safe.
--   At most one cycle may be SETTLING at a time (partial unique index), and
--   a stuck SETTLING cycle blocks any successor.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: no existing table/column/data is dropped or
--     rewritten. The apocalypse_cycles status CHECK is widened
--     (ACTIVE/COMPLETED -> ACTIVE/SETTLING/COMPLETED), which every existing
--     row already satisfies; new observability columns are nullable or have
--     safe defaults, so all legacy/Core 1-5 rows survive unchanged.
--   * If any Core 6 object already exists, its shape is verified explicitly.
--     An incompatible pre-existing object aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. apocalypse_cycles: settlement observability columns.
--    settlement_started_at: stamped when the cycle is frozen into SETTLING.
--    settled_at:            stamped when settlement durably completes.
--    A cycle in SETTLING with settlement_started_at set and settled_at NULL
--    is an incomplete/failed settlement — distinguishable from live state
--    without any log scraping.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'apocalypse_cycles' AND column_name = 'settlement_started_at'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'apocalypse_cycles' AND column_name = 'settlement_started_at'
        AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'migration 011: existing apocalypse_cycles.settlement_started_at column is INCOMPATIBLE (expected timestamptz NULL). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    ALTER TABLE apocalypse_cycles ADD COLUMN settlement_started_at TIMESTAMPTZ;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'apocalypse_cycles' AND column_name = 'settled_at'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'apocalypse_cycles' AND column_name = 'settled_at'
        AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'migration 011: existing apocalypse_cycles.settled_at column is INCOMPATIBLE (expected timestamptz NULL). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    ALTER TABLE apocalypse_cycles ADD COLUMN settled_at TIMESTAMPTZ;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. apocalypse_cycles status CHECK: widen ACTIVE/COMPLETED to
--    ACTIVE/SETTLING/COMPLETED. The status column must be wide enough for
--    'SETTLING' (8 chars) and 'COMPLETED' (9 chars). A pre-existing status
--    check that is neither the Core 1 shape nor the Core 6 shape is an
--    incompatibility and aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  cname text;
  to_drop text[] := '{}';
BEGIN
  -- The column must physically hold the new status value.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'apocalypse_cycles' AND column_name = 'status'
      AND data_type = 'character varying'
      AND (character_maximum_length IS NULL OR character_maximum_length >= 9)
  ) THEN
    RAISE EXCEPTION 'migration 011: apocalypse_cycles.status column is INCOMPATIBLE (expected character varying with room for SETTLING/COMPLETED). Fix it manually; the migration will not modify it.';
  END IF;

  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.apocalypse_cycles'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
      AND pg_get_constraintdef(oid) ILIKE '%ACTIVE%'
  LOOP
    IF r.def ILIKE '%SETTLING%' AND r.def ILIKE '%COMPLETED%' THEN
      -- Already the Core 6 shape: keep it.
      CONTINUE;
    ELSIF r.def ILIKE '%COMPLETED%' THEN
      -- The Core 1 shape (ACTIVE, COMPLETED): superseded, drop and replace.
      to_drop := array_append(to_drop, r.conname);
    ELSE
      RAISE EXCEPTION 'migration 011: existing status check constraint % is INCOMPATIBLE (%). Fix it manually; the migration will not modify it.', r.conname, r.def;
    END IF;
  END LOOP;

  FOREACH cname IN ARRAY to_drop LOOP
    EXECUTE format('ALTER TABLE apocalypse_cycles DROP CONSTRAINT %I', cname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.apocalypse_cycles'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%ACTIVE%SETTLING%COMPLETED%'
  ) THEN
    ALTER TABLE apocalypse_cycles
      ADD CONSTRAINT apocalypse_cycles_status_check
      CHECK (status IN ('ACTIVE', 'SETTLING', 'COMPLETED'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Database-enforced single-settling-cycle guarantee: at most one row may
--    hold status = 'SETTLING' at any time (mirrors the Core 1
--    single-active index). A same-named pre-existing index must be exactly
--    this partial unique index; anything else aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'apocalypse_cycles_single_settling') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'apocalypse_cycles_single_settling'
        AND i.indrelid = 'public.apocalypse_cycles'::regclass
        AND i.indisunique
        AND i.indpred IS NOT NULL -- partial index
        AND a.attname = 'status'
        AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%status%SETTLING%'
    ) THEN
      RAISE EXCEPTION 'migration 011: existing index apocalypse_cycles_single_settling is INCOMPATIBLE (expected a partial UNIQUE index on (status) WHERE status = ''SETTLING''). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE UNIQUE INDEX apocalypse_cycles_single_settling
      ON apocalypse_cycles (status)
      WHERE status = 'SETTLING';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. apocalypse_results: the immutable per-participant completed-cycle
--    snapshot. Exactly one row per (cycle_id, participant_id) and exactly
--    one row per (cycle_id, rank) — both database-enforced. Written exactly
--    once during settlement; the immutability triggers below make any later
--    UPDATE/DELETE raise, so a completed result can never mutate.
--
--    Rank rule (authoritative, deterministic): final_cash DESC, then
--    participant_id ASC. Ranks are 1..N with no gaps, no modifiers for join
--    time, participant type, bot/human, or chance. net_profit is exactly
--    final_cash - starting_cash (enforced by CHECK); no FIFO/LIFO
--    accounting is involved anywhere.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_results') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('result_id',       'integer',                  'NO'),
        ('cycle_id',        'integer',                  'NO'),
        ('participant_id',  'integer',                  'NO'),
        ('user_id',         'integer',                  'NO'),
        ('apocalypse_id',   'character varying',        'NO'),
        ('username',        'character varying',        'NO'),
        ('is_bot',          'boolean',                  'NO'),
        ('bot_personality', 'character varying',        'YES'),
        ('rank',            'integer',                  'NO'),
        ('final_cash',      'numeric',                  'NO'),
        ('peak_wealth',     'numeric',                  'NO'),
        ('starting_cash',   'numeric',                  'NO'),
        ('net_profit',      'numeric',                  'NO'),
        ('joined_at',       'timestamp with time zone', 'NO'),
        ('trade_count',     'integer',                  'NO'),
        ('buy_count',       'integer',                  'NO'),
        ('sell_count',      'integer',                  'NO'),
        ('created_at',      'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_results'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'result_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_results'
          AND c.column_name = 'result_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_results'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on result_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_results'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'result_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, participant_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, participant_id)%'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, rank)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, rank)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key user_id -> users'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'f'
          AND confrelid = 'public.users'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (user_id)%'
      )
      UNION ALL
      SELECT 'missing composite foreign key (participant_id, cycle_id, user_id) -> apocalypse_participants'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_participants'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (participant_id, cycle_id, user_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: rank > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'rank > \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: final_cash >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'final_cash >= \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: peak_wealth >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'peak_wealth >= \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: starting_cash > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'starting_cash > \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: net_profit = final_cash - starting_cash'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%net_profit%final_cash%starting_cash%'
      )
      UNION ALL
      SELECT 'missing check constraint: bot_personality roster'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%bot_personality%conservative%momentum%dip_buyer%reckless%'
      )
      UNION ALL
      SELECT 'missing check constraint: trade_count = buy_count + sell_count'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%trade_count%buy_count%sell_count%'
      )
      UNION ALL
      SELECT 'missing check constraint: non-negative trade counts'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_results'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'trade_count >= \(?0'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 011: existing apocalypse_results table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_results (
      result_id       SERIAL PRIMARY KEY,
      cycle_id        INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      participant_id  INTEGER NOT NULL,
      user_id         INTEGER NOT NULL REFERENCES users(user_id),
      -- Denormalised display identity: the public cycle id and the username
      -- AS THEY WERE at settlement. Snapshot semantics — later user/cycle
      -- changes never rewrite a completed result.
      apocalypse_id   VARCHAR(20) NOT NULL,
      username        VARCHAR(50) NOT NULL,
      is_bot          BOOLEAN NOT NULL,
      -- The Core 5 roster personality for bot rows; NULL for humans.
      bot_personality VARCHAR(20) CHECK (bot_personality IS NULL OR bot_personality IN ('conservative', 'momentum', 'dip_buyer', 'reckless')),
      rank            INTEGER NOT NULL CHECK (rank > 0),
      final_cash      DECIMAL(18, 2) NOT NULL CHECK (final_cash >= 0),
      peak_wealth     DECIMAL(18, 2) NOT NULL CHECK (peak_wealth >= 0),
      starting_cash   DECIMAL(18, 2) NOT NULL CHECK (starting_cash > 0),
      net_profit      DECIMAL(18, 2) NOT NULL,
      joined_at       TIMESTAMPTZ NOT NULL,
      trade_count     INTEGER NOT NULL CHECK (trade_count >= 0),
      buy_count       INTEGER NOT NULL CHECK (buy_count >= 0),
      sell_count      INTEGER NOT NULL CHECK (sell_count >= 0),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Exactly one result per participant per cycle, and exactly one holder
      -- of each rank per cycle — both enforced by the database.
      UNIQUE (cycle_id, participant_id),
      UNIQUE (cycle_id, rank),
      -- The composite FK pins the snapshot row to its exact participant row
      -- (same cycle and user), matching the Core 4 denormalisation pattern.
      FOREIGN KEY (participant_id, cycle_id, user_id)
        REFERENCES apocalypse_participants (participant_id, cycle_id, user_id),
      -- net_profit is exactly final_cash minus starting_cash — no other
      -- accounting exists anywhere in the game.
      CHECK (net_profit = final_cash - starting_cash),
      -- Counts are internally consistent by construction.
      CHECK (trade_count = buy_count + sell_count)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Immutability: any UPDATE or DELETE of a results row raises. A
--    same-named pre-existing function/trigger must be exactly this shape;
--    anything else is an incompatibility and aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'apocalypse_results_immutable'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'apocalypse_results_immutable'
        AND p.prorettype = 'trigger'::regtype AND p.pronargs = 0
    ) THEN
      RAISE EXCEPTION 'migration 011: existing function apocalypse_results_immutable is INCOMPATIBLE (expected a zero-argument trigger function). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    EXECUTE $func$
      CREATE FUNCTION apocalypse_results_immutable() RETURNS trigger AS $body$
      BEGIN
        RAISE EXCEPTION 'apocalypse_results rows are immutable: % is rejected', TG_OP;
      END;
      $body$ LANGUAGE plpgsql
    $func$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'apocalypse_results'
      AND t.tgname = 'apocalypse_results_no_update' AND NOT t.tgisinternal
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND c.relname = 'apocalypse_results'
        AND t.tgname = 'apocalypse_results_no_update' AND NOT t.tgisinternal
        AND p.proname = 'apocalypse_results_immutable'
    ) THEN
      RAISE EXCEPTION 'migration 011: existing trigger apocalypse_results_no_update is INCOMPATIBLE (expected it to execute apocalypse_results_immutable). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    EXECUTE 'CREATE TRIGGER apocalypse_results_no_update BEFORE UPDATE ON apocalypse_results FOR EACH ROW EXECUTE FUNCTION apocalypse_results_immutable()';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'apocalypse_results'
      AND t.tgname = 'apocalypse_results_no_delete' AND NOT t.tgisinternal
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND c.relname = 'apocalypse_results'
        AND t.tgname = 'apocalypse_results_no_delete' AND NOT t.tgisinternal
        AND p.proname = 'apocalypse_results_immutable'
    ) THEN
      RAISE EXCEPTION 'migration 011: existing trigger apocalypse_results_no_delete is INCOMPATIBLE (expected it to execute apocalypse_results_immutable). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    EXECUTE 'CREATE TRIGGER apocalypse_results_no_delete BEFORE DELETE ON apocalypse_results FOR EACH ROW EXECUTE FUNCTION apocalypse_results_immutable()';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'apocalypse_results'
      AND t.tgname = 'apocalypse_results_no_truncate' AND NOT t.tgisinternal
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND c.relname = 'apocalypse_results'
        AND t.tgname = 'apocalypse_results_no_truncate' AND NOT t.tgisinternal
        AND p.proname = 'apocalypse_results_immutable'
    ) THEN
      RAISE EXCEPTION 'migration 011: existing trigger apocalypse_results_no_truncate is INCOMPATIBLE (expected it to execute apocalypse_results_immutable). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    EXECUTE 'CREATE TRIGGER apocalypse_results_no_truncate BEFORE TRUNCATE ON apocalypse_results FOR EACH STATEMENT EXECUTE FUNCTION apocalypse_results_immutable()';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Lookup index for per-user history reads. A same-named pre-existing
--    index must be exactly this one; anything else aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_results_user') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'idx_apocalypse_results_user'
        AND i.indrelid = 'public.apocalypse_results'::regclass
        AND NOT i.indisunique
        AND a.attname = 'user_id'
    ) THEN
      RAISE EXCEPTION 'migration 011: existing index idx_apocalypse_results_user is INCOMPATIBLE (expected a non-unique index on (user_id)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_results_user ON apocalypse_results (user_id);
  END IF;
END $$;
