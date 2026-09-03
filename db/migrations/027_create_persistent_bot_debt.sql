-- Persistent-market Stage 8: bot-only debt. Production DDL source of truth
-- for persistent_accounts.debt and the persistent_loans ledger. Applied to
-- the test database by db/seed.js so tests share this exact DDL.
--
-- Design rules (master plan §8):
--   * Debt is BOT-ONLY and interest-free: a bankrupt bot (no usable cash
--     AND no meaningful sellable holdings) may receive a £10,000 virtual
--     loan; the debt persists on the account row (DECIMAL, never negative)
--     and every issuance/repayment is an append-only ledger row carrying
--     the post-operation debt for audit.
--   * Repayment is automatic and priority-ordered: cash above the
--     configurable £2,000 operating reserve repays outstanding debt first;
--     the reserve floor is enforced by the guarded debit itself.
--   * Debt-adjusted wealth = cash + live holdings value - outstanding debt
--     (the Stage 10 persistent leaderboard figure).
--   * Humans never carry debt: the service layer rejects non-bot accounts;
--     the column defaults to 0 and the CHECK backstops non-negativity.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully additive: one new column with a safe DEFAULT, one new table;
--     no row, column, constraint or trigger of any existing table is
--     dropped, rewritten or backfilled.
--   * If the column/table already exists, its shape is verified explicitly;
--     an incompatible pre-existing shape aborts with a clear error instead
--     of being silently accepted.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.persistent_accounts') IS NULL THEN
    RAISE EXCEPTION 'migration 027: persistent_accounts does not exist. Apply migration 026 first.';
  END IF;

  -- ---------------------------------------------------------------------
  -- 1. persistent_accounts.debt: the persisted outstanding loan principal.
  -- ---------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'persistent_accounts' AND column_name = 'debt'
  ) THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'column persistent_accounts.debt: wrong type/nullability' AS problem
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_accounts'
          AND c.column_name = 'debt'
          AND c.data_type = 'numeric'
          AND c.is_nullable = 'NO'
      )
      UNION ALL
      SELECT 'missing check constraint: debt >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_accounts'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'debt >= \(?0'
      )
    ) problems;
    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 027: incompatible pre-existing persistent_accounts.debt: %', array_to_string(incompatible, '; ');
    END IF;
    RAISE NOTICE 'migration 027: persistent_accounts.debt already exists with the expected shape; leaving it unchanged';
  ELSE
    ALTER TABLE public.persistent_accounts
      ADD COLUMN debt DECIMAL(18, 2) NOT NULL DEFAULT 0 CHECK (debt >= 0);
  END IF;

  -- ---------------------------------------------------------------------
  -- 2. persistent_loans: the append-only loan ledger. Every ISSUE and
  --    REPAYMENT lands in the same transaction as the guarded cash/debt
  --    mutation (ledger-after-success), carrying the post-operation debt.
  -- ---------------------------------------------------------------------
  IF to_regclass('public.persistent_loans') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('persistent_loan_id', 'integer',                  'NO'),
        ('account_id',         'integer',                  'NO'),
        ('world_id',           'integer',                  'NO'),
        ('user_id',            'integer',                  'NO'),
        ('type',               'character varying',        'NO'),
        ('amount',             'numeric',                  'NO'),
        ('debt_after',         'numeric',                  'NO'),
        ('created_at',         'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_loans'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'missing primary key on (persistent_loan_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'persistent_loans'
          AND tc.constraint_type = 'PRIMARY KEY'
      )
      UNION ALL
      SELECT 'missing check constraint: type IN (ISSUE, REPAYMENT)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_loans'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%ISSUE%REPAYMENT%'
      )
      UNION ALL
      SELECT 'missing check constraint: amount > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_loans'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'amount > \(?0'
      )
    ) problems;
    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 027: incompatible pre-existing persistent_loans table: %', array_to_string(incompatible, '; ');
    END IF;
    RAISE NOTICE 'migration 027: persistent_loans already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.persistent_loans (
      persistent_loan_id SERIAL PRIMARY KEY,
      account_id  INTEGER NOT NULL REFERENCES public.persistent_accounts (account_id),
      world_id    INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      user_id     INTEGER NOT NULL REFERENCES public.users (user_id),
      type        VARCHAR(9) NOT NULL CHECK (type IN ('ISSUE', 'REPAYMENT')),
      amount      DECIMAL(18, 2) NOT NULL CHECK (amount > 0),
      -- Post-operation outstanding principal: the ledger alone reconstructs
      -- the debt history exactly.
      debt_after  DECIMAL(18, 2) NOT NULL CHECK (debt_after >= 0),
      created_at  timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_persistent_loans_account_created
      ON public.persistent_loans (account_id, created_at DESC);
  END IF;
END $$;
