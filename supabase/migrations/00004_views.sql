-- 00004_views.sql — browser-facing views (plan §4.4)
-- User-scoped views use security_invoker so invoker RLS applies.
-- market_status_view is intentionally definer-owned: it exposes a fixed,
-- safe projection of a singleton public row (no user data), hiding worker
-- metadata as required by the plan — the documented "equivalent safe
-- ownership" case.

BEGIN;

-- Public asset catalogue with derived 24h change (numeric; UI formats)
CREATE OR REPLACE VIEW coins.public_assets
WITH (security_invoker = true) AS
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
  -- 24h change: latest actual tick at/before now()-24h, else earliest known
  -- tick (sparse-history flag), else null. Never a formatted string.
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

-- Own portfolio: holdings + live valuation + P/L. RLS on holdings/wallets
-- keeps this caller-scoped under security_invoker.
CREATE OR REPLACE VIEW coins.my_portfolio
WITH (security_invoker = true) AS
SELECT
  h.asset_id,
  a.name,
  a.symbol,
  h.quantity,
  h.cost_basis,
  a.current_price,
  round(h.quantity * a.current_price, 2)            AS current_value,
  round(h.quantity * a.current_price - h.cost_basis, 2) AS unrealized_pl,
  w.cash_balance,
  h.updated_at AS holding_updated_at
FROM coins.holdings h
JOIN coins.assets  a ON a.id = h.asset_id
JOIN coins.wallets w ON w.user_id = h.user_id
WHERE h.user_id = auth.uid() AND h.quantity > 0;

-- Own trade history with stable frontend column names
CREATE OR REPLACE VIEW coins.my_trades
WITH (security_invoker = true) AS
SELECT
  t.id            AS trade_id,
  t.legacy_transaction_id,
  t.asset_id,
  a.symbol,
  a.name          AS asset_name,
  t.side,
  t.quantity,
  t.unit_price,
  t.total_amount,
  t.cash_balance_after,
  t.holding_quantity_after,
  t.executed_at
FROM coins.trades t
JOIN coins.assets a ON a.id = t.asset_id
WHERE t.user_id = auth.uid()
ORDER BY t.executed_at DESC, t.id DESC;

-- Public market status: fixed safe projection, no worker metadata.
CREATE OR REPLACE VIEW coins.market_status_view AS
SELECT
  ms.is_running,
  ms.cycle,
  ms.cycle_started_at,
  ms.cycle_ends_at,
  greatest(0, extract(epoch FROM ms.cycle_ends_at - now()))::int AS cycle_seconds_remaining,
  ms.tick_sequence,
  ms.last_tick_at,
  ms.halted_reason,
  (SELECT count(*) FROM coins.asset_simulation_state s
     WHERE s.event_type IS NOT NULL AND (s.event_ends_at IS NULL OR s.event_ends_at > now())
  ) AS active_event_count,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'asset_id', s.asset_id, 'event_type', s.event_type,
        'event_multiplier', s.event_multiplier, 'event_ends_at', s.event_ends_at)), '[]'::jsonb)
   FROM coins.asset_simulation_state s
   WHERE s.event_type IS NOT NULL AND (s.event_ends_at IS NULL OR s.event_ends_at > now())
  ) AS active_events
FROM coins.market_state ms;

REVOKE ALL ON coins.public_assets, coins.my_portfolio, coins.my_trades,
  coins.market_status_view FROM PUBLIC;
GRANT SELECT ON coins.public_assets, coins.market_status_view TO anon, authenticated;
GRANT SELECT ON coins.my_portfolio, coins.my_trades TO authenticated;

COMMIT;
