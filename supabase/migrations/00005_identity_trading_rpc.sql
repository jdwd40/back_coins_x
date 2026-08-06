-- 00005_identity_trading_rpc.sql — bootstrap_account, buy_coin, sell_coin
-- Plan §6.1, §8.1–8.3. All SECURITY DEFINER, fixed search_path, auth.uid()
-- anchored, no client-supplied user IDs or prices. Errors are raised with a
-- stable machine-readable message (mapped by the frontend error mapper).

BEGIN;

-- ---------------------------------------------------------------------------
-- bootstrap_account(p_username) — explicit per-user opt-in (NO global
-- auth.users trigger on this shared project). Idempotent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.bootstrap_account(p_username text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_username text := btrim(COALESCE(p_username, ''));
  v_profile coins.profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent replay: already bootstrapped → return current state.
  SELECT * INTO v_profile FROM coins.profiles WHERE id = v_uid;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'profile_id', v_profile.id,
      'username',   v_profile.username,
      'created',    false,
      'cash_balance', (SELECT cash_balance FROM coins.wallets WHERE user_id = v_uid));
  END IF;

  IF char_length(v_username) < 1 OR char_length(v_username) > 50 THEN
    RAISE EXCEPTION 'INVALID_USERNAME' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO coins.profiles (id, username) VALUES (v_uid, v_username);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'USERNAME_TAKEN' USING ERRCODE = 'P0001';
  END;
  INSERT INTO coins.wallets (user_id) VALUES (v_uid);  -- default £1,000.00

  RETURN jsonb_build_object(
    'profile_id', v_uid,
    'username',   v_username,
    'created',    true,
    'cash_balance', 1000.00);
END $$;

