-- Crypto Chaos Core 5: autonomous roster bots — the public bot marker on
-- users, durable bot identities, and the durable bot tick ledger.
-- Production DDL source of truth for the Core 5 schema.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: no existing table/column/data is dropped or
--     rewritten. Legacy users/portfolios/transactions and Core 1/3/4 game
--     tables are never touched. users.is_bot is ADDED with a safe
--     false default; every pre-existing user is and stays human.
--   * If any Core 5 object already exists, its shape is verified explicitly.
--     An incompatible pre-existing object aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. users.is_bot: the persisted public bot marker. Exactly one boolean,
--    NOT NULL, default false — pre-existing users are human. The marker is
--    safe to expose on public participant state; it reveals nothing about
--    strategy internals. Bot users are provisioned with credentials that can
--    never authenticate (a bcrypt hash of a never-stored random secret), so
--    the marker is informational, never an authz bypass.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_bot'
  ) THEN
    -- Pre-existing column: verify it is exactly the expected shape.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_bot'
        AND data_type = 'boolean' AND is_nullable = 'NO'
        AND column_default = 'false'
    ) THEN
      RAISE EXCEPTION 'migration 010: existing users.is_bot column is INCOMPATIBLE (expected boolean NOT NULL DEFAULT false). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    ALTER TABLE users ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. apocalypse_bots: durable bot identities. Exactly one row per roster
--    bot_key, pinned to exactly one users row (a stable, is_bot-marked user
--    with no usable human credentials). The strategy name is server-side
--    configuration metadata — persisted here for observability, never
--    exposed on public state.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_bots') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('bot_id',         'integer',                  'NO'),
        ('bot_key',        'character varying',        'NO'),
        ('strategy',       'character varying',        'NO'),
        ('user_id',        'integer',                  'NO'),
        ('last_action_at', 'timestamp with time zone', 'YES'),
        ('created_at',     'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_bots'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'bot_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_bots'
          AND c.column_name = 'bot_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_bots'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on bot_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_bots'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'bot_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on bot_key'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_bots'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (bot_key)%'
      )
      UNION ALL
      SELECT 'missing unique constraint on user_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_bots'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (user_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key user_id -> users'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_bots'::regclass
          AND contype = 'f'
          AND confrelid = 'public.users'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (user_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: strategy roster'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_bots'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%conservative%momentum%dip_buyer%reckless%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 010: existing apocalypse_bots table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_bots (
      bot_id         SERIAL PRIMARY KEY,
      bot_key        VARCHAR(40) NOT NULL,
      strategy       VARCHAR(20) NOT NULL CHECK (strategy IN ('conservative', 'momentum', 'dip_buyer', 'reckless')),
      user_id        INTEGER NOT NULL REFERENCES users(user_id),
      -- Persisted last executed-action time: the cross-process authority for
      -- the per-bot cooldown. NULL means the bot has never acted.
      last_action_at TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Exactly one identity row per roster key and per backing user.
      UNIQUE (bot_key),
      UNIQUE (user_id)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. apocalypse_bot_ticks: the durable bot tick ledger. Exactly one row per
--    (cycle_id, tick_id) — the database-enforced duplicate-tick identity.
--    The claim INSERT ... ON CONFLICT DO NOTHING is what makes a tick
--    execute at most once across every Node/PM2 process. actions is the
--    per-bot decision/result record for observability (server-side only).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_bot_ticks') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('tick_pk',     'integer',                  'NO'),
        ('cycle_id',    'integer',                  'NO'),
        ('tick_id',     'bigint',                   'NO'),
        ('actions',     'jsonb',                    'NO'),
        ('executed_at', 'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_bot_ticks'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'tick_pk is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_bot_ticks'
          AND c.column_name = 'tick_pk'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'executed_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_bot_ticks'
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
          AND tc.table_name = 'apocalypse_bot_ticks'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'tick_pk'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, tick_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_bot_ticks'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, tick_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_bot_ticks'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: tick_id >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_bot_ticks'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'tick_id >= \(?0'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 010: existing apocalypse_bot_ticks table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_bot_ticks (
      tick_pk     SERIAL PRIMARY KEY,
      cycle_id    INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      tick_id     BIGINT NOT NULL CHECK (tick_id >= 0),
      actions     JSONB NOT NULL DEFAULT '[]'::jsonb,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- The duplicate-tick identity, enforced by the database.
      UNIQUE (cycle_id, tick_id)
    );
  END IF;
END $$;
