-- Director Coin Events Wave 2 (PR #36 wave-2 correction): refractory
-- origin tracking on director_control_state.
--
-- Adds the nullable last_intervention_mode column: the mode of the
-- intervention whose ending set last_intervention_ended_at (migration
-- 030's refractory tracker). The adaptive Director decision domain
-- (game/adaptiveDirector.js) reads it for the emergency-refractory
-- policy: a NEWLY encountered death-cluster/severe-drawdown emergency
-- arising during the ordinary refractory may commit RESCUE after only
-- directorControl.emergencyRefractoryMs — but ONLY when the refractory
-- was created by a non-RESCUE window. A RESCUE-created refractory always
-- holds the emergency to the full interventionRefractoryMs, so an
-- emergency can never override the refractory its own ended window
-- created (no permanent RESCUE loop, no direct
-- intervention->intervention transition).
--
-- The column is nullable: pre-correction committed rows carry no origin
-- mode, which the domain reads as "refractory origin unknown" and treats
-- permissively (a newly encountered emergency still answers within the
-- emergency latency after a deploy/restart) — bounded, once, and never a
-- loop: the next committed RESCUE window re-arms the tracker exactly.
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
    RAISE EXCEPTION 'migration 031: director_control_state does not exist. Apply migration 029 first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'director_control_state'
      AND column_name = 'last_intervention_mode'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'director_control_state'
        AND column_name = 'last_intervention_mode'
        AND data_type = 'character varying'
        AND character_maximum_length = 8
        AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'migration 031: existing director_control_state.last_intervention_mode is INCOMPATIBLE (expected a nullable character varying(8)). Fix or drop the conflicting column manually; the migration will not modify it.';
    END IF;
    RAISE NOTICE 'migration 031: director_control_state.last_intervention_mode already exists with the expected shape; leaving it unchanged';
  ELSE
    ALTER TABLE public.director_control_state
      ADD COLUMN last_intervention_mode VARCHAR(8);
  END IF;
END $$;
