-- Crypto Chaos Core 3: permanent coin collapse — persisted per-cycle schedule
-- and durable per-coin restoration baseline.
-- Production DDL source of truth for the Core 3 schema.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: no existing table/column/data is dropped or
--     rewritten. The only data write is a backfill of the NEW
--     coins.cycle_baseline_price column from the current live price.
--   * If coin_collapse_schedule / cycle_baseline_price / the due index
--     already exist, their shape is verified explicitly. An incompatible
--     pre-existing object aborts the migration with a clear error instead of
--     being silently accepted by CREATE ... IF NOT EXISTS.
--   * If any existing coin has a non-positive current_price, no safe positive
--     baseline can be derived and the migration aborts loudly rather than
--     persisting a corrupt baseline.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. coins.cycle_baseline_price: the durable restoration baseline.
--    At every new cycle boundary live prices are reset from this column, so a
--    previous cycle's collapsed £0 can never leak into the next cycle.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coins'
      AND column_name = 'cycle_baseline_price'
  ) THEN
    -- Pre-existing column: it must be a numeric price column. Anything else
    -- is an incompatibility and aborts the migration.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'coins'
        AND column_name = 'cycle_baseline_price'
        AND data_type = 'numeric'
    ) THEN
      RAISE EXCEPTION 'migration 008: existing coins.cycle_baseline_price column is INCOMPATIBLE (expected a numeric column). Fix or drop it manually; the migration will not modify it.';
    END IF;
  ELSE
    ALTER TABLE coins ADD COLUMN cycle_baseline_price DECIMAL(18, 2);
  END IF;

  -- Non-destructive backfill: only rows still lacking a baseline take their
  -- current live price. Existing baseline values are never overwritten.
  UPDATE coins SET cycle_baseline_price = current_price
   WHERE cycle_baseline_price IS NULL;

  -- A collapsed (zero) or negative price cannot seed a restoration baseline.
  IF EXISTS (SELECT 1 FROM coins WHERE cycle_baseline_price IS NULL OR cycle_baseline_price <= 0) THEN
    RAISE EXCEPTION 'migration 008: cannot derive a safe baseline — existing coins rows have NULL or non-positive prices. Repair the data manually; the migration will not guess a baseline.';
  END IF;

  ALTER TABLE coins ALTER COLUMN cycle_baseline_price SET NOT NULL;
END $$;

-- Positive-baseline guarantee. A same-named constraint must be exactly this
-- check; anything else is an incompatibility.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.coins'::regclass AND conname = 'coins_cycle_baseline_price_positive'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.coins'::regclass AND conname = 'coins_cycle_baseline_price_positive'
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ~ 'cycle_baseline_price > \(?0'
    ) THEN
      RAISE EXCEPTION 'migration 008: existing constraint coins_cycle_baseline_price_positive is INCOMPATIBLE (expected CHECK (cycle_baseline_price > 0)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    ALTER TABLE coins
      ADD CONSTRAINT coins_cycle_baseline_price_positive CHECK (cycle_baseline_price > 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. coin_collapse_schedule: the persisted per-cycle collapse schedule.
--    Execution state (executed_at) is stored explicitly on the durable row —
--    never inferred from current_price === 0 and never held in memory.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.coin_collapse_schedule') IS NOT NULL THEN
    -- The table already exists. Verify every column/constraint the
    -- application relies on and abort loudly on any mismatch.
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('schedule_id',    'integer',                  'NO'),
        ('cycle_id',       'integer',                  'NO'),
        ('coin_id',        'integer',                  'NO'),
        ('collapse_rank',  'integer',                  'NO'),
        ('scheduled_at',   'timestamp with time zone', 'NO'),
        ('baseline_price', 'numeric',                  'NO'),
        ('executed_at',    'timestamp with time zone', 'YES'),
        ('created_at',     'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'coin_collapse_schedule'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'schedule_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'coin_collapse_schedule'
          AND c.column_name = 'schedule_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'coin_collapse_schedule'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on schedule_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'coin_collapse_schedule'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'schedule_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, coin_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.coin_collapse_schedule'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, coin_id)%'
      )
      UNION ALL
      SELECT 'missing unique constraint on (cycle_id, collapse_rank)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.coin_collapse_schedule'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (cycle_id, collapse_rank)%'
      )
      UNION ALL
      SELECT 'missing foreign key cycle_id -> apocalypse_cycles'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.coin_collapse_schedule'::regclass
          AND contype = 'f'
          AND confrelid = 'public.apocalypse_cycles'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (cycle_id)%'
      )
      UNION ALL
      SELECT 'missing foreign key coin_id -> coins'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.coin_collapse_schedule'::regclass
          AND contype = 'f'
          AND confrelid = 'public.coins'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (coin_id)%'
      )
      UNION ALL
      SELECT 'missing check constraint: collapse_rank >= 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.coin_collapse_schedule'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%collapse_rank >= 0%'
      )
      UNION ALL
      SELECT 'missing check constraint: baseline_price > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.coin_collapse_schedule'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'baseline_price > \(?0'
      )
      UNION ALL
      SELECT 'missing check constraint: executed_at is NULL or not before scheduled_at'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.coin_collapse_schedule'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%executed_at IS NULL%scheduled_at%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 008: existing coin_collapse_schedule table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE coin_collapse_schedule (
      schedule_id    SERIAL PRIMARY KEY,
      cycle_id       INTEGER NOT NULL REFERENCES apocalypse_cycles(cycle_id),
      coin_id        INTEGER NOT NULL REFERENCES coins(coin_id),
      collapse_rank  INTEGER NOT NULL CHECK (collapse_rank >= 0),
      scheduled_at   TIMESTAMPTZ NOT NULL,
      -- Price snapshot taken at schedule creation (the cycle-start baseline),
      -- kept per row so execution audits never depend on mutable live state.
      baseline_price DECIMAL(18, 2) NOT NULL CHECK (baseline_price > 0),
      -- NULL until the collapse has actually been executed. Execution state
      -- is separate from scheduled state; replay is idempotent because only
      -- executed_at IS NULL rows are ever selected for execution.
      executed_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (cycle_id, coin_id),
      UNIQUE (cycle_id, collapse_rank),
      CHECK (executed_at IS NULL OR executed_at >= scheduled_at)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Reconciliation index: due-but-unexecuted rows are the hot lookup.
--    A same-named index must be exactly this partial index on scheduled_at;
--    anything else is an incompatibility and aborts the migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_coin_collapse_schedule_due') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'idx_coin_collapse_schedule_due'
        AND i.indrelid = 'public.coin_collapse_schedule'::regclass
        AND i.indpred IS NOT NULL -- partial index
        AND a.attname = 'scheduled_at'
        AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%executed_at%IS NULL%'
    ) THEN
      RAISE EXCEPTION 'migration 008: existing index idx_coin_collapse_schedule_due is INCOMPATIBLE (expected a partial index on (scheduled_at) WHERE executed_at IS NULL). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_coin_collapse_schedule_due
      ON coin_collapse_schedule (scheduled_at)
      WHERE executed_at IS NULL;
  END IF;
END $$;
