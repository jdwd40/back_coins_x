-- Crypto Chaos V2-2: persistent Power + position cost basis.
-- Production DDL source of truth for the V2-2 Power/cost-basis schema.
-- Applied to the test database by db/seed.js so tests share this exact DDL.
--
-- What this adds:
--   * apocalypse_participants.power INTEGER NOT NULL + CHECK (power >= 0):
--     the participant's STORED Power at power_updated_at. Effective Power is
--     always the lazy reconciliation of this pair against real elapsed time
--     (game/powerDomain.js) — the database never ticks. A user's stored pair
--     is carried verbatim from their previous participant row into each new
--     round by joinRound/initializeCycleParticipants, so Power persists
--     across restart, inactivity and apocalypse rollover. New players start
--     at the game-design maximum (100 at migration time).
--   * apocalypse_participants.power_updated_at TIMESTAMPTZ NOT NULL: the
--     real timestamp the stored Power value is valid at.
--   * apocalypse_holdings.cost_basis DECIMAL(18,2) NOT NULL: the remaining
--     weighted-average cost basis (£) of the open position. Maintained by
--     the locked buy/sell transactions (buy: += round2(total); sell:
--     proportionate removal) and never inferred from mutable prices.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive: only ADDs columns (with defaults) and CHECKs;
--     no existing table/column/row is dropped or rewritten except the
--     deterministic backfills below.
--   * Power backfill: every pre-existing participant is set to the full
--     game-design maximum (100) stamped at the migration instant, so every
--     returning player starts V2-2 with full Power. Deterministic in effect:
--     effective Power is 100 at any read after this migration regardless.
--   * Cost-basis backfill: each pre-existing holding's cost basis is
--     recomputed deterministically by replaying its immutable
--     apocalypse_transactions ledger in (created_at, round_transaction_id)
--     order with the same round-half-up 2dp arithmetic the live trade path
--     uses. The replay's final quantity MUST equal the holding's persisted
--     quantity; a mismatch is a genuine ledger anomaly and aborts the
--     migration (nothing is written — the whole file is one transaction).
--   * If a column already exists with the expected shape (partial retry
--     after manual repair) it is left untouched and its backfill is NOT
--     re-run; an incompatible pre-existing column aborts with a clear error.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

-- ---------------------------------------------------------------------------
-- 1. apocalypse_participants: Power columns.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col record;
BEGIN
  IF to_regclass('public.apocalypse_participants') IS NULL THEN
    RAISE EXCEPTION 'migration 018: required table public.apocalypse_participants does not exist. Apply earlier migrations first.';
  END IF;

  -- power ----------------------------------------------------------------
  SELECT c.data_type, c.numeric_precision, c.numeric_scale, c.is_nullable
    INTO col
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'apocalypse_participants'
     AND c.column_name = 'power';
  IF FOUND THEN
    IF col.data_type <> 'integer' OR col.is_nullable <> 'NO' THEN
      RAISE EXCEPTION 'migration 018: existing column apocalypse_participants.power has an incompatible shape (type=%, nullable=%). Expected integer NOT NULL. Fix it manually; the migration will not modify it.', col.data_type, col.is_nullable;
    END IF;
  ELSE
    ALTER TABLE apocalypse_participants
      ADD COLUMN power INTEGER NOT NULL DEFAULT 100;
    -- Backfill: full Power for every pre-existing participant, stamped at
    -- the migration instant. The DEFAULT covers it; the explicit UPDATE
    -- documents intent and is idempotent within this single transaction.
    UPDATE apocalypse_participants SET power = 100;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.apocalypse_participants'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ 'power >= \(?0'
  ) THEN
    ALTER TABLE apocalypse_participants
      ADD CONSTRAINT apocalypse_participants_power_nonnegative CHECK (power >= 0);
  END IF;

  -- power_updated_at -------------------------------------------------------
  SELECT c.data_type, c.is_nullable
    INTO col
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'apocalypse_participants'
     AND c.column_name = 'power_updated_at';
  IF FOUND THEN
    IF col.data_type <> 'timestamp with time zone' OR col.is_nullable <> 'NO' THEN
      RAISE EXCEPTION 'migration 018: existing column apocalypse_participants.power_updated_at has an incompatible shape (type=%, nullable=%). Expected timestamptz NOT NULL. Fix it manually; the migration will not modify it.', col.data_type, col.is_nullable;
    END IF;
  ELSE
    ALTER TABLE apocalypse_participants
      ADD COLUMN power_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE apocalypse_participants SET power_updated_at = now();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. apocalypse_holdings: cost_basis column + deterministic ledger backfill.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col record;
  holding record;
  tx record;
  replay_qty numeric;
  replay_cb numeric;
