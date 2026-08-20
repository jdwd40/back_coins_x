-- Crypto Chaos Core 4: player round state — per-cycle participants, round
-- holdings and round transactions.
-- Production DDL source of truth for the Core 4 schema.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: no existing table/column/data is dropped or
--     rewritten. Legacy users/portfolios/transactions and Core 1/3 game
--     tables are never touched; account-level users.funds is never read or
--     written here.
--   * If any Core 4 table/index already exists, its shape is verified
--     explicitly. An incompatible pre-existing object aborts the migration
--     with a clear error instead of being silently accepted by
--     CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. apocalypse_participants: exactly one participant row per
--    (cycle_id, user_id). Join-anytime: starting_cash is stamped once at join
--    from the single server-side game constant and never adjusted later.
--    Status is ACTIVE or FINALIZED only; final_cash is set exactly once, at
--    cycle finalization, from the authoritative current_cash.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_participants') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('participant_id', 'integer',                  'NO'),
        ('cycle_id',       'integer',                  'NO'),
        ('user_id',        'integer',                  'NO'),
        ('joined_at',      'timestamp with time zone', 'NO'),
        ('starting_cash',  'numeric',                  'NO'),
        ('current_cash',   'numeric',                  'NO'),
        ('peak_wealth',    'numeric',                  'NO'),
        ('status',         'character varying',        'NO'),
        ('final_cash',     'numeric',                  'YES'),
        ('created_at',     'timestamp with time zone', 'NO'),
        ('updated_at',     'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_participants'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'participant_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_participants'
          AND c.column_name = 'participant_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'joined_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_participants'
          AND c.column_name = 'joined_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_participants'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'updated_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_participants'
          AND c.column_name = 'updated_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on participant_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_participants'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'participant_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, user_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, user_id)%'
      )
      UNION ALL
      SELECT 'missing unique constraint on (participant_id, cycle_id, user_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (participant_id, cycle_id, user_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key user_id -> users'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'f'
          AND confrelid = 'public.users'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (user_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: starting_cash > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'starting_cash > \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: current_cash >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'current_cash >= \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: peak_wealth >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'peak_wealth >= \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: status IN (ACTIVE, FINALIZED)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%ACTIVE%FINALIZED%'
      )
      UNION ALL
      SELECT 'missing check constraint: final_cash consistency with status'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_participants'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%final_cash IS NULL%FINALIZED%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 009: existing apocalypse_participants table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_participants (
      participant_id SERIAL PRIMARY KEY,
      cycle_id       INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      user_id        INTEGER NOT NULL REFERENCES users(user_id),
      joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      starting_cash  DECIMAL(18, 2) NOT NULL CHECK (starting_cash > 0),
      current_cash   DECIMAL(18, 2) NOT NULL CHECK (current_cash >= 0),
      peak_wealth    DECIMAL(18, 2) NOT NULL CHECK (peak_wealth >= 0),
      status         VARCHAR(10) NOT NULL CHECK (status IN ('ACTIVE', 'FINALIZED')),
      final_cash     DECIMAL(18, 2),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Exactly one participant per user per cycle, enforced by the database.
      UNIQUE (cycle_id, user_id),
      -- Composite uniqueness lets round holdings/transactions carry a
      -- denormalised (cycle_id, user_id) that is database-constrained to
      -- match their participant row exactly.
      UNIQUE (participant_id, cycle_id, user_id),
      -- final_cash exists exactly when the participant is FINALIZED.
      CHECK ((status = 'ACTIVE' AND final_cash IS NULL)
          OR (status = 'FINALIZED' AND final_cash IS NOT NULL AND final_cash >= 0))
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. apocalypse_holdings: round-scoped coin positions. Exactly one holding
--    row per (participant_id, coin_id). The denormalised cycle_id/user_id
--    pair is constrained by the composite FK to the participant row, so a
--    holding can never point at a different cycle or user than its
--    participant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_holdings') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('holding_id',     'integer',                  'NO'),
        ('participant_id', 'integer',                  'NO'),
        ('cycle_id',       'integer',                  'NO'),
        ('user_id',        'integer',                  'NO'),
        ('coin_id',        'integer',                  'NO'),
        ('quantity',       'numeric',                  'NO'),
        ('created_at',     'timestamp with time zone', 'NO'),
        ('updated_at',     'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_holdings'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'holding_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_holdings'
          AND c.column_name = 'holding_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'missing primary key on holding_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_holdings'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'holding_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (participant_id, coin_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_holdings'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (participant_id, coin_id)%'
      )
      UNION ALL
      SELECT 'missing composite foreign key (participant_id, cycle_id, user_id) -> apocalypse_participants'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_holdings'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_participants'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (participant_id, cycle_id, user_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key coin_id -> coins'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_holdings'::regclass
          AND contype = 'f'
          AND confrelid = 'public.coins'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (coin_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: quantity >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_holdings'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'quantity >= \(?0'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 009: existing apocalypse_holdings table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_holdings (
      holding_id     SERIAL PRIMARY KEY,
      participant_id INTEGER NOT NULL,
      cycle_id       INTEGER NOT NULL,
      user_id        INTEGER NOT NULL,
      coin_id        INTEGER NOT NULL REFERENCES coins(coin_id),
      quantity       DECIMAL(18, 2) NOT NULL CHECK (quantity >= 0),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Exactly one logical holding per participant/coin, database-enforced.
      UNIQUE (participant_id, coin_id),
      FOREIGN KEY (participant_id, cycle_id, user_id)
        REFERENCES apocalypse_participants (participant_id, cycle_id, user_id)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. apocalypse_transactions: the immutable per-round trade ledger. Every
--    row unambiguously records participant, cycle, user, coin, BUY/SELL,
--    quantity, execution price, total and timestamp. Prices are always the
--    server-side authoritative price at execution; a collapsed coin sells at
--    exactly 0, so price/total allow zero but never negative.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_transactions') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('round_transaction_id', 'integer',                  'NO'),
        ('participant_id',       'integer',                  'NO'),
        ('cycle_id',             'integer',                  'NO'),
        ('user_id',              'integer',                  'NO'),
        ('coin_id',              'integer',                  'NO'),
        ('type',                 'character varying',        'NO'),
        ('quantity',             'numeric',                  'NO'),
        ('price',                'numeric',                  'NO'),
        ('total_amount',         'numeric',                  'NO'),
        ('created_at',           'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_transactions'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'round_transaction_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_transactions'
          AND c.column_name = 'round_transaction_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_transactions'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on round_transaction_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_transactions'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'round_transaction_id'
      )
      UNION ALL
      SELECT 'missing composite foreign key (participant_id, cycle_id, user_id) -> apocalypse_participants'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_transactions'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_participants'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (participant_id, cycle_id, user_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key coin_id -> coins'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_transactions'::regclass
          AND contype = 'f'
          AND confrelid = 'public.coins'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (coin_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: type IN (BUY, SELL)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_transactions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%BUY%SELL%'
      )
      UNION ALL
      SELECT 'missing check constraint: quantity > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_transactions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'quantity > \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: price >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_transactions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'price >= \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: total_amount >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_transactions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'total_amount >= \(?0'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 009: existing apocalypse_transactions table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_transactions (
      round_transaction_id SERIAL PRIMARY KEY,
      participant_id       INTEGER NOT NULL,
      cycle_id             INTEGER NOT NULL,
      user_id              INTEGER NOT NULL,
      coin_id              INTEGER NOT NULL REFERENCES coins(coin_id),
      type                 VARCHAR(4) NOT NULL CHECK (type IN ('BUY', 'SELL')),
      quantity             DECIMAL(18, 2) NOT NULL CHECK (quantity > 0),
      price                DECIMAL(18, 2) NOT NULL CHECK (price >= 0),
      total_amount         DECIMAL(18, 2) NOT NULL CHECK (total_amount >= 0),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (participant_id, cycle_id, user_id)
        REFERENCES apocalypse_participants (participant_id, cycle_id, user_id)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Lookup indexes. Same-named pre-existing indexes must be exactly these
--    indexes; anything else is an incompatibility and aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_participants_user') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'idx_apocalypse_participants_user'
        AND i.indrelid = 'public.apocalypse_participants'::regclass
        AND NOT i.indisunique
        AND a.attname = 'user_id'
    ) THEN
      RAISE EXCEPTION 'migration 009: existing index idx_apocalypse_participants_user is INCOMPATIBLE (expected a non-unique index on (user_id)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_participants_user ON apocalypse_participants (user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_transactions_cycle') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'idx_apocalypse_transactions_cycle'
        AND i.indrelid = 'public.apocalypse_transactions'::regclass
        AND NOT i.indisunique
        AND a.attname = 'cycle_id'
    ) THEN
      RAISE EXCEPTION 'migration 009: existing index idx_apocalypse_transactions_cycle is INCOMPATIBLE (expected a non-unique index on (cycle_id)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_transactions_cycle ON apocalypse_transactions (cycle_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_apocalypse_holdings_cycle') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'idx_apocalypse_holdings_cycle'
        AND i.indrelid = 'public.apocalypse_holdings'::regclass
        AND NOT i.indisunique
        AND a.attname = 'cycle_id'
    ) THEN
      RAISE EXCEPTION 'migration 009: existing index idx_apocalypse_holdings_cycle is INCOMPATIBLE (expected a non-unique index on (cycle_id)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_apocalypse_holdings_cycle ON apocalypse_holdings (cycle_id);
  END IF;
END $$;
