-- ===========================================================================
-- Migration 013: Crypto Chaos canonical coin catalogue rename.
--
-- Replaces the legacy player-facing coin names/symbols with the canonical
-- parody sci-fi/fantasy catalogue:
--
--   coin_id | legacy name  | legacy symbol | new name      | new symbol
--   --------+--------------+---------------+---------------+-----------
--         1 | BitBerto     | BTB           | FutureCoin    | FTR
--         2 | GedCoin      | GED           | NovaCash      | NVC
--         3 | Mr B Block   | MBB           | Byteon        | BYT
--         4 | BartoSatashi | BTS           | DigitalVault  | DGV
--         5 | PeteChain    | PTC           | Cybercore     | CYB
--         6 | DeanNode     | DNO           | BlockNation   | BLN
--         7 | DeanSpark    | DSP           | StellaFortune | STF
--         8 | SlateBit     | SLB           | JD Coin       | JDC
--         9 | JarLedger    | JRL           | MeteorCoin    | MTC
--        10 | WolliWarden  | WLW           | CryptoZen     | CZN
--
-- Mapping authority: the stable coin_id ordering 1..10 (the original
-- catalogue order) mapped onto the canonical catalogue in its documented
-- order. Rename is IN PLACE: coin_id, prices, baselines, price history,
-- collapse schedules, holdings, transactions and results are untouched —
-- every relationship keys off coin_id, which does not change.
--
-- Safety contract (same shape rules as migrations 008-012):
--   * public.coins must exist with varchar name/symbol columns and the
--     UNIQUE constraint on symbol (verified, never recreated blindly).
--   * Each canonical id must currently hold EITHER its exact legacy
--     identity (rename it) OR its exact new identity (already applied —
--     verified no-op, so a lost tracking row is safe). ANY other identity
--     aborts loudly: the migration never renames an ambiguous record.
--   * No row outside ids 1..10 may already hold one of the new symbols —
--     that would collide with the UNIQUE constraint mid-rename, so it is
--     rejected up front.
--   * Rows outside the canonical ids 1..10 are never touched.
-- The whole batch runs inside a single transaction via db/migrate.js, so a
-- failure leaves the database unchanged.
-- ===========================================================================

DO $$
DECLARE
  m RECORD;
  cur RECORD;
BEGIN
  -- -- Table and column shape ---------------------------------------------
  IF to_regclass('public.coins') IS NULL THEN
    RAISE EXCEPTION 'migration 013: public.coins does not exist — the Coins schema is missing entirely';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coins'
      AND column_name = 'name' AND data_type = 'character varying'
  ) THEN
    RAISE EXCEPTION 'migration 013: coins.name is missing or not varchar — the table shape is INCOMPATIBLE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coins'
      AND column_name = 'symbol' AND data_type = 'character varying'
  ) THEN
    RAISE EXCEPTION 'migration 013: coins.symbol is missing or not varchar — the table shape is INCOMPATIBLE';
  END IF;

  -- The symbol uniqueness guarantee must already exist; the rename relies on
  -- it and must preserve it (never weakened, never recreated here).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
     AND tc.table_name = kcu.table_name
    WHERE tc.table_schema = 'public' AND tc.table_name = 'coins'
      AND tc.constraint_type = 'UNIQUE' AND kcu.column_name = 'symbol'
  ) THEN
    RAISE EXCEPTION 'migration 013: coins.symbol UNIQUE constraint is missing — the table shape is INCOMPATIBLE (uniqueness must pre-exist and be preserved)';
  END IF;

  -- -- Up-front collision check --------------------------------------------
  -- A non-canonical row already holding a new symbol would collide with the
  -- UNIQUE constraint part-way through the rename.
  IF EXISTS (
    SELECT 1 FROM coins c
    JOIN (
      VALUES ('FTR'), ('NVC'), ('BYT'), ('DGV'), ('CYB'),
             ('BLN'), ('STF'), ('JDC'), ('MTC'), ('CZN')
    ) AS new_symbols(sym) ON c.symbol = new_symbols.sym
    WHERE c.coin_id < 1 OR c.coin_id > 10
  ) THEN
    RAISE EXCEPTION 'migration 013: a coin row outside the canonical ids 1..10 already holds one of the new symbols — refusing to rename into a uniqueness collision';
  END IF;

  -- -- Deterministic in-place rename ---------------------------------------
  FOR m IN
    SELECT * FROM (VALUES
      ( 1, 'BitBerto',     'BTB', 'FutureCoin',    'FTR'),
      ( 2, 'GedCoin',      'GED', 'NovaCash',      'NVC'),
      ( 3, 'Mr B Block',   'MBB', 'Byteon',        'BYT'),
      ( 4, 'BartoSatashi', 'BTS', 'DigitalVault',  'DGV'),
      ( 5, 'PeteChain',    'PTC', 'Cybercore',     'CYB'),
      ( 6, 'DeanNode',     'DNO', 'BlockNation',   'BLN'),
      ( 7, 'DeanSpark',    'DSP', 'StellaFortune', 'STF'),
      ( 8, 'SlateBit',     'SLB', 'JD Coin',       'JDC'),
      ( 9, 'JarLedger',    'JRL', 'MeteorCoin',    'MTC'),
      (10, 'WolliWarden',  'WLW', 'CryptoZen',     'CZN')
    ) AS v(coin_id, old_name, old_symbol, new_name, new_symbol)
  LOOP
    SELECT name, symbol INTO cur FROM coins WHERE coin_id = m.coin_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'migration 013: canonical coin_id % is missing — expected %/% (legacy) or %/% (renamed); refusing to guess an identity',
        m.coin_id, m.old_name, m.old_symbol, m.new_name, m.new_symbol;
    END IF;

    IF cur.name = m.new_name AND cur.symbol = m.new_symbol THEN
      -- Already renamed: applied state, verified no-op.
      CONTINUE;
    ELSIF cur.name = m.old_name AND cur.symbol = m.old_symbol THEN
      UPDATE coins SET name = m.new_name, symbol = m.new_symbol
       WHERE coin_id = m.coin_id;
    ELSE
      RAISE EXCEPTION 'migration 013: coin_id % has an AMBIGUOUS identity (name=%, symbol=%) — expected legacy %/% or renamed %/%. Fix the row manually; the migration will not rename an unrecognised record.',
        m.coin_id, cur.name, cur.symbol, m.old_name, m.old_symbol, m.new_name, m.new_symbol;
    END IF;
  END LOOP;
END $$;
