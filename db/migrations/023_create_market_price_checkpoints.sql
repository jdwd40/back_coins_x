-- Crypto Chaos persistent-market Stage 1: durable per-coin pricing
-- checkpoints — the resumable accumulator state that lets the deterministic
-- pricing engine (game/marketDomain.js + game/priceEngine.js) continue a
-- coin's market timeline from a persisted position instead of re-walking it
-- from the market origin, with BIT-IDENTICAL results.
-- Production DDL source of truth for the market_price_checkpoints table.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- Design rules:
--   * Exactly ONE row per (coin_id, seed): the latest resumable pricing
--     position of one coin on one deterministic market timeline. Under the
--     V2 apocalypse engine the seed is the apocalypse cycle seed (one
--     timeline per cycle; old rows remain as harmless history after a
--     rollover). Under the later persistent world the seed is the world's
--     persisted seed (one continuing timeline per coin).
--   * All accumulator doubles are stored as double precision (IEEE 754
--     binary64), which round-trips EXACTLY through node-pg: a JavaScript
--     number written by the engine reads back bit-identical
--     (Object.is-equal), so a checkpointed continuation computes the exact
--     same sequence of doubles as a walk from the origin. Millisecond
--     positions are bigint where integral (checkpoint_ms) and float8 where
--     seeded fractional offsets make them fractional (cycle starts), so
--     every accumulator value round-trips bit-exactly.
--   * domain_* is the market-domain cycle accumulator: the located market
--     cycle index, its absolute start instant, and its exact anchor and
--     boundary levels at checkpoint_ms. Resuming builds cycle
--     domain_cycle_index from the seed and walks forward from
--     domain_cycle_start_ms with the stored anchor/boundary — the identical
--     floating-point sequence the origin walk would produce.
--   * crash_* is the crash/rally accumulator, frozen at the END of the last
--     candidate episode window at or before checkpoint_ms: crash_cursor_ms
--     is that window end (or the timeline origin when no candidate has
--     completed), crash_episode_index is the NEXT candidate index, and
--     crash_factor is the exact product of the permanent residuals of all
--     activated episodes completed at or before checkpoint_ms. THE
--     IN-FLIGHT EPISODE RULE: an episode whose window CONTAINS
--     checkpoint_ms is never burned into the accumulator; on resume it is
--     redrawn from the seed (a pure function) and re-evaluated transiently,
--     so a checkpoint taken mid-crash or mid-rally resumes bit-identically
--     as well.
--   * activation_context records the gating context the crash accumulator
--     was frozen under (the V2 hidden lifecycle state: GROWTH / PLATEAU /
--     DECLINE / COLLAPSE). The stateless engine gates episode activation on
--     the CURRENT lifecycle input, so a resume is only bit-identical to the
--     origin engine while the lifecycle is unchanged: on any lifecycle
--     transition the consumer must discard the crash accumulator (never the
--     domain accumulator, which has no lifecycle dependence) and re-freeze
--     from the origin under the new state. Lifecycle transitions are rare
--     (<= 3 per 30-minute cycle), so this keeps live prices ALWAYS
--     bit-identical to the pre-checkpoint stateless engine at trivial cost.
--   * Corrupt, future or wrong-identity checkpoints are a hard failure, not
--     a silent fallback: the engine validates every checkpoint it resumes
--     from and throws (game/pricingCheckpoint.js), and the CHECK constraints
--     below make structurally impossible accumulator state unwritable.
--   * This table is internal-only: no public endpoint exposes it, the seed
--     never leaves the server, and no column here feeds users, portfolios,
--     transactions, cash events or coin-event rows.
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
-- 1. market_price_checkpoints: one resumable pricing accumulator per
--    (coin, timeline seed).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.coins') IS NULL THEN
    RAISE EXCEPTION 'migration 023: coins does not exist. Apply the base schema first.';
  END IF;

  IF to_regclass('public.market_price_checkpoints') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: ' || expected.name AS problem
      FROM (VALUES
        ('coin_id',              'integer',                  'NO'),
        ('seed',                 'text',                     'NO'),
        ('checkpoint_ms',        'bigint',                   'NO'),
        ('domain_cycle_index',   'integer',                  'NO'),
        ('domain_cycle_start_ms','double precision',         'NO'),
        ('domain_anchor',        'double precision',         'NO'),
        ('domain_boundary',      'double precision',         'NO'),
        ('crash_episode_index',  'integer',                  'NO'),
        ('crash_cursor_ms',      'double precision',         'NO'),
        ('crash_factor',         'double precision',         'NO'),
        ('activation_context',   'text',                     'NO'),
        ('created_at',           'timestamp with time zone', 'NO'),
        ('updated_at',           'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'market_price_checkpoints'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'market_price_checkpoints'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'updated_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'market_price_checkpoints'
          AND c.column_name = 'updated_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on (coin_id, seed)'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'market_price_checkpoints'
          AND tc.constraint_type = 'PRIMARY KEY'
        GROUP BY tc.constraint_name
        HAVING COUNT(*) = 2
           AND MIN(kcu.column_name) = 'coin_id'
           AND MAX(kcu.column_name) = 'seed'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 023: incompatible pre-existing market_price_checkpoints table: %', array_to_string(incompatible, '; ');
    END IF;

    RAISE NOTICE 'migration 023: market_price_checkpoints already exists with the expected shape; leaving it unchanged';
    RETURN;
  END IF;

  CREATE TABLE public.market_price_checkpoints (
    coin_id               integer                  NOT NULL REFERENCES public.coins (coin_id),
    seed                  text                     NOT NULL,
    -- Authoritative time (epoch ms) this checkpoint was taken at.
    checkpoint_ms         bigint                   NOT NULL,
    -- Market-domain cycle accumulator at checkpoint_ms. The cycle start is
    -- an exact double: seeded stagger offsets make cycle boundaries
    -- fractional, and float8 round-trips the accumulated double bit-exactly.
    domain_cycle_index    integer                  NOT NULL,
    domain_cycle_start_ms double precision         NOT NULL,
    domain_anchor         double precision         NOT NULL,
    domain_boundary       double precision         NOT NULL,
    -- Crash/rally accumulator frozen at the last episode boundary <=
    -- checkpoint_ms (the in-flight episode is never frozen). float8 for the
    -- cursor keeps the round-trip exact under any timeline origin.
    crash_episode_index   integer                  NOT NULL,
    crash_cursor_ms       double precision         NOT NULL,
    crash_factor          double precision         NOT NULL,
    -- The gating context the crash accumulator was frozen under (V2: the
    -- hidden lifecycle state). A consumer whose current context differs
    -- must discard the crash accumulator and re-freeze from the origin.
    activation_context    text                     NOT NULL,
    created_at            timestamp with time zone NOT NULL DEFAULT now(),
    updated_at            timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT market_price_checkpoints_pkey PRIMARY KEY (coin_id, seed),
    CONSTRAINT market_price_checkpoints_time_nonneg CHECK (checkpoint_ms >= 0),
    CONSTRAINT market_price_checkpoints_cycle_index_nonneg CHECK (domain_cycle_index >= 0),
    CONSTRAINT market_price_checkpoints_anchor_positive CHECK (domain_anchor > 0),
    CONSTRAINT market_price_checkpoints_boundary_positive CHECK (domain_boundary > 0),
    CONSTRAINT market_price_checkpoints_episode_index_positive CHECK (crash_episode_index >= 1),
    CONSTRAINT market_price_checkpoints_factor_positive CHECK (crash_factor > 0)
  );
END $$;
