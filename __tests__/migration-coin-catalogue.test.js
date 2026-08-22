// Migration runner + schema verification coverage for migration 013
// (canonical coin catalogue rename).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration
// mechanism here; it only provides the pre-existing schema and data (via
// jest.setup.js beforeEach) that migration 013 must preserve.
//
// The seeded database is ALREADY renamed (seed inserts the canonical
// catalogue directly), so the pre-013 production state is simulated by
// reverting the 10 canonical rows to their legacy identities first.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_013 = '013_rename_coin_catalogue.sql';

// coin_id -> [legacy name, legacy symbol, canonical name, canonical symbol]
const MAPPING = [
  [1, 'BitBerto', 'BTB', 'FutureCoin', 'FTR'],
  [2, 'GedCoin', 'GED', 'NovaCash', 'NVC'],
  [3, 'Mr B Block', 'MBB', 'Byteon', 'BYT'],
  [4, 'BartoSatashi', 'BTS', 'DigitalVault', 'DGV'],
  [5, 'PeteChain', 'PTC', 'Cybercore', 'CYB'],
  [6, 'DeanNode', 'DNO', 'BlockNation', 'BLN'],
  [7, 'DeanSpark', 'DSP', 'StellaFortune', 'STF'],
  [8, 'SlateBit', 'SLB', 'JD Coin', 'JDC'],
  [9, 'JarLedger', 'JRL', 'MeteorCoin', 'MTC'],
  [10, 'WolliWarden', 'WLW', 'CryptoZen', 'CZN']
];

// Simulate the pre-013 production state: the same 10 stable coin_ids carrying
// their legacy names/symbols. Only the player-facing identity columns move —
// ids, prices and baselines stay exactly as seeded, mirroring production.
async function revertToLegacyCatalogue() {
  await db.query(
    `UPDATE coins c SET name = v.old_name, symbol = v.old_symbol
     FROM (VALUES
       (1, 'BitBerto', 'BTB'), (2, 'GedCoin', 'GED'), (3, 'Mr B Block', 'MBB'),
       (4, 'BartoSatashi', 'BTS'), (5, 'PeteChain', 'PTC'), (6, 'DeanNode', 'DNO'),
       (7, 'DeanSpark', 'DSP'), (8, 'SlateBit', 'SLB'), (9, 'JarLedger', 'JRL'),
       (10, 'WolliWarden', 'WLW')
     ) AS v(id, old_name, old_symbol)
     WHERE c.coin_id = v.id`
  );
}

async function drop013Tracking() {
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_013]);
}

async function catalogueRows() {
  const { rows } = await db.query('SELECT coin_id, name, symbol FROM coins ORDER BY coin_id');
  return rows;
}

