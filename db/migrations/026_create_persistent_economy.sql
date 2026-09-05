-- Persistent-market Stage 5: the ONE writable persistent gameplay economy.
-- Production DDL source of truth for persistent_accounts,
-- persistent_holdings and persistent_transactions. Applied to the test
-- database by db/seed.js so tests share this exact DDL.
--
-- Design rules (master plan §11/§13):
--   * Exactly ONE account per user per world (UNIQUE (world_id, user_id)):
--     the account row IS the exactly-once receipt for the virtual £10,000
--     starting cash — provisioning inserts cash = starting_cash in one
--     statement and the unique constraint makes any replay a no-op, so the
--     grant can never double across retries, restarts or races.
--   * Accounts/holdings/ledger are world-scoped (FK to market_worlds): the
--     persistent world's identity bounds the economy; legacy apocalypse_*
--     and users.funds/portfolios data remains historical/archive and is
--     never authoritative for the persistent economy.
--   * Cash can never go negative (CHECK); holdings can never go negative
--     (CHECK); ledger rows are append-only positive-quantity BUY/SELL
--     records with the server-owned execution price (never client input).
--   * Cost basis is weighted-average (DECIMAL(18,2), exact SQL arithmetic),
--     matching the round economy's accounting conventions; quantities are
--     fractional (DECIMAL(18,8)) and prices carry the 4dp gameplay
--     precision (DECIMAL(18,4)).
--   * Death semantics (Stage 9): a DEAD coin's holdings stay on the books
--     (history preserved) but trading stops; wealth values them at £0.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive and additive: only NEW tables are created; no
--     row, column, constraint or trigger of any existing table is dropped,
--     rewritten or backfilled.
--   * If a table already exists, its shape is verified explicitly. An
--     incompatible pre-existing table aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.market_worlds') IS NULL THEN
    RAISE EXCEPTION 'migration 026: market_worlds does not exist. Apply migration 024 first.';
  END IF;

  -- ---------------------------------------------------------------------
  -- 1. persistent_accounts: one account per user per world; the row is the
  --    exactly-once £10,000 provisioning receipt.
  -- ---------------------------------------------------------------------
  IF to_regclass('public.persistent_accounts') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('account_id',    'integer',                  'NO'),
        ('world_id',      'integer',                  'NO'),
        ('user_id',       'integer',                  'NO'),
        ('starting_cash', 'numeric',                  'NO'),
        ('cash',          'numeric',                  'NO'),
        ('provisioned_at','timestamp with time zone', 'NO'),
        ('created_at',    'timestamp with time zone', 'NO'),
        ('updated_at',    'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_accounts'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'missing primary key on (account_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'persistent_accounts'
          AND tc.constraint_type = 'PRIMARY KEY'
      )
      UNION ALL
      SELECT 'missing unique constraint on (world_id, user_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_accounts'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (world_id, user_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: cash >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_accounts'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'cash >= \(?0'
      )
    ) problems;
    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 026: incompatible pre-existing persistent_accounts table: %', array_to_string(incompatible, '; ');
    END IF;
    RAISE NOTICE 'migration 026: persistent_accounts already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.persistent_accounts (
      account_id     SERIAL PRIMARY KEY,
      world_id       INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      user_id        INTEGER NOT NULL REFERENCES public.users (user_id),
      -- The virtual starting grant (exactly once; see the UNIQUE below).
      starting_cash  DECIMAL(18, 2) NOT NULL CHECK (starting_cash > 0),
      cash           DECIMAL(18, 2) NOT NULL CHECK (cash >= 0),
      provisioned_at timestamp with time zone NOT NULL DEFAULT now(),
      created_at     timestamp with time zone NOT NULL DEFAULT now(),
      updated_at     timestamp with time zone NOT NULL DEFAULT now(),
      -- One account per user per world — the exactly-once backstop.
      CONSTRAINT persistent_accounts_world_user_unique UNIQUE (world_id, user_id)
    );
  END IF;

  -- ---------------------------------------------------------------------
  -- 2. persistent_holdings: per-account coin positions with weighted-average
  --    cost basis. Never negative; a full sale zeroes the basis.
  -- ---------------------------------------------------------------------
  IF to_regclass('public.persistent_holdings') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('holding_id', 'integer',                  'NO'),
        ('account_id', 'integer',                  'NO'),
        ('world_id',   'integer',                  'NO'),
        ('user_id',    'integer',                  'NO'),
        ('coin_id',    'integer',                  'NO'),
        ('quantity',   'numeric',                  'NO'),
        ('cost_basis', 'numeric',                  'NO'),
        ('created_at', 'timestamp with time zone', 'NO'),
        ('updated_at', 'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_holdings'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'missing primary key on (holding_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'persistent_holdings'
          AND tc.constraint_type = 'PRIMARY KEY'
      )
      UNION ALL
      SELECT 'missing unique constraint on (account_id, coin_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_holdings'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (account_id, coin_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: quantity >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_holdings'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'quantity >= \(?0'
      )
    ) problems;
    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 026: incompatible pre-existing persistent_holdings table: %', array_to_string(incompatible, '; ');
    END IF;
    RAISE NOTICE 'migration 026: persistent_holdings already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.persistent_holdings (
      holding_id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES public.persistent_accounts (account_id),
      world_id   INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      user_id    INTEGER NOT NULL REFERENCES public.users (user_id),
      coin_id    INTEGER NOT NULL REFERENCES public.coins (coin_id),
      quantity   DECIMAL(18, 8) NOT NULL CHECK (quantity >= 0),
      cost_basis DECIMAL(18, 2) NOT NULL CHECK (cost_basis >= 0),
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT persistent_holdings_account_coin_unique UNIQUE (account_id, coin_id)
    );
  END IF;

  -- ---------------------------------------------------------------------
  -- 3. persistent_transactions: the append-only trade ledger. Written only
  --    after a successful guarded cash/holding mutation, in the same
  --    transaction (ledger-after-success).
  -- ---------------------------------------------------------------------
  IF to_regclass('public.persistent_transactions') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('persistent_transaction_id', 'integer',                  'NO'),
        ('account_id',                'integer',                  'NO'),
        ('world_id',                  'integer',                  'NO'),
        ('user_id',                   'integer',                  'NO'),
        ('coin_id',                   'integer',                  'NO'),
        ('type',                      'character varying',        'NO'),
        ('quantity',                  'numeric',                  'NO'),
        ('price',                     'numeric',                  'NO'),
        ('total_amount',              'numeric',                  'NO'),
        ('created_at',                'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_transactions'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'missing primary key on (persistent_transaction_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'persistent_transactions'
          AND tc.constraint_type = 'PRIMARY KEY'
      )
    ) problems;
    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 026: incompatible pre-existing persistent_transactions table: %', array_to_string(incompatible, '; ');
    END IF;
    RAISE NOTICE 'migration 026: persistent_transactions already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.persistent_transactions (
      persistent_transaction_id SERIAL PRIMARY KEY,
      account_id   INTEGER NOT NULL REFERENCES public.persistent_accounts (account_id),
      world_id     INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      user_id      INTEGER NOT NULL REFERENCES public.users (user_id),
      coin_id      INTEGER NOT NULL REFERENCES public.coins (coin_id),
      type         VARCHAR(4) NOT NULL CHECK (type IN ('BUY', 'SELL')),
      quantity     DECIMAL(18, 8) NOT NULL CHECK (quantity > 0),
      price        DECIMAL(18, 4) NOT NULL CHECK (price >= 0),
      total_amount DECIMAL(18, 2) NOT NULL CHECK (total_amount >= 0),
      created_at   timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_persistent_transactions_account_created
      ON public.persistent_transactions (account_id, created_at DESC);
    CREATE INDEX idx_persistent_holdings_account
      ON public.persistent_holdings (account_id);
  END IF;
END $$;