BEGIN
  IF to_regclass('public.apocalypse_holdings') IS NULL THEN
    RAISE EXCEPTION 'migration 018: required table public.apocalypse_holdings does not exist. Apply earlier migrations first.';
  END IF;

  SELECT c.data_type, c.numeric_precision, c.numeric_scale, c.is_nullable
    INTO col
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'apocalypse_holdings'
     AND c.column_name = 'cost_basis';
  IF FOUND THEN
    IF col.data_type <> 'numeric' OR col.numeric_precision <> 18 OR col.numeric_scale <> 2 OR col.is_nullable <> 'NO' THEN
      RAISE EXCEPTION 'migration 018: existing column apocalypse_holdings.cost_basis has an incompatible shape (type=numeric(%,%), nullable=%). Expected numeric(18,2) NOT NULL. Fix it manually; the migration will not modify it.', col.numeric_precision, col.numeric_scale, col.is_nullable;
    END IF;
    -- Column already present with the correct shape: partial retry after
    -- manual repair. Do NOT re-backfill — live trades may already be
    -- maintaining the values.
  ELSE
    ALTER TABLE apocalypse_holdings
      ADD COLUMN cost_basis DECIMAL(18, 2) NOT NULL DEFAULT 0;

    -- Deterministic backfill: replay each holding's immutable round ledger
    -- in a fixed order with the same 2dp round-half-up arithmetic the live
    -- buy/sell path uses. BUY adds the rounded consideration; SELL removes
    -- the proportionate share of the remaining basis.
    FOR holding IN
      SELECT h.holding_id, h.participant_id, h.coin_id, h.quantity
        FROM apocalypse_holdings h
       ORDER BY h.holding_id
    LOOP
      replay_qty := 0;
      replay_cb := 0;
      FOR tx IN
        SELECT t.type, t.quantity, t.total_amount
          FROM apocalypse_transactions t
         WHERE t.participant_id = holding.participant_id
           AND t.coin_id = holding.coin_id
         ORDER BY t.created_at, t.round_transaction_id
      LOOP
        IF tx.type = 'BUY' THEN
          replay_qty := replay_qty + tx.quantity;
          replay_cb := round(replay_cb + tx.total_amount, 2);
        ELSE
          IF replay_qty <= 0 OR tx.quantity > replay_qty THEN
            RAISE EXCEPTION 'migration 018: ledger anomaly for holding % (participant %, coin %): SELL of % with only % replayed. Fix the data manually; the migration will not guess a cost basis.',
              holding.holding_id, holding.participant_id, holding.coin_id, tx.quantity, replay_qty;
          END IF;
          replay_cb := round(replay_cb * (replay_qty - tx.quantity) / replay_qty, 2);
          replay_qty := replay_qty - tx.quantity;
        END IF;
      END LOOP;

      IF replay_qty <> holding.quantity THEN
        RAISE EXCEPTION 'migration 018: ledger anomaly for holding % (participant %, coin %): replayed quantity % does not equal persisted quantity %. Fix the data manually; the migration will not guess a cost basis.',
          holding.holding_id, holding.participant_id, holding.coin_id, replay_qty, holding.quantity;
      END IF;

      UPDATE apocalypse_holdings
         SET cost_basis = replay_cb
       WHERE holding_id = holding.holding_id;
    END LOOP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.apocalypse_holdings'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ 'cost_basis >= \(?0'
  ) THEN
    ALTER TABLE apocalypse_holdings
      ADD CONSTRAINT apocalypse_holdings_cost_basis_nonnegative CHECK (cost_basis >= 0);
  END IF;
END $$;
