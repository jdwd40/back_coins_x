-- Director Coin Events Wave 2 (PR #36 correction): post-intervention
-- refractory tracking on director_control_state.
--
-- Adds the nullable last_intervention_ended_at column: the most recent
-- instant a committed BOOM/BUST/RESCUE window ended. The adaptive Director
-- decision domain (game/adaptiveDirector.js) uses it to hold ordinary
-- triggers (stagnation swings, ordinary RESCUE, overheat corrections) to
-- bounded NORMAL windows for directorControl.interventionRefractoryMs after
-- an intervention ends — persistent flatness, an unchanged rescue signal or
-- sustained overheat can never chain interventions without a NORMAL
-- opportunity. A death-cluster emergency may override, boundedly.
--
-- The column is nullable: pre-correction committed rows carry no tracker
-- (no intervention had been recorded as ended), which the domain reads as
-- "no refractory in progress" — exactly the pre-correction semantics for
-- that row's next decision.
--
-- This migration is safe to run against an EXISTING Coins database:
--   * Fully non-destructive and additive: one NEW nullable column on an
--     existing table; no row, column, constraint or trigger is dropped,
--     rewritten or backfilled.
--   * If the column already exists, its shape is verified explicitly; an
--     incompatible pre-existing column aborts the migration with a clear
--     error instead of being silently accepted.
-- The whole statement batch runs inside a single transaction via
-- db/migrate.js, so a failure leaves the database unchanged.

DO $$
BEGIN
  IF to_regclass('public.director_control_state') IS NULL THEN
    RAISE EXCEPTION 'migration 030: director_control_state does not exist. Apply migration 029 first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'director_control_state'
      AND column_name = 'last_intervention_ended_at'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'director_control_state'
        AND column_name = 'last_intervention_ended_at'
        AND data_type = 'timestamp with time zone'
        AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'migration 030: existing director_control_state.last_intervention_ended_at is INCOMPATIBLE (expected a nullable timestamp with time zone). Fix or drop the conflicting column manually; the migration will not modify it.';
    END IF;
    RAISE NOTICE 'migration 030: director_control_state.last_intervention_ended_at already exists with the expected shape; leaving it unchanged';
  ELSE
    ALTER TABLE public.director_control_state
      ADD COLUMN last_intervention_ended_at TIMESTAMPTZ;
  END IF;
END $$;
