-- t02_trading.sql — buy/sell atomicity, idempotency, rounding, ledger guards
-- (plan §15.2). Assumes t01 fixtures (alice, bob bootstrapped).

\echo '--- t02: trading RPCs'

SELECT coins.set_market_running(true);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);

-- ok 1: valid buy with server price and documented rounding
DO $$
DECLARE
  r jsonb; v_asset bigint;
BEGIN
  SELECT id INTO v_asset FROM coins.assets WHERE symbol = 'TCA';  -- price 10.00
  r := coins.buy_coin(v_asset, 10, '11111111-1111-1111-1111-111111111111');
  IF (r->>'unit_price')::numeric <> 10.00000000 THEN RAISE EXCEPTION 'FAIL: server price'; END IF;
  IF (r->>'total_amount')::numeric <> 100.00 THEN RAISE EXCEPTION 'FAIL: rounding'; END IF;
  IF (r->>'cash_balance_after')::numeric <> 900.00 THEN RAISE EXCEPTION 'FAIL: cash after: %', r; END IF;
  IF (r->>'holding_quantity_after')::numeric <> 10 THEN RAISE EXCEPTION 'FAIL: holding after'; END IF;
  RAISE NOTICE 'ok: valid buy exact rounding and post-state';
END $$;

-- ok 2: returned post-state equals subsequent RLS reads
DO $$
DECLARE v_cash numeric; v_qty numeric;
BEGIN
  SELECT cash_balance INTO v_cash FROM coins.wallets WHERE user_id = auth.uid();
  SELECT quantity INTO v_qty FROM coins.holdings
   WHERE user_id = auth.uid() AND asset_id = (SELECT id FROM coins.assets WHERE symbol='TCA');
  IF v_cash <> 900.00 OR v_qty <> 10 THEN RAISE EXCEPTION 'FAIL: post-state mismatch'; END IF;
  RAISE NOTICE 'ok: returned post-state equals RLS reads';
END $$;

-- ok 3: idempotent replay returns original trade, no second state change
DO $$
DECLARE r jsonb; n int;
BEGIN
  r := coins.buy_coin((SELECT id FROM coins.assets WHERE symbol='TCA'), 10,
                      '11111111-1111-1111-1111-111111111111');
  IF NOT (r->>'idempotent_replay')::boolean THEN RAISE EXCEPTION 'FAIL: replay flag'; END IF;
  IF (r->>'cash_balance_after')::numeric <> 900.00 THEN RAISE EXCEPTION 'FAIL: replay state'; END IF;
  SELECT count(*) INTO n FROM coins.trades WHERE user_id = auth.uid();
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: duplicate trade on replay (%)', n; END IF;
  RAISE NOTICE 'ok: idempotent replay safe';
END $$;

-- ok 4: same key + different semantics → IDEMPOTENCY_CONFLICT
DO $$
BEGIN
  PERFORM coins.buy_coin((SELECT id FROM coins.assets WHERE symbol='TCA'), 11,
                         '11111111-1111-1111-1111-111111111111');
  RAISE EXCEPTION 'FAIL: conflict accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'FAIL: conflict accepted' THEN RAISE; END IF;
  IF SQLERRM <> 'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF;
  RAISE NOTICE 'ok: idempotency conflict rejected';
END $$;

-- ok 5: invalid quantities
DO $$
DECLARE
  v_asset bigint := (SELECT id FROM coins.assets WHERE symbol='TCA');
  bad numeric[] := ARRAY[0, -1, 1e19]::numeric[];
  q numeric;
BEGIN
  FOREACH q IN ARRAY bad LOOP
    BEGIN
      PERFORM coins.buy_coin(v_asset, q, gen_random_uuid());
      RAISE EXCEPTION 'FAIL: quantity % accepted', q;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
      IF SQLERRM <> 'INVALID_QUANTITY' THEN RAISE; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM coins.buy_coin(v_asset, 'NaN'::numeric, gen_random_uuid());
    RAISE EXCEPTION 'FAIL: NaN accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    IF SQLERRM <> 'INVALID_QUANTITY' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM coins.buy_coin(v_asset, 1.0000000000001, gen_random_uuid()); -- scale 13
    RAISE EXCEPTION 'FAIL: excess scale accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    IF SQLERRM <> 'INVALID_QUANTITY' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: invalid quantities rejected (0/negative/oversize/NaN/excess scale)';
END $$;

-- ok 6: insufficient funds — no side effects
DO $$
DECLARE n int; v_cash numeric;
BEGIN
  BEGIN
    PERFORM coins.buy_coin((SELECT id FROM coins.assets WHERE symbol='TCA'), 1000, gen_random_uuid());
    RAISE EXCEPTION 'FAIL: overspend accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    IF SQLERRM <> 'INSUFFICIENT_FUNDS' THEN RAISE; END IF;
  END;
  SELECT cash_balance INTO v_cash FROM coins.wallets WHERE user_id = auth.uid();
  SELECT count(*) INTO n FROM coins.trades WHERE user_id = auth.uid();
  IF v_cash <> 900.00 OR n <> 1 THEN
    RAISE EXCEPTION 'FAIL: side effects after insufficient funds (cash %, trades %)', v_cash, n;
  END IF;
  RAISE NOTICE 'ok: insufficient funds atomic, no side effects';