-- ---------------------------------------------------------------------------
-- buy_coin(p_asset_id, p_quantity, p_idempotency_key) — plan §8.1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.buy_coin(
  p_asset_id bigint,
  p_quantity numeric,
  p_idempotency_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_price numeric(24,8);
  v_total numeric(30,2);
  v_cash_after numeric(20,2);
  v_holding_after numeric(30,12);
  v_trade_id bigint;
  v_executed_at timestamptz;
  v_existing coins.trades%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  -- Quantity validation: finite, positive, bounded, ≤12 decimal places.
  IF p_quantity IS NULL
     OR p_quantity::text IN ('NaN','Infinity','-Infinity')
     OR p_quantity <= 0 OR p_quantity > 1e18
     OR scale(p_quantity) > 12 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'P0001';
  END IF;

  -- 1. Lock wallet first (serialises all trades for this user).
  PERFORM 1 FROM coins.wallets WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_BOOTSTRAPPED' USING ERRCODE = 'P0001';
  END IF;

  -- 2. Idempotency (wallet lock held → retry-safe).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM coins.trades
     WHERE user_id = v_uid AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing.side = 'BUY' AND v_existing.asset_id = p_asset_id
         AND v_existing.quantity = p_quantity THEN
        RETURN jsonb_build_object(
          'trade_id', v_existing.id, 'side', v_existing.side,
          'asset_id', v_existing.asset_id, 'quantity', v_existing.quantity,
          'unit_price', v_existing.unit_price, 'total_amount', v_existing.total_amount,
          'cash_balance_after', v_existing.cash_balance_after,
          'holding_quantity_after', v_existing.holding_quantity_after,
          'executed_at', v_existing.executed_at, 'idempotent_replay', true);
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 3. Lock asset, take server price (never trust the browser).
  SELECT current_price INTO v_price FROM coins.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 4. Market-halt rule.
  IF NOT (SELECT is_running FROM coins.market_state WHERE id) THEN
    RAISE EXCEPTION 'MARKET_HALTED' USING ERRCODE = 'P0001';
  END IF;

  -- 5. One documented GBP rounding rule.
  v_total := round(p_quantity * v_price, 2);
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'P0001';
  END IF;

  -- 6. Atomic conditional debit.
  UPDATE coins.wallets
     SET cash_balance = cash_balance - v_total, version = version + 1
   WHERE user_id = v_uid AND cash_balance >= v_total
  RETURNING cash_balance INTO v_cash_after;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS' USING ERRCODE = 'P0001';
  END IF;

  -- 7. Holding upsert (wallet lock serialises; safe).
  INSERT INTO coins.holdings (user_id, asset_id, quantity, cost_basis)
  VALUES (v_uid, p_asset_id, p_quantity, v_total)
  ON CONFLICT (user_id, asset_id) DO UPDATE
     SET quantity   = holdings.quantity + EXCLUDED.quantity,
         cost_basis = holdings.cost_basis + EXCLUDED.cost_basis
  RETURNING quantity INTO v_holding_after;

  -- 8. Immutable ledger entry with post-state.
  INSERT INTO coins.trades
    (user_id, asset_id, side, quantity, unit_price, total_amount,
     idempotency_key, cash_balance_after, holding_quantity_after)
  VALUES
    (v_uid, p_asset_id, 'BUY', p_quantity, v_price, v_total,
     p_idempotency_key, v_cash_after, v_holding_after)
  RETURNING id, executed_at INTO v_trade_id, v_executed_at;

  RETURN jsonb_build_object(
    'trade_id', v_trade_id, 'side', 'BUY',
    'asset_id', p_asset_id, 'quantity', p_quantity,
    'unit_price', v_price, 'total_amount', v_total,
    'cash_balance_after', v_cash_after,
    'holding_quantity_after', v_holding_after,
    'executed_at', v_executed_at, 'idempotent_replay', false);
END $$;

-- ---------------------------------------------------------------------------
-- sell_coin(p_asset_id, p_quantity, p_idempotency_key) — plan §8.2
-- Same lock order as buy: wallet → asset → holding. Average-cost basis
-- reduction; exact-zero residuals normalised to zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION coins.sell_coin(
  p_asset_id bigint,
  p_quantity numeric,
  p_idempotency_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = coins, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_price numeric(24,8);
  v_total numeric(30,2);
  v_cash_after numeric(20,2);
  v_holding_after numeric(30,12);
  v_trade_id bigint;
  v_executed_at timestamptz;
  v_existing coins.trades%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  IF p_quantity IS NULL
     OR p_quantity::text IN ('NaN','Infinity','-Infinity')
     OR p_quantity <= 0 OR p_quantity > 1e18
     OR scale(p_quantity) > 12 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'P0001';
  END IF;

  -- Wallet first (fixed lock order, same as buy_coin).
  PERFORM 1 FROM coins.wallets WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_BOOTSTRAPPED' USING ERRCODE = 'P0001';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM coins.trades
     WHERE user_id = v_uid AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing.side = 'SELL' AND v_existing.asset_id = p_asset_id
         AND v_existing.quantity = p_quantity THEN
        RETURN jsonb_build_object(
          'trade_id', v_existing.id, 'side', v_existing.side,
          'asset_id', v_existing.asset_id, 'quantity', v_existing.quantity,
          'unit_price', v_existing.unit_price, 'total_amount', v_existing.total_amount,
          'cash_balance_after', v_existing.cash_balance_after,
          'holding_quantity_after', v_existing.holding_quantity_after,
          'executed_at', v_existing.executed_at, 'idempotent_replay', true);
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Asset lock before holding lock (fixed order).
  SELECT current_price INTO v_price FROM coins.assets WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (SELECT is_running FROM coins.market_state WHERE id) THEN
    RAISE EXCEPTION 'MARKET_HALTED' USING ERRCODE = 'P0001';
  END IF;

  -- Ensure the holding row exists so the conditional update is well-defined
  -- (wallet lock is held, so this cannot race).
  INSERT INTO coins.holdings (user_id, asset_id, quantity, cost_basis)
  VALUES (v_uid, p_asset_id, 0, 0)
  ON CONFLICT (user_id, asset_id) DO NOTHING;

  v_total := round(p_quantity * v_price, 2);
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY' USING ERRCODE = 'P0001';
  END IF;

  -- Atomic conditional decrement + proportional average-cost reduction.
  UPDATE coins.holdings
     SET cost_basis = CASE
           WHEN quantity - p_quantity = 0 THEN 0
           ELSE round(cost_basis * (quantity - p_quantity) / quantity, 2)
         END,
         quantity = quantity - p_quantity
   WHERE user_id = v_uid AND asset_id = p_asset_id AND quantity >= p_quantity
  RETURNING quantity INTO v_holding_after;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_HOLDINGS' USING ERRCODE = 'P0001';
  END IF;

  -- Credit proceeds.
  UPDATE coins.wallets
     SET cash_balance = cash_balance + v_total, version = version + 1
   WHERE user_id = v_uid
  RETURNING cash_balance INTO v_cash_after;

  INSERT INTO coins.trades
    (user_id, asset_id, side, quantity, unit_price, total_amount,
     idempotency_key, cash_balance_after, holding_quantity_after)
  VALUES
    (v_uid, p_asset_id, 'SELL', p_quantity, v_price, v_total,
     p_idempotency_key, v_cash_after, v_holding_after)
  RETURNING id, executed_at INTO v_trade_id, v_executed_at;

  RETURN jsonb_build_object(
    'trade_id', v_trade_id, 'side', 'SELL',
    'asset_id', p_asset_id, 'quantity', p_quantity,
    'unit_price', v_price, 'total_amount', v_total,
    'cash_balance_after', v_cash_after,
    'holding_quantity_after', v_holding_after,
    'executed_at', v_executed_at, 'idempotent_replay', false);
END $$;

-- ---------------------------------------------------------------------------
-- Execute grants (plan §5.2): revoke from PUBLIC, grant to authenticated only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION coins.bootstrap_account(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.buy_coin(bigint, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION coins.sell_coin(bigint, numeric, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coins.bootstrap_account(text) TO authenticated;
GRANT EXECUTE ON FUNCTION coins.buy_coin(bigint, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION coins.sell_coin(bigint, numeric, uuid) TO authenticated;

COMMIT;
