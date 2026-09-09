-- Director Coin Events Wave 4: append-only Director decision history
-- (director_decision_history) — the persisted public-safe decision ledger
-- backing GET /api/persistent/runtime.
--
-- director_control_state (migration 029/030/031) carries ONLY the CURRENT
-- committed decision cursor; this table preserves every committed decision
-- (world_id, decision_index) forever, append-only, so the public runtime
-- endpoint can serve recentDecisions without ever exposing the raw reason
-- text or the decision index. Each row carries the decision's public
-- projection inputs (mode/direction/intensity/window) plus a
-- server-mapped summary_code from a fixed allowlist (the raw internal
-- reason is NEVER copied here).
--
-- Design rules:
--   * APPEND-ONLY: the application path only ever INSERTs (through
--     models/directorDecisionHistory.model.js). Nothing updates or deletes
--     rows; committed decisions are immutable history.
--   * UNIQUE (world_id, decision_index) is the replay/idempotency
--     backstop, mirroring the persistent_coin_events identity convention:
--     an identical retry at the same identity is a write-free no-op, a
--     divergent payload at a committed identity fails loudly at the model
--     layer.
--   * Seeding: when the table is created against an EXISTING database,
--     each committed director_control_state row seeds EXACTLY ONE history
--     row for its current decision, with the summary mapped from the
--     reason prefix onto the allowlist (unknown reasons -> OTHER_SAFE).
--     No control row means no seed. The seed is itself idempotent
--     (ON CONFLICT DO NOTHING), so a replayed migration can never
--     duplicate a row.
--   * Legacy Apocalypse tables (apocalypse_*) remain untouched. Nothing
--     here reads, writes, renames or drops them.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive and additive: only a NEW table/index is
--     created plus the one-row-per-world seed; no row, column, constraint
--     or trigger of any existing table is dropped, rewritten or
--     backfilled.
--   * If the table already exists, its shape is verified explicitly. An
--     incompatible pre-existing object aborts the migration with a clear
--     error instead of being silently accepted by CREATE ... IF NOT
--     EXISTS. A correctly-shaped pre-existing table is left exactly as-is
--     (no reseed).
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.market_worlds') IS NULL THEN
    RAISE EXCEPTION 'migration 032: market_worlds does not exist. Apply migration 024 first.';
  END IF;
  IF to_regclass('public.director_control_state') IS NULL THEN
    RAISE EXCEPTION 'migration 032: director_control_state does not exist. Apply migration 029 first.';
  END IF;

  IF to_regclass('public.director_decision_history') IS NOT NULL THEN
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'missing or wrong column: director_decision_history.' || expected.name AS problem
      FROM (VALUES
        ('decision_id',    'bigint',                   'NO'),
        ('world_id',       'integer',                  'NO'),
        ('decision_index', 'integer',                  'NO'),
        ('mode',           'character varying',        'NO'),
        ('direction',      'character varying',        'NO'),
        ('intensity',      'double precision',         'NO'),
        ('started_at',     'timestamp with time zone', 'NO'),
        ('ends_at',        'timestamp with time zone', 'NO'),
        ('summary_code',   'character varying',        'NO'),
        ('created_at',     'timestamp with time zone', 'NO')
      ) AS expected(name, dtype, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'director_decision_history'
          AND c.column_name = expected.name
          AND c.data_type = expected.dtype
          AND c.is_nullable = expected.nullable
      )
      UNION ALL
      SELECT 'decision_id is not backed by a sequence default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'director_decision_history'
          AND c.column_name = 'decision_id'
          AND c.column_default LIKE 'nextval(%'
      )
      UNION ALL
      SELECT 'created_at is missing its now() default'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'director_decision_history'
          AND c.column_name = 'created_at'
          AND c.column_default LIKE 'now()%'
      )
      UNION ALL
      SELECT 'missing primary key on decision_id'
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'director_decision_history'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'decision_id'
      )
      UNION ALL
      SELECT 'missing unique constraint on (world_id, decision_index)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_decision_history'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (world_id, decision_index)%'
      )
      UNION ALL
      SELECT 'missing foreign key world_id -> market_worlds'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_decision_history'::regclass
          AND contype = 'f'
          AND confrelid = 'public.market_worlds'::regclass
          AND pg_get_constraintdef(oid) ILIKE 'FOREIGN KEY (world_id)%'
      )
      -- Every CHECK the DDL below creates is verified by EXACT constraint
      -- name AND a semantic definition predicate (the migration 029
      -- convention): the name pins the contract; the predicate proves the
      -- named constraint carries the intended semantics.
      UNION ALL
      SELECT 'missing or incompatible check constraint: director_decision_history_mode_known (mode vocabulary)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_decision_history'::regclass
          AND contype = 'c'
          AND conname = 'director_decision_history_mode_known'
          AND pg_get_constraintdef(oid) ILIKE '%mode%'
          AND pg_get_constraintdef(oid) ILIKE '%NORMAL%BOOM%BUST%RESCUE%'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: director_decision_history_direction_known (direction vocabulary)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_decision_history'::regclass
          AND contype = 'c'
          AND conname = 'director_decision_history_direction_known'
          AND pg_get_constraintdef(oid) ILIKE '%direction%'
          AND pg_get_constraintdef(oid) ILIKE '%POSITIVE%'
          AND pg_get_constraintdef(oid) ILIKE '%NEGATIVE%'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: director_decision_history_intensity_bounded ([0, 1])'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_decision_history'::regclass
          AND contype = 'c'
          AND conname = 'director_decision_history_intensity_bounded'
          AND pg_get_constraintdef(oid) ~ 'intensity >= \(?0'
          AND pg_get_constraintdef(oid) ~ 'intensity <= \(?1'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: director_decision_history_decision_index_nonneg (decision_index >= 0)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_decision_history'::regclass
          AND contype = 'c'
          AND conname = 'director_decision_history_decision_index_nonneg'
          AND pg_get_constraintdef(oid) ~ 'decision_index >= \(?0'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: director_decision_history_window_positive (ends_at > started_at)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_decision_history'::regclass
          AND contype = 'c'
          AND conname = 'director_decision_history_window_positive'
          AND pg_get_constraintdef(oid) ~ 'ends_at > started_at'
      )
      UNION ALL
      SELECT 'missing or incompatible check constraint: director_decision_history_summary_known (summary allowlist)'
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.director_decision_history'::regclass
          AND contype = 'c'
          AND conname = 'director_decision_history_summary_known'
          AND pg_get_constraintdef(oid) ILIKE '%summary_code%'
          AND pg_get_constraintdef(oid) ILIKE '%GENESIS_NORMAL%NORMAL_SWING%REFRACTORY_NORMAL%STAGNATION_SWING%RESCUE_DISTRESS%OVERHEAT_CORRECTION%ROLE_ROTATION%OTHER_SAFE%'
      )
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 032: existing director_decision_history table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;

    RAISE NOTICE 'migration 032: director_decision_history already exists with the expected shape; leaving it unchanged (no reseed)';
  ELSE
    CREATE TABLE public.director_decision_history (
      -- Surrogate row identity (insert order); NEVER exposed publicly.
      decision_id    BIGSERIAL PRIMARY KEY,
      -- The persistent world this decision belongs to.
      world_id       INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      -- The committed decision cursor (monotone per world). Together with
      -- the UNIQUE below this is the replay/idempotency backstop.
      decision_index INTEGER NOT NULL,
      mode           VARCHAR(8) NOT NULL,
      direction      VARCHAR(8) NOT NULL,
      intensity      DOUBLE PRECISION NOT NULL,
      started_at     TIMESTAMPTZ NOT NULL,
      ends_at        TIMESTAMPTZ NOT NULL,
      -- The public-safe decision summary. The raw internal reason is never
      -- persisted here; only this allowlisted code is.
      summary_code   VARCHAR(32) NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- All CHECKs are EXPLICITLY NAMED (migration 029 convention): the
      -- existing-table compatibility probe above and
      -- db/verify-game-schema.js pin these names.
      CONSTRAINT director_decision_history_decision_index_nonneg CHECK (decision_index >= 0),
      CONSTRAINT director_decision_history_mode_known CHECK (mode IN ('NORMAL', 'BOOM', 'BUST', 'RESCUE')),
      CONSTRAINT director_decision_history_direction_known CHECK (direction IN ('POSITIVE', 'NEGATIVE')),
      CONSTRAINT director_decision_history_intensity_bounded CHECK (intensity >= 0 AND intensity <= 1),
      CONSTRAINT director_decision_history_window_positive CHECK (ends_at > started_at),
      CONSTRAINT director_decision_history_summary_known CHECK (summary_code IN (
        'GENESIS_NORMAL', 'NORMAL_SWING', 'REFRACTORY_NORMAL', 'STAGNATION_SWING',
        'RESCUE_DISTRESS', 'OVERHEAT_CORRECTION', 'ROLE_ROTATION', 'OTHER_SAFE'
      )),
      -- The idempotency backstop: one row per committed decision identity,
      -- ever. Identical retry is a no-op; divergence fails at the model.
      UNIQUE (world_id, decision_index)
    );

    -- Seed EXACTLY ONE history row per existing committed control row for
    -- its current decision (no control row -> no seed). The summary is
    -- mapped safely onto the allowlist from the reason prefix — the SAME
    -- mapping models/directorDecisionHistory.model.js#summaryCodeForReason
    -- applies at write time — and unknown reasons map to OTHER_SAFE. The
    -- raw reason text is never copied. ON CONFLICT DO NOTHING keeps a
    -- replayed seed write-free.
    INSERT INTO public.director_decision_history
      (world_id, decision_index, mode, direction, intensity, started_at, ends_at, summary_code)
    SELECT
      s.world_id,
      s.decision_index,
      s.mode,
      s.direction,
      s.intensity,
      s.started_at,
      s.ends_at,
      CASE
        WHEN s.reason LIKE 'genesis:%' THEN 'GENESIS_NORMAL'
        WHEN s.reason LIKE 'refractory:%' THEN 'REFRACTORY_NORMAL'
        WHEN s.reason LIKE 'stagnation swing:%' THEN 'STAGNATION_SWING'
        WHEN s.reason LIKE 'rescue:%' THEN 'RESCUE_DISTRESS'
        WHEN s.reason LIKE 'overheat correction:%' THEN 'OVERHEAT_CORRECTION'
        WHEN s.reason LIKE 'role rotation:%' THEN 'ROLE_ROTATION'
        WHEN s.reason = 'normal swing window' THEN 'NORMAL_SWING'
        ELSE 'OTHER_SAFE'
      END
    FROM public.director_control_state s
    ON CONFLICT (world_id, decision_index) DO NOTHING;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Latest-decisions lookup index: the public runtime endpoint reads the
