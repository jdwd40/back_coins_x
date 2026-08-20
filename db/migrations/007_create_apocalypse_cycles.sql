-- Crypto Chaos Core 1: global apocalypse cycle state.
-- Production DDL source of truth for the game-cycle schema.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * If apocalypse_cycles does not exist, it is created.
--   * If it already exists, its shape is verified explicitly. An incompatible
--     pre-existing table/index/constraint aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.apocalypse_cycles') IS NOT NULL THEN
    -- The table already exists. Verify every column/constraint the
    -- application relies on and abort loudly on any mismatch.
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('cycle_id',      'integer',                  'NO'),
        ('apocalypse_id', 'character varying',        'NO'),
        ('seed',          'text',                     'NO'),
        ('start_time',    'timestamp with time zone', 'NO'),
        ('end_time',      'timestamp with time zone', 'NO'),
        ('duration_ms',   'bigint',                   'NO'),
        ('status',        'character varying',        'NO'),
        ('created_at',    'timestamp with time zone', 'NO'),
        ('updated_at',    'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_cycles'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'cycle_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_cycles'
          AND c.column_name = 'cycle_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_cycles'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'updated_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'apocalypse_cycles'
          AND c.column_name = 'updated_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on cycle_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_cycles'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'cycle_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on apocalypse_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'apocalypse_cycles'
          AND tc.constraint_type = 'UNIQUE'
          AND kcu.column_name = 'apocalypse_id'
      )
      UNION ALL
      SELECT 'missing check constraint: duration_ms > 0'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cycles'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%duration_ms > 0%'
      )
      UNION ALL
      SELECT 'missing check constraint: status IN (ACTIVE, COMPLETED)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cycles'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%ACTIVE%COMPLETED%'
      )
      UNION ALL
      SELECT 'missing check constraint: end_time > start_time'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.apocalypse_cycles'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%end_time > start_time%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 007: existing apocalypse_cycles table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;
  ELSE
    CREATE TABLE apocalypse_cycles (
      cycle_id      SERIAL PRIMARY KEY,
      apocalypse_id VARCHAR(20) UNIQUE NOT NULL,
      seed          TEXT NOT NULL,
      start_time    TIMESTAMPTZ NOT NULL,
      end_time      TIMESTAMPTZ NOT NULL,
      duration_ms   BIGINT NOT NULL CHECK (duration_ms > 0),
      status        VARCHAR(10) NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (end_time > start_time)
    );
  END IF;
END $$;

-- Database-enforced single-active-cycle guarantee:
-- at most one row may hold status = 'ACTIVE' at any time.
-- If an index with this name already exists it must be exactly this partial
-- unique index; anything else is an incompatibility and aborts the migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'apocalypse_cycles_single_active') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE c.relname = 'apocalypse_cycles_single_active'
        AND i.indrelid = 'public.apocalypse_cycles'::regclass
        AND i.indisunique
        AND i.indpred IS NOT NULL -- partial index
        AND a.attname = 'status'
        -- Do not accept an arbitrary partial index: Core 1 depends on the
        -- predicate protecting ACTIVE rows specifically.
        AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%status%ACTIVE%'
    ) THEN
      RAISE EXCEPTION 'migration 007: existing index apocalypse_cycles_single_active is INCOMPATIBLE (expected a partial UNIQUE index on (status) WHERE status = ''ACTIVE''). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE UNIQUE INDEX apocalypse_cycles_single_active
      ON apocalypse_cycles (status)
      WHERE status = 'ACTIVE';
  END IF;
END $$;
