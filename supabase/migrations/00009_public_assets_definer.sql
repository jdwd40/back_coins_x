-- 00009_public_assets_definer.sql
-- Fix: public_assets was security_invoker=true and computed price_change_24h
-- from coins.price_ticks. Anon/authenticated correctly have no SELECT on
-- price_ticks, so PostgREST returned "permission denied for table price_ticks".
-- public_assets is a fixed public market catalogue (no user data) — same safe
-- definer pattern as market_status_view.

BEGIN;

CREATE OR REPLACE VIEW coins.public_assets AS
SELECT
  a.id,
  a.legacy_coin_id,
  a.name,
  a.symbol,
  a.current_price,
  a.market_cap,
  a.circulating_supply,
  a.founder,
  a.listed_at,
  (
    SELECT round((a.current_price - ref.price) / ref.price * 100, 6)
    FROM (
      (SELECT price FROM coins.price_ticks t
        WHERE t.asset_id = a.id AND t.captured_at <= now() - interval '24 hours'
        ORDER BY t.captured_at DESC, t.id DESC LIMIT 1)
      UNION ALL
      (SELECT price FROM coins.price_ticks t
        WHERE t.asset_id = a.id
        ORDER BY t.captured_at ASC, t.id ASC LIMIT 1)
      LIMIT 1
    ) ref
  ) AS price_change_24h
FROM coins.assets a;

COMMENT ON VIEW coins.public_assets IS
  'Public coin catalogue. DEFINER-owned so 24h change can read price_ticks without exposing raw ticks to browser roles.';

REVOKE ALL ON coins.public_assets FROM PUBLIC;
GRANT SELECT ON coins.public_assets TO anon, authenticated;

COMMIT;
