-- Issue #56: durable, cross-process persistent bot worker heartbeat
-- (persistent_bot_heartbeat) — one row per persistent world, written by
-- whichever process runs the bot tick, read by GET /api/persistent/runtime.
--
-- persistent_bot_ticks (migration 028) stays the duplicate-tick CLAIM
-- authority and is unchanged. A claim proves only that a tick STARTED; it
-- can never represent success. This table records the distinct facts:
--   * last_attempt_at      — a worker reached the tick with the run lock;
--   * last_claimed_*       — the newest tick a worker claimed;
--   * last_success_*       — the newest tick that COMPLETED every bot;
--   * last_action_at       — the last committed bot trade/loan/repay (recorded
--     as each action commits, even if the tick later fails);
--   * last_failure_at/last_outcome/consecutive_failures — the newest
--     failed/aborted attempt (all-signal failure, timeout, error), using a
--     fixed public-safe outcome vocabulary (no raw error text is stored);
--   * last_*_count         — the newest completed tick's action summary.
--
-- Design rules:
--   * Fully additive: one NEW table; nothing existing is touched. Legacy
--     apocalypse_* tables and every persistent_* table stay as they are.
--   * No seeds, Director internals, strategy/config internals or raw
--     errors are ever stored here.
--   * If the table already exists, its COMPLETE shape is verified
--     explicitly (exact column set/types/defaults, the enforced CHECK/PK/FK
--     expressions themselves — not just their names — validation state, no
--     extra constraints or triggers). An incompatible pre-existing object
--     aborts the migration with a clear error instead of being silently
--     accepted by CREATE ... IF NOT EXISTS. A correctly-shaped pre-existing
--     table is left exactly as-is.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
DECLARE
  incompatible text[];
