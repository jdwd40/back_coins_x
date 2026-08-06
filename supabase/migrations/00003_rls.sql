-- 00003_rls.sql — grants, dedicated worker role, RLS policies (plan §5)
-- Deny by default: revoke everything, then grant exactly what is needed.

BEGIN;

-- ---------------------------------------------------------------------------
-- Dedicated least-privilege worker login role (plan §5.1). The market worker
-- NEVER uses the project service-role key. Password/CONNECT are managed by
-- ops outside migrations (documented in docs/MIGRATION_RUNBOOK.md).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coins_worker') THEN
    CREATE ROLE coins_worker NOINHERIT LOGIN;
  END IF;
END $$;
COMMENT ON ROLE coins_worker IS
  'Coins market worker: connect + coins schema usage + EXECUTE on approved functions only. No table DML.';

-- ---------------------------------------------------------------------------
-- Schema usage
-- ---------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA coins FROM PUBLIC;
GRANT USAGE ON SCHEMA coins TO anon, authenticated, coins_worker;

-- ---------------------------------------------------------------------------
-- Table grants (RLS still applies; grants alone are not authorization)
-- ---------------------------------------------------------------------------
-- Public market data
GRANT SELECT ON coins.assets, coins.price_candles, coins.market_candles
  TO anon, authenticated;
-- Caller-owned financial reads
GRANT SELECT ON coins.profiles, coins.wallets, coins.holdings, coins.trades
  TO authenticated;
-- Profile username is the only client-mutable column
GRANT UPDATE (username) ON coins.profiles TO authenticated;

-- Everything else has NO client grants: wallets/holdings/trades writes,
-- price_ticks, market_snapshots, market_state, asset_simulation_state,
-- coin_statistics, legacy_identity_map, balance_adjustments.
-- coins_worker gets no table DML — SECURITY DEFINER functions own writes.

-- ---------------------------------------------------------------------------
-- RLS — enabled (not forced): definer functions owned by the migration owner
-- keep working; browser roles are always subject to policies.
-- ---------------------------------------------------------------------------
ALTER TABLE coins.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.wallets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.holdings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.trades        ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.assets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.price_candles ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.market_candles ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.balance_adjustments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.legacy_identity_map   ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.market_state          ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.asset_simulation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.price_ticks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.market_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE coins.coin_statistics       ENABLE ROW LEVEL SECURITY;

-- Public read-only surfaces (non-financial)
CREATE POLICY assets_public_read ON coins.assets
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY price_candles_public_read ON coins.price_candles
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY market_candles_public_read ON coins.market_candles
  FOR SELECT TO anon, authenticated USING (true);

-- Caller-owned rows only (auth.uid() anchored; no USING(true) on financial tables)
CREATE POLICY profiles_select_own ON coins.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY profiles_update_own_username ON coins.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id AND disabled_at IS NULL)
  WITH CHECK (auth.uid() = id);
CREATE POLICY wallets_select_own ON coins.wallets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY holdings_select_own ON coins.holdings
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY trades_select_own ON coins.trades
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- No policies on internal/service tables → deny-by-default for browser roles:
-- price_ticks, market_snapshots, market_state, asset_simulation_state,
-- coin_statistics, legacy_identity_map, balance_adjustments.

COMMIT;