END $$;

-- ok 7: missing asset
DO $$
BEGIN
  PERFORM coins.buy_coin(999999, 1, gen_random_uuid());
  RAISE EXCEPTION 'FAIL: missing asset accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  IF SQLERRM <> 'ASSET_NOT_FOUND' THEN RAISE; END IF;
  RAISE NOTICE 'ok: missing asset rejected';
END $$;
RESET ROLE;

-- ok 8: halted market blocks trades
SELECT coins.set_market_running(false, 'test-halt');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
BEGIN
  PERFORM coins.buy_coin((SELECT id FROM coins.assets WHERE symbol='TCA'), 1, gen_random_uuid());
  RAISE EXCEPTION 'FAIL: trade while halted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  IF SQLERRM <> 'MARKET_HALTED' THEN RAISE; END IF;
  RAISE NOTICE 'ok: halted market blocks trades';
END $$;
RESET ROLE;
SELECT coins.set_market_running(true);

-- ok 9: valid sell with average-cost reduction
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
DECLARE r jsonb; v_cb numeric;
BEGIN
  r := coins.sell_coin((SELECT id FROM coins.assets WHERE symbol='TCA'), 4,
                       '22222222-2222-2222-2222-222222222222');
  IF (r->>'total_amount')::numeric <> 40.00 THEN RAISE EXCEPTION 'FAIL: sell total'; END IF;
  IF (r->>'cash_balance_after')::numeric <> 940.00 THEN RAISE EXCEPTION 'FAIL: sell cash: %', r; END IF;
  IF (r->>'holding_quantity_after')::numeric <> 6 THEN RAISE EXCEPTION 'FAIL: sell holding'; END IF;
  SELECT cost_basis INTO v_cb FROM coins.holdings
   WHERE user_id = auth.uid() AND asset_id = (SELECT id FROM coins.assets WHERE symbol='TCA');
  IF v_cb <> 60.00 THEN RAISE EXCEPTION 'FAIL: cost basis % expected 60.00', v_cb; END IF;
  RAISE NOTICE 'ok: valid sell, proportional cost basis';
END $$;

-- ok 10: oversell rejected atomically
DO $$
DECLARE n int;
BEGIN
  BEGIN
    PERFORM coins.sell_coin((SELECT id FROM coins.assets WHERE symbol='TCA'), 100, gen_random_uuid());
    RAISE EXCEPTION 'FAIL: oversell accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    IF SQLERRM <> 'INSUFFICIENT_HOLDINGS' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO n FROM coins.trades WHERE user_id = auth.uid();
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: side effects after oversell'; END IF;
  RAISE NOTICE 'ok: insufficient holdings rejected, no side effects';
END $$;

-- ok 11: sell-to-zero normalises cost basis to exactly 0
DO $$
DECLARE v_cb numeric; v_qty numeric;
BEGIN
  PERFORM coins.sell_coin((SELECT id FROM coins.assets WHERE symbol='TCA'), 6, gen_random_uuid());
  SELECT quantity, cost_basis INTO v_qty, v_cb FROM coins.holdings
   WHERE user_id = auth.uid() AND asset_id = (SELECT id FROM coins.assets WHERE symbol='TCA');
  IF v_qty <> 0 OR v_cb <> 0 THEN RAISE EXCEPTION 'FAIL: residual qty % cb %', v_qty, v_cb; END IF;
  RAISE NOTICE 'ok: zero residual normalised';
END $$;
RESET ROLE;

-- ok 12: trades ledger is append-only even for the owner
DO $$
BEGIN
  UPDATE coins.trades SET quantity = 0 WHERE true;
  RAISE EXCEPTION 'FAIL: trade update allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL: trade update allowed' THEN RAISE; END IF;
  IF SQLERRM <> 'trades is an append-only ledger' THEN RAISE; END IF;
  RAISE NOTICE 'ok: trade update rejected';
END $$;
DO $$
BEGIN
  DELETE FROM coins.trades WHERE true;
  RAISE EXCEPTION 'FAIL: trade delete allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL: trade delete allowed' THEN RAISE; END IF;
  IF SQLERRM <> 'trades is an append-only ledger' THEN RAISE; END IF;
  RAISE NOTICE 'ok: trade delete rejected';
END $$;

-- ok 13: my_portfolio / my_trades views are caller-scoped
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM coins.my_trades;          -- alice: 3 trades
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL: alice my_trades %', n; END IF;
  PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', false);
  SELECT count(*) INTO n FROM coins.my_trades;          -- bob: none
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: bob sees trades'; END IF;
  SELECT count(*) INTO n FROM coins.my_portfolio;       -- bob: no rows
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: bob sees portfolio'; END IF;
  RAISE NOTICE 'ok: portfolio/trade views caller-scoped';
END $$;
RESET ROLE;

\echo 't02 done'
