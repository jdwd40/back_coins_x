-- seed.sql — NON-PRODUCTION fixtures only (disposable dev/test databases).
-- Three synthetic assets with simulation state; market starts halted.
-- Never contains real user data, emails, or credentials.

BEGIN;

INSERT INTO coins.assets
  (legacy_coin_id, name, symbol, current_price, market_cap, circulating_supply, founder, listed_at)
VALUES
  (1, 'TestCoin Alpha', 'TCA', 10.00000000, 10000000.00, 1000000, 'fixture', '2026-01-01T00:00:00Z'),
  (2, 'TestCoin Beta',  'TCB',  2.50000000,  2500000.00, 1000000, 'fixture', '2026-01-01T00:00:00Z'),
  (3, 'TestCoin Gamma', 'TCG',  0.01000000,    10000.00, 1000000, 'fixture', '2026-01-01T00:00:00Z')
ON CONFLICT (legacy_coin_id) DO NOTHING;

INSERT INTO coins.asset_simulation_state (asset_id, baseline_price, volatility)
SELECT id, current_price, 0.01 FROM coins.assets
ON CONFLICT (asset_id) DO NOTHING;

COMMIT;