BEGIN
  IF to_regclass('public.market_worlds') IS NULL THEN
    RAISE EXCEPTION 'migration 033: market_worlds does not exist. Apply migration 024 first.';
  END IF;

  IF to_regclass('public.persistent_bot_heartbeat') IS NOT NULL THEN
    -- Complete-shape comparison (review R4): the column set, types,
    -- nullability and defaults must match EXACTLY (no missing or extra
    -- columns), every CHECK must enforce exactly the intended expression
    -- (compared VERBATIM with the server's own canonical deparse — no text
    -- normalisation at all, so quoted literals such as 'public.SUCCESS',
    -- casts and "OR TRUE" weakenings can never be erased into a match;
    -- review R4/R4b), the PK/FK are compared STRUCTURALLY on catalogue
    -- column numbers and the referenced relation's OID (so search_path
    -- display of the schema prefix is irrelevant), every constraint
    -- must be VALIDATED, there must be no extra constraint and no user
    -- trigger, and the object must be an ordinary table.
    SELECT array_agg(problem) INTO incompatible FROM (
      SELECT 'persistent_bot_heartbeat is not an ordinary table' AS problem
      WHERE (SELECT relkind FROM pg_class WHERE oid = 'public.persistent_bot_heartbeat'::regclass) <> 'r'
      UNION ALL
      SELECT 'column mismatch: ' || COALESCE(expected.name, actual.name)
             || ' (expected ' || COALESCE(expected.dtype || ' not null=' || expected.nn || ' default=' || COALESCE(expected.dflt, 'none'), 'no such column')
             || '; found ' || COALESCE(actual.dtype || ' not null=' || actual.nn || ' default=' || COALESCE(actual.dflt, 'none'), 'no such column') || ')'
      FROM (VALUES
        ('world_id',             'integer',                  true,  NULL),
        ('last_attempt_at',      'timestamp with time zone', false, NULL),
        ('last_claimed_tick_id', 'bigint',                   false, NULL),
        ('last_claimed_at',      'timestamp with time zone', false, NULL),
        ('last_success_tick_id', 'bigint',                   false, NULL),
        ('last_success_at',      'timestamp with time zone', false, NULL),
        ('last_action_at',       'timestamp with time zone', false, NULL),
        ('last_failure_at',      'timestamp with time zone', false, NULL),
        ('last_outcome',         'character varying(16)',    false, NULL),
        ('consecutive_failures', 'integer',                  true,  '0'),
        ('last_trade_count',     'integer',                  false, NULL),
        ('last_hold_count',      'integer',                  false, NULL),
        ('last_skip_count',      'integer',                  false, NULL),
        ('updated_at',           'timestamp with time zone', true,  'now()')
      ) AS expected(name, dtype, nn, dflt)
      FULL OUTER JOIN (
        SELECT a.attname::text AS name,
               format_type(a.atttypid, a.atttypmod) AS dtype,
               a.attnotnull AS nn,
               pg_get_expr(d.adbin, d.adrelid) AS dflt
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'public.persistent_bot_heartbeat'::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
      ) AS actual ON actual.name = expected.name
      WHERE expected.name IS NULL OR actual.name IS NULL
         OR actual.dtype <> expected.dtype
         OR actual.nn <> expected.nn
         OR actual.dflt IS DISTINCT FROM expected.dflt
      UNION ALL
      SELECT 'constraint mismatch: ' || COALESCE(expected.label, actual.conname)
             || CASE WHEN actual.conname IS NULL THEN ' is missing'
                     WHEN expected.label IS NULL THEN ' is unexpected (' || actual.def || ')'
                     WHEN NOT actual.convalidated THEN ' is NOT VALID'
                     ELSE ' does not enforce the intended expression (found ' || actual.def || ')' END
      FROM (VALUES
        -- PK/FK: def is NULL; they are verified structurally (keys_ok).
        -- CHECKs: the EXACT canonical pg_get_constraintdef text.
        ('p', NULL, 'primary key', NULL),
        ('f', NULL, 'foreign key world_id -> market_worlds', NULL),
        ('c', 'persistent_bot_heartbeat_outcome_known', 'persistent_bot_heartbeat_outcome_known',
         'CHECK (((last_outcome IS NULL) OR ((last_outcome)::text = ANY ((ARRAY[''SUCCESS''::character varying, ''SIGNALS_FAILED''::character varying, ''TIMEOUT''::character varying, ''ERROR''::character varying])::text[]))))'),
        ('c', 'persistent_bot_heartbeat_failures_nonneg', 'persistent_bot_heartbeat_failures_nonneg',
         'CHECK ((consecutive_failures >= 0))'),
        ('c', 'persistent_bot_heartbeat_claim_pair', 'persistent_bot_heartbeat_claim_pair',
         'CHECK (((last_claimed_tick_id IS NULL) = (last_claimed_at IS NULL)))'),
        ('c', 'persistent_bot_heartbeat_success_pair', 'persistent_bot_heartbeat_success_pair',
         'CHECK (((last_success_tick_id IS NULL) = (last_success_at IS NULL)))'),
        ('c', 'persistent_bot_heartbeat_values_nonneg', 'persistent_bot_heartbeat_values_nonneg',
         'CHECK ((((last_claimed_tick_id IS NULL) OR (last_claimed_tick_id >= 0)) AND ((last_success_tick_id IS NULL) OR (last_success_tick_id >= 0)) AND ((last_trade_count IS NULL) OR (last_trade_count >= 0)) AND ((last_hold_count IS NULL) OR (last_hold_count >= 0)) AND ((last_skip_count IS NULL) OR (last_skip_count >= 0))))')
      ) AS expected(contype, conname, label, def)
      FULL OUTER JOIN (
        SELECT CASE WHEN c.contype IN ('p', 'f') THEN c.contype::text ELSE c.conname::text END AS joinkey,
               c.conname::text AS conname,
               c.contype::text AS contype,
               c.convalidated,
               c.condeferrable,
               c.confupdtype::text AS confupdtype,
               c.confdeltype::text AS confdeltype,
               c.confmatchtype::text AS confmatchtype,
               pg_get_constraintdef(c.oid) AS def,
               -- Structural key check: exactly (world_id), and for the FK
               -- exactly public.market_worlds (by OID) (world_id).
               CASE c.contype
                 WHEN 'p' THEN c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                                  WHERE a.attrelid = c.conrelid AND a.attname = 'world_id' AND NOT a.attisdropped)]
                 WHEN 'f' THEN c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                                  WHERE a.attrelid = c.conrelid AND a.attname = 'world_id' AND NOT a.attisdropped)]
                           AND c.confrelid = 'public.market_worlds'::regclass
                           AND c.confkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                                   WHERE a.attrelid = 'public.market_worlds'::regclass AND a.attname = 'world_id' AND NOT a.attisdropped)]
                 ELSE NULL
               END AS keys_ok
        FROM pg_constraint c
        WHERE c.conrelid = 'public.persistent_bot_heartbeat'::regclass
          AND c.contype <> 'n' -- PG18 catalogues NOT NULL; checked per column above
      ) AS actual
        ON actual.joinkey = COALESCE(expected.conname, expected.contype)
      WHERE expected.contype IS NULL OR actual.conname IS NULL
         OR actual.contype <> expected.contype
         OR NOT actual.convalidated
         OR actual.condeferrable
         OR (actual.contype IN ('p', 'f') AND actual.keys_ok IS NOT TRUE)
         OR (actual.contype = 'c' AND actual.def IS DISTINCT FROM expected.def)
         OR (actual.contype = 'f' AND (actual.confupdtype <> 'a' OR actual.confdeltype <> 'a' OR actual.confmatchtype <> 's'))
      UNION ALL
      SELECT 'unexpected user trigger: ' || t.tgname
      FROM pg_trigger t
      WHERE t.tgrelid = 'public.persistent_bot_heartbeat'::regclass AND NOT t.tgisinternal
    ) problems;

    IF incompatible IS NOT NULL THEN
      RAISE EXCEPTION 'migration 033: existing persistent_bot_heartbeat table is INCOMPATIBLE — %. Fix or drop the conflicting table manually; the migration will not modify it.', array_to_string(incompatible, '; ');
    END IF;

    RAISE NOTICE 'migration 033: persistent_bot_heartbeat already exists with the expected shape; leaving it unchanged';
  ELSE
    CREATE TABLE public.persistent_bot_heartbeat (
      world_id             INTEGER NOT NULL REFERENCES public.market_worlds (world_id),
      last_attempt_at      TIMESTAMPTZ NULL,
      last_claimed_tick_id BIGINT NULL,
      last_claimed_at      TIMESTAMPTZ NULL,
      last_success_tick_id BIGINT NULL,
      last_success_at      TIMESTAMPTZ NULL,
      last_action_at       TIMESTAMPTZ NULL,
      last_failure_at      TIMESTAMPTZ NULL,
      last_outcome         VARCHAR(16) NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_trade_count     INTEGER NULL,
      last_hold_count      INTEGER NULL,
      last_skip_count      INTEGER NULL,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT persistent_bot_heartbeat_pkey PRIMARY KEY (world_id),
      CONSTRAINT persistent_bot_heartbeat_outcome_known CHECK (
        last_outcome IS NULL OR last_outcome IN ('SUCCESS', 'SIGNALS_FAILED', 'TIMEOUT', 'ERROR')
      ),
      CONSTRAINT persistent_bot_heartbeat_failures_nonneg CHECK (consecutive_failures >= 0),
      CONSTRAINT persistent_bot_heartbeat_claim_pair CHECK (
        (last_claimed_tick_id IS NULL) = (last_claimed_at IS NULL)
      ),
      CONSTRAINT persistent_bot_heartbeat_success_pair CHECK (
        (last_success_tick_id IS NULL) = (last_success_at IS NULL)
      ),
      CONSTRAINT persistent_bot_heartbeat_values_nonneg CHECK (
        (last_claimed_tick_id IS NULL OR last_claimed_tick_id >= 0)
        AND (last_success_tick_id IS NULL OR last_success_tick_id >= 0)
        AND (last_trade_count IS NULL OR last_trade_count >= 0)
        AND (last_hold_count IS NULL OR last_hold_count >= 0)
        AND (last_skip_count IS NULL OR last_skip_count >= 0)
      )
    );
  END IF;
END $$;