-- newest N decisions per world. Same-named pre-existing index must be
-- exactly this index; anything else is an incompatibility and aborts.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_director_decision_history_latest') THEN
    -- Exact shape verification: a non-unique btree on exactly the ordered
    -- key list (world_id, decision_index DESC).
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname = 'idx_director_decision_history_latest'
        AND c.relnamespace = 'public'::regnamespace
        AND i.indrelid = 'public.director_decision_history'::regclass
        AND am.amname = 'btree'
        AND NOT i.indisunique
        AND (
          SELECT string_agg(a.attname || ' ' || CASE WHEN (i.indoption[k.n] & 1) = 1 THEN 'DESC' ELSE 'ASC' END, ',' ORDER BY k.n)
          FROM generate_series(0, i.indnkeyatts - 1) AS k(n)
          JOIN pg_attribute a
            ON a.attrelid = i.indrelid
           AND a.attnum = i.indkey[k.n]
        ) = 'world_id ASC,decision_index DESC'
    ) THEN
      RAISE EXCEPTION 'migration 032: existing index idx_director_decision_history_latest is INCOMPATIBLE (expected a non-unique index on (world_id, decision_index DESC)). Fix it manually; the migration will not modify it.';
    END IF;
  ELSE
    CREATE INDEX idx_director_decision_history_latest ON public.director_decision_history (world_id, decision_index DESC);
  END IF;
END $$;
