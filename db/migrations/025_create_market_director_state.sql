-- Persistent-market Stage 3: durable world-level Market Director state.
-- Production DDL source of truth for the market_director_state table.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- Design rules (master plan §8/§12C/§74):
--   * Exactly ONE row per market world: the Director's authoritative committed
--     cursor over the deterministic six-regime chain — the current regime, the
--     instant it started, its intensity, and its chain index. The Director's regime
--     CHAIN is deterministic from the world seed (game/marketDirector.js); the
--     persisted row commits the world's current public regime and its timing so
--     runtime and diagnostics read one authoritative cursor instead of
--     re-walking the chain, and so the public regime is redaction-safe to expose
--     (master plan §10: players see the current public regime; hidden rolls
--     and chain internals never leave the server).
--   * The regime vocabulary is exactly the six persistent regimes
--     (GOLDEN_AGE, BOOM, BULL, BEAR, BUST, RECESSION), enforced by CHECK.
--   * Intensity is a bounded fraction in [0, 1]; regime_index is the
--     monotone chain position (>= 0); regime_started_at must be a real
--     timestamp. CHECK constraints make structurally impossible state
--     unwritable; corrupt state fails loudly at the model layer.
--   * The chain index lets the runtime resume the deterministic walk at
--     the committed regime instead of re-walking the world age (the same
--     bounded-walk pattern as the pricing checkpoints).
--   * This table is internal-only: no public endpoint exposes regime
--     rolls or chain internals; the public payload is regime + intensity
--     only.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive and additive: only a NEW table is created; no
--     row, column, constraint or trigger of any existing table is dropped,
--     rewritten or backfilled.
--   * If the table already exists, its shape is verified explicitly. An
--     incompatible pre-existing table aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. market_director_state: one authoritative Director cursor per world.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.market_worlds') IS NULL THEN
    RAISE EXCEPTION 'migration 025: market_worlds does not exist. Apply migration 024 first.';
  END IF;

  IF to_regclass('public.market_director_state') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('world_id',          'integer',                  'NO'),
        ('regime',            'text',                     'NO'),
        ('regime_started_at', 'timestamp with time zone', 'NO'),
        ('intensity',         'double precision',         'NO'),
        ('regime_index',      'integer',                  'NO'),
        ('created_at',        'timestamp with time zone', 'NO'),
        ('updated_at',        'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'market_director_state'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'missing primary key on (world_id)'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'market_director_state'
          AND tc.constraint_type = 'PRIMARY KEY'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 025: incompatible pre-existing market_director_state table: %', array_to_string(incompatible, '; ');
    END IF;

    RAISE NOTICE 'migration 025: market_director_state already exists with the expected shape; leaving it unchanged';
    RETURN;
  END IF;

  CREATE TABLE public.market_director_state (
    -- The world this Director cursor belongs to (one Director per world).
    world_id          integer                  NOT NULL REFERENCES public.market_worlds (world_id),
    -- The current public regime (exactly the six persistent regimes).
    regime            text                     NOT NULL,
    -- The instant the current regime started (authoritative time).
    regime_started_at timestamp with time zone NOT NULL,
    -- The regime's committed intensity (bounded [0, 1]; scales how
    -- strongly the regime's environment template applies).
    intensity         double precision         NOT NULL,
    -- The regime's position in the deterministic seeded chain (monotone;
    -- lets the runtime resume the chain walk without re-walking the
    -- world age).
    regime_index      integer                  NOT NULL,
    created_at        timestamp with time zone NOT NULL DEFAULT now(),
    updated_at        timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT market_director_state_pkey PRIMARY KEY (world_id),
    CONSTRAINT market_director_state_regime_known CHECK (
      regime IN ('GOLDEN_AGE', 'BOOM', 'BULL', 'BEAR', 'BUST', 'RECESSION')
    ),
    CONSTRAINT market_director_state_intensity_bounded CHECK (intensity >= 0 AND intensity <= 1),
    CONSTRAINT market_director_state_regime_index_nonneg CHECK (regime_index >= 0)
  );
END $$;