describe('migration 013: canonical coin catalogue rename', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('renames the legacy catalogue in place, preserving ids, prices, baselines, history, schedules, holdings and transactions', async () => {
    // Observable legacy + game data that must survive the rename untouched.
    await db.query(`INSERT INTO portfolios (user_id, coin_id, quantity) VALUES (1, 8, 12.50)`);
    await db.query(`INSERT INTO price_history (coin_id, price, created_at) VALUES (8, 123.45, now() - interval '5 minutes')`);
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'catalogue-migration-seed', now() - interval '1 hour', now() - interval '30 minutes', 1800000, 'COMPLETED')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status, final_cash)
       VALUES (1, 1, 1000.00, 750.00, 1250.00, 'FINALIZED', 750.00)`
    );
    await db.query(
      `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity)
       VALUES (1, 1, 1, 8, 0.004)`
    );
    await db.query(
      `INSERT INTO apocalypse_transactions (participant_id, cycle_id, user_id, coin_id, type, quantity, price, total_amount)
       VALUES (1, 1, 1, 8, 'BUY', 0.004, 2500.00, 10.00)`
    );
    await db.query(
      `INSERT INTO coin_collapse_schedule (cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price)
       VALUES (1, 8, 1, now() + interval '10 minutes', 33.48)`
    );

    await revertToLegacyCatalogue();
    const pricesBefore = await db.query('SELECT coin_id, current_price, cycle_baseline_price FROM coins ORDER BY coin_id');
    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = 8');
    await drop013Tracking();

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toEqual([MIGRATION_013]); // only 013 was missing

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // 6. Stable coin_ids preserved: same ids, now carrying the canonical
    //    names/symbols — including JD Coin / JDC at id 8.
    const rows = await catalogueRows();
    expect(rows.map((r) => r.coin_id)).toEqual(MAPPING.map((m) => m[0]));
    for (const [id, , , name, symbol] of MAPPING) {
      expect(rows[id - 1]).toMatchObject({ coin_id: id, name, symbol });
    }

    // 7. Current prices and restoration baselines survive exactly.
    const pricesAfter = await db.query('SELECT coin_id, current_price, cycle_baseline_price FROM coins ORDER BY coin_id');
    expect(pricesAfter.rows).toEqual(pricesBefore.rows);

    // 8. Price history survives, still keyed to the same coin_id.
    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = 8');
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n);
    expect(historyAfter.rows[0].n).toBeGreaterThan(0);

    // 9. Collapse schedules still reference the same coin_id.
    const { rows: schedule } = await db.query(
      'SELECT cycle_id, coin_id, collapse_rank FROM coin_collapse_schedule WHERE cycle_id = 1'
    );
    expect(schedule).toEqual([{ cycle_id: 1, coin_id: 8, collapse_rank: 1 }]);

    // 10+11. Round holdings and transactions remain intact at the same ids.
    const { rows: holding } = await db.query('SELECT coin_id, quantity FROM apocalypse_holdings WHERE participant_id = 1');
    expect(parseFloat(holding[0].quantity)).toBe(0.004);
    expect(holding[0].coin_id).toBe(8);
    const { rows: tx } = await db.query('SELECT coin_id, type, quantity, total_amount FROM apocalypse_transactions WHERE participant_id = 1');
    expect(tx[0].coin_id).toBe(8);
    expect(tx[0].type).toBe('BUY');
    expect(parseFloat(tx[0].quantity)).toBe(0.004);
    expect(parseFloat(tx[0].total_amount)).toBe(10);

    // Legacy portfolio (pre-game table) intact at the same coin_id.
    const { rows: portfolio } = await db.query('SELECT coin_id, quantity FROM portfolios WHERE user_id = 1 AND coin_id = 8');
    expect(parseFloat(portfolio[0].quantity)).toBe(12.5);
  });

  test('re-running the runner is a no-op once 013 is recorded', async () => {
    const again = await runMigrations({ log: () => {} });
    expect(again.applied).toEqual([]);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('SQL-level rerun on an already-renamed catalogue is a verified no-op', async () => {
    // Lose only the tracking row: the runner must re-execute 013 against the
    // already-canonical rows, detect the applied state, and record it again
    // without altering anything.
    await drop013Tracking();
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([MIGRATION_013]);
    expect(await catalogueRows()).toEqual(MAPPING.map(([id, , , name, symbol]) => ({ coin_id: id, name, symbol })));
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('an ambiguous coin identity fails the migration loudly without recording it', async () => {
    await revertToLegacyCatalogue();
    // Coin 3 no longer matches its expected legacy identity.
    await db.query(`UPDATE coins SET name = 'Impossible Coin', symbol = 'IMP' WHERE coin_id = 3`);
    await drop013Tracking();

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/AMBIGUOUS/);
    const { rows: tracking } = await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_013]
    );
    expect(tracking[0].n).toBe(0);

    // The failed migration rolled back: no other row was renamed.
    const rows = await catalogueRows();
    expect(rows[0]).toMatchObject({ name: 'BitBerto', symbol: 'BTB' });
    expect(rows[2]).toMatchObject({ name: 'Impossible Coin', symbol: 'IMP' });
  });

  test('verification fails clearly when the catalogue still holds legacy names', async () => {
    await revertToLegacyCatalogue();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toMatch(/canonical coin_id 1: found BitBerto\/BTB, expected FutureCoin\/FTR/);
    expect(verification.problems.join(' ')).toMatch(/canonical coin_id 8: found SlateBit\/SLB, expected JD Coin\/JDC/);
  });

  test('seeded test schema (fresh canonical catalogue via db/seed.js) verifies cleanly', async () => {
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });
});
