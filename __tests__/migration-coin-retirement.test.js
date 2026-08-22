// Migration runner + schema verification coverage for migration 014
// (retire legacy seed-only coins 11-13 without deleting history).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration
// mechanism here; it only provides the pre-existing schema and data (via
// jest.setup.js beforeEach) that migration 014 must preserve.
//
// The seeded database ALREADY has coins.retired (seed applies migration 014
// as DDL) and never contains legacy rows 11-13, so the pre-014 production
// state is simulated by inserting the three legacy coins with their exact
// production identities (plus history), dropping the retired column, and
// losing the tracking row.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_014 = '014_retire_legacy_coins.sql';

// coin_id -> [legacy name, legacy symbol] — the exact production identities.
const LEGACY = [
  [11, 'HashAd', 'HAD'],
  [12, 'ChrisByte', 'CBT'],
  [13, 'HodlWayne', 'HDW']
];

// Simulate the pre-014 production state: legacy rows 11-13 with real
// historical references, and no retired column at all.
async function simulatePre014Production() {
  for (const [id, name, symbol] of LEGACY) {
    await db.query(
      `INSERT INTO coins (coin_id, name, symbol, current_price, market_cap, circulating_supply, founder, cycle_baseline_price, retired)
       VALUES ($1, $2, $3, 25.00, 250000.00, 10000, 'Legacy Founder', 25.00, FALSE)`,
      [id, name, symbol]
    );
    await db.query(
      'INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, 24.75, now() - interval \'5 minutes\')',
      [id]
    );
    await db.query(
      'INSERT INTO coin_statistics (coin_id, all_time_high, all_time_high_date, all_time_low, all_time_low_date) VALUES ($1, 60.00, now(), 5.00, now())',
      [id]
    );
  }
  await db.query(
    `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
     VALUES ('APOC-0001', 'retirement-migration-seed', now() - interval '1 hour', now() - interval '30 minutes', 1800000, 'COMPLETED')`
  );
  await db.query(
    `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status, final_cash)
     VALUES (1, 1, 1000.00, 750.00, 1250.00, 'FINALIZED', 750.00)`
  );
  await db.query(
    `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity)
     VALUES (1, 1, 1, 12, 0.02)`
  );
  await db.query(
    `INSERT INTO apocalypse_transactions (participant_id, cycle_id, user_id, coin_id, type, quantity, price, total_amount)
     VALUES (1, 1, 1, 12, 'BUY', 0.02, 25.00, 0.50)`
  );
  await db.query(
    `INSERT INTO coin_collapse_schedule (cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price)
     VALUES (1, 11, 1, now() - interval '40 minutes', 25.00)`
  );

  await db.query('ALTER TABLE coins DROP COLUMN retired');
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_014]);
}

async function coinRow(id) {
  const { rows } = await db.query('SELECT coin_id, name, symbol, retired FROM coins WHERE coin_id = $1', [id]);
  return rows[0] || null;
}

describe('migration 014: retire legacy seed-only coins', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('retires legacy coins 11-13 in place while preserving every historical row', async () => {
    await simulatePre014Production();
    const historyBefore = await db.query(
      'SELECT coin_id, count(*)::int AS n FROM price_history WHERE coin_id IN (11,12,13) GROUP BY coin_id ORDER BY coin_id'
    );

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toEqual([MIGRATION_014]); // only 014 was missing

    // Rows retired, identities and ids untouched.
    for (const [id, name, symbol] of LEGACY) {
      expect(await coinRow(id)).toMatchObject({ coin_id: id, name, symbol, retired: true });
    }
    // Canonical coins stay active.
    for (let id = 1; id <= 10; id++) {
      expect((await coinRow(id)).retired).toBe(false);
    }

    // History preserved bit-for-bit: price history, statistics, collapse
    // schedule, round holdings and transactions all still reference the
    // retired coins.
    const historyAfter = await db.query(
      'SELECT coin_id, count(*)::int AS n FROM price_history WHERE coin_id IN (11,12,13) GROUP BY coin_id ORDER BY coin_id'
    );
    expect(historyAfter.rows).toEqual(historyBefore.rows);
    const { rows: stats } = await db.query('SELECT count(*)::int AS n FROM coin_statistics WHERE coin_id IN (11,12,13)');
    expect(stats[0].n).toBe(3);
    const { rows: schedule } = await db.query('SELECT cycle_id, coin_id, collapse_rank FROM coin_collapse_schedule WHERE cycle_id = 1');
    expect(schedule).toEqual([{ cycle_id: 1, coin_id: 11, collapse_rank: 1 }]);
    const { rows: holding } = await db.query('SELECT coin_id, quantity FROM apocalypse_holdings WHERE participant_id = 1');
    expect(holding[0].coin_id).toBe(12);
    expect(parseFloat(holding[0].quantity)).toBe(0.02);
    const { rows: tx } = await db.query('SELECT coin_id, type, total_amount FROM apocalypse_transactions WHERE participant_id = 1');
    expect(tx[0]).toMatchObject({ coin_id: 12, type: 'BUY' });
    expect(parseFloat(tx[0].total_amount)).toBe(0.5);

    // Post-014 the verifier passes: exactly the canonical 10 active, the
    // retired legacy trio tolerated as preserved history.
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });

  test('re-running the runner is a no-op once 014 is recorded', async () => {
    const again = await runMigrations({ log: () => {} });
    expect(again.applied).toEqual([]);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('SQL-level rerun on already-retired rows is a verified no-op', async () => {
    await simulatePre014Production();
    await runMigrations({ log: () => {} }); // applies 014, retires the trio

    // Lose only the tracking row: the runner must re-execute 014 against
    // the already-retired rows, detect the applied state, and record it
    // again without altering anything.
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_014]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([MIGRATION_014]);
    for (const [id, name, symbol] of LEGACY) {
      expect(await coinRow(id)).toMatchObject({ coin_id: id, name, symbol, retired: true });
    }
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('an unexpected identity at a legacy id fails loudly and rolls back', async () => {
    await simulatePre014Production();
    await db.query(`UPDATE coins SET name = 'Impossible Coin', symbol = 'IMP' WHERE coin_id = 11`);

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/UNEXPECTED identity/);

    // Rolled back: no tracking row, the retired column is gone again, and
    // no row was retired.
    const { rows: tracking } = await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_014]
    );
    expect(tracking[0].n).toBe(0);
    const { rows: col } = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'coins' AND column_name = 'retired'`
    );
    expect(col[0].n).toBe(0);
    const { rows: row12 } = await db.query('SELECT name, symbol FROM coins WHERE coin_id = 12');
    expect(row12[0]).toMatchObject({ name: 'ChrisByte', symbol: 'CBT' });
  });

  test('verification fails clearly when migration 014 has not been applied', async () => {
    await simulatePre014Production();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toMatch(/coins\.retired column missing/);
  });

  test('seeded test schema (canonical 10, retired column, no legacy rows) verifies cleanly', async () => {
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });
});
