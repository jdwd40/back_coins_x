-- Crypto Chaos persistent-market Stage 2: explicit persistent world identity
-- and separate per-coin persistent market state.
-- Production DDL source of truth for the market_worlds and market_coin_state
-- tables. Applied to the test database by db/seed.js so tests share this
-- exact DDL.
--
-- Design rules:
--   * market_worlds is the explicit identity of the ONE persistent market
--     world: its version, its persisted deterministic seed (server-internal,
--     never exposed publicly), its epoch origin instant and its active
--     flag. At most ONE world may be active at a time (enforced by the
--     partial unique index) — there is exactly one writable authoritative
--     persistent economy, and it lives in exactly one active world.
--   * market_coin_state is the separate persistent per-coin market state,
--     deliberately independent of the Apocalypse cycle tables: a
--     bidirectional condition (positive = strong, negative = stressed,
--     bounded to [-1, 1]), the structural reference price the weak
--     log-space restoring force pulls toward, a DECAYING peak reference
--     (never an all-time monotonic peak), and the explicit death
--     status/timestamp. Death here is permanent and preserves history; the
--     Stage 9 death authority is the only writer of the DEAD transition.
--   * archetype is stored explicitly per coin: a coin whose archetype is
--     missing or unknown fails validation at write time — it is never
--     silently defaulted (the Stage 9 replacement-pool rule applies the
--     same contract to newly initialised coins).
--   * Legacy Apocalypse tables (apocalypse_*) remain untouched historical /
--     archive data. Nothing in this migration reads, writes, renames or
--     drops them.
--   * Both tables are internal-only: no public endpoint exposes the seed or
--     the accumulator internals.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive and additive: only NEW tables/indexes are
--     created; no row, column, constraint or trigger of any existing table
--     is dropped, rewritten or backfilled.
--   * If the tables already exist, their shape is verified explicitly. An
--     incompatible pre-existing table aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT EXISTS.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.coins') IS NULL THEN
    RAISE EXCEPTION 'migration 024: coins does not exist. Apply the base schema first.';
  END IF;

  -- -----------------------------------------------------------------------
  -- 1. market_worlds: the explicit persistent-world identity.
  -- -----------------------------------------------------------------------
  IF to_regclass('public.market_worlds') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: market_worlds.' || expected.name AS problem
      FROM (VALUES
        ('world_id',         'integer',                  'NO'),
        ('version',          'integer',                  'NO'),
        ('seed',             'text',                     'NO'),
        ('epoch_started_at', 'timestamp with time zone', 'NO'),
        ('active',           'boolean',                  'NO'),
        ('created_at',       'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'market_worlds'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'market_worlds.world_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'market_worlds'
          AND c.column_name = 'world_id'
          AND c.column_default LIKE 'nextval(%'
      )
    ) problems;
    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 024: incompatible pre-existing market_worlds table: %', array_to_string(incompatible, '; ');
    END IF;
    RAISE NOTICE 'migration 024: market_worlds already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE SEQUENCE IF NOT EXISTS public.market_worlds_world_id_seq;
    CREATE TABLE public.market_worlds (
      world_id         integer                  NOT NULL DEFAULT nextval('market_worlds_world_id_seq'),
      version          integer                  NOT NULL,
      seed             text                     NOT NULL,
      epoch_started_at timestamp with time zone NOT NULL,
      active           boolean                  NOT NULL DEFAULT true,
      created_at       timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT market_worlds_pkey PRIMARY KEY (world_id),
      CONSTRAINT market_worlds_version_positive CHECK (version >= 1)
    );
  END IF;

  -- At most one ACTIVE persistent world.
  CREATE UNIQUE INDEX IF NOT EXISTS market_worlds_single_active
    ON public.market_worlds ((active)) WHERE active;

  -- -----------------------------------------------------------------------
  -- 2. market_coin_state: separate persistent per-coin market state.
  -- -----------------------------------------------------------------------
  IF to_regclass('public.market_coin_state') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: market_coin_state.' || expected.name AS problem
      FROM (VALUES
        ('coin_id',             'integer',                  'NO'),
        ('world_id',            'integer',                  'NO'),
        ('archetype',           'text',                     'NO'),
        ('condition',           'double precision',         'NO'),
        ('structural_reference','double precision',         'NO'),
        ('peak_reference',      'double precision',         'NO'),
        ('status',              'text',                     'NO'),
        ('died_at',             'timestamp with time zone', 'YES'),
        ('created_at',          'timestamp with time zone', 'NO'),
        ('updated_at',          'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'market_coin_state'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
    ) problems;
    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 024: incompatible pre-existing market_coin_state table: %', array_to_string(incompatible, '; ');
    END IF;
    RAISE NOTICE 'migration 024: market_coin_state already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.market_coin_state (
      coin_id              integer                  NOT NULL REFERENCES public.coins (coin_id),
      world_id             integer                  NOT NULL REFERENCES public.market_worlds (world_id),
      archetype            text                     NOT NULL,
      -- Bidirectional per-coin condition: positive = strong, negative =
      -- stressed, bounded. Feeds the Stage 2+ collapse-risk domain and the
      -- Stage 9 explicit death decision; never alone sufficient to kill.
      condition            double precision         NOT NULL,
      -- The structural reference price (log-space anchor) the weak
      -- restoring force pulls toward. Strictly positive.
      structural_reference double precision         NOT NULL,
      -- The DECAYING reference peak used for drawdown/condition: rolls
      -- downward over time, so it is never an all-time monotonic peak.
      peak_reference       double precision         NOT NULL,
      status               text                     NOT NULL DEFAULT 'ALIVE',
      died_at              timestamp with time zone,
      created_at           timestamp with time zone NOT NULL DEFAULT now(),
      updated_at           timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT market_coin_state_pkey PRIMARY KEY (coin_id),
      CONSTRAINT market_coin_state_condition_bounded CHECK (condition >= -1 AND condition <= 1),
      CONSTRAINT market_coin_state_structural_positive CHECK (structural_reference > 0),
      CONSTRAINT market_coin_state_peak_positive CHECK (peak_reference > 0),
      CONSTRAINT market_coin_state_status_known CHECK (status IN ('ALIVE', 'DEAD')),
      -- Death is explicit AND timestamped, or absent entirely — never one
      -- without the other.
      CONSTRAINT market_coin_state_death_consistent CHECK (
        (status = 'DEAD' AND died_at IS NOT NULL)
        OR (status = 'ALIVE' AND died_at IS NULL)
      )
    );
  END IF;
END $$;
