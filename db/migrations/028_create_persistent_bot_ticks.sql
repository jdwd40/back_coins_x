-- Persistent-market Stage 8: persistent bot tick identity. Production DDL
-- source of truth for persistent_bot_ticks. Applied to the test database by
-- db/seed.js so tests share this exact DDL.
--
-- Design rules (master plan §8, mirroring apocalypse_bot_ticks):
--   * runPersistentBotTick claims (world_id, tick_id) with
--     INSERT ... ON CONFLICT DO NOTHING, so a given tick executes at most
--     once across every Node/PM2 process — the database is the
--     duplicate-tick authority. The module owns no timers.
--
-- Fully additive: one NEW table; nothing existing is touched. If the table
-- already exists its shape is verified explicitly and an incompatible shape
-- aborts with a clear error.

DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.market_worlds') IS NULL THEN
    RAISE EXCEPTION 'migration 028: market_worlds does not exist. Apply migration 024 first.';
  END IF;

  IF to_regclass('public.persistent_bot_ticks') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('world_id',   'integer',                  'NO'),
        ('tick_id',    'bigint',                   'NO'),
        ('created_at', 'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'persistent_bot_ticks'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'missing primary key on (world_id, tick_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.persistent_bot_ticks'::regclass
          AND contype = 'p'
          AND pg_get_constraintdef(oid) ILIKE 'PRIMARY KEY (world_id, tick_id)%'
      )
    ) problems;
    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 028: incompatible pre-existing persistent_bot_ticks table: %', array_to_string(incompatible, '; ');
    END IF;
    RAISE NOTICE 'migration 028: persistent_bot_ticks already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.persistent_bot_ticks (
      world_id   INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      tick_id    BIGINT NOT NULL CHECK (tick_id >= 0),
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT persistent_bot_ticks_pkey PRIMARY KEY (world_id, tick_id)
    );
  END IF;
END $$;
