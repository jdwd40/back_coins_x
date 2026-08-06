-- t01_rls_isolation.sql — deny-by-default + A/B isolation (plan §15.1)
-- Runs in the disposable test DB after harness + migrations + seed.

\set QUIET on
\echo '--- t01: bootstrap + RLS isolation'

-- Fixture: bootstrap two accounts as their own authenticated identities.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
SELECT coins.bootstrap_account('alice');
SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', false);
SELECT coins.bootstrap_account('bob');
RESET ROLE;

-- ok 1: bootstrap is idempotent for the same caller
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
DECLARE r jsonb;
BEGIN
  r := coins.bootstrap_account('alice');
  IF (r->>'created')::boolean THEN RAISE EXCEPTION 'FAIL: replay reported created'; END IF;
  IF (r->>'cash_balance')::numeric <> 1000.00 THEN RAISE EXCEPTION 'FAIL: balance changed'; END IF;
  RAISE NOTICE 'ok: bootstrap replay idempotent';
END $$;
RESET ROLE;

-- ok 2: unauthenticated bootstrap rejected
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', false);  -- no JWT claim
  PERFORM coins.bootstrap_account('mallory');
  RAISE EXCEPTION 'FAIL: anon bootstrap allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'FAIL: anon bootstrap allowed' THEN RAISE; END IF;
  IF SQLERRM <> 'NOT_AUTHENTICATED' THEN RAISE; END IF;
  RAISE NOTICE 'ok: unauthenticated bootstrap rejected';
END $$;

-- ok 3: username conflict surfaces USERNAME_TAKEN
SET ROLE authenticated;
DO $$
BEGIN
  -- user c (fixture from harness-less insert below) tries a taken name
  PERFORM set_config('request.jwt.claim.sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc', false);
  PERFORM coins.bootstrap_account('ALICE');
  RAISE EXCEPTION 'FAIL: duplicate username allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'FAIL: duplicate username allowed' THEN RAISE; END IF;
  IF SQLERRM <> 'USERNAME_TAKEN' THEN RAISE; END IF;
  RAISE NOTICE 'ok: case-insensitive username conflict rejected';
END $$;
RESET ROLE;

-- ok 4: A sees own wallet, cannot see B's
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM coins.wallets;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: A sees % wallets, expected 1', n; END IF;
  SELECT count(*) INTO n FROM coins.profiles;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: A sees % profiles, expected 1', n; END IF;
  RAISE NOTICE 'ok: A sees exactly own profile/wallet';
END $$;
RESET ROLE;

-- ok 5: anon cannot read any financial table (grant denied)
SET ROLE anon;
DO $$
BEGIN
  PERFORM * FROM coins.wallets;
  RAISE EXCEPTION 'FAIL: anon read wallets';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: anon denied wallets (grant)';
END $$;
RESET ROLE;

-- ok 6: authenticated cannot write wallets/holdings/trades directly
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
BEGIN
  UPDATE coins.wallets SET cash_balance = 999999 WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: wallet update allowed';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: wallet direct update denied';
END $$;
DO $$
BEGIN
  INSERT INTO coins.trades (user_id, asset_id, side, quantity, unit_price, total_amount)
  VALUES (auth.uid(), 1, 'BUY', 1, 1, 1);
  RAISE EXCEPTION 'FAIL: trade insert allowed';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: trade direct insert denied';
END $$;
RESET ROLE;

-- ok 7: A cannot update B's profile (RLS), can update own username
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
DECLARE n int;
BEGIN
  UPDATE coins.profiles SET username = 'hijacked'
   WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: cross-user profile update'; END IF;
  UPDATE coins.profiles SET username = 'alice2' WHERE id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: own username update blocked'; END IF;
  UPDATE coins.profiles SET username = 'alice' WHERE id = auth.uid();  -- restore
  RAISE NOTICE 'ok: profile update policy correct';
END $$;
RESET ROLE;

-- ok 8: public surfaces readable by anon
SET ROLE anon;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM coins.public_assets;
  IF n < 3 THEN RAISE EXCEPTION 'FAIL: anon cannot read public assets'; END IF;
  PERFORM * FROM coins.market_status_view LIMIT 1;
  RAISE NOTICE 'ok: anon reads public asset/market views';
END $$;
RESET ROLE;

-- ok 9: service-only functions reject authenticated
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
BEGIN
  PERFORM coins.set_market_running(true);
  RAISE EXCEPTION 'FAIL: authenticated ran set_market_running';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: set_market_running denied to authenticated';
END $$;
DO $$
BEGIN
  PERFORM coins.run_market_tick('evil-worker');
  RAISE EXCEPTION 'FAIL: authenticated ran run_market_tick';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: run_market_tick denied to authenticated';
END $$;
RESET ROLE;

\echo 't01 done'
