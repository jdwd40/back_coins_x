// Migration runner + schema verification coverage for migration 012
// (fractional Crypto Chaos round quantities, DECIMAL(18,2) -> DECIMAL(18,8)).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing schema and
// data (via jest.setup.js beforeEach) that migration 012 must preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_012 = '012_fractional_round_quantities.sql';

// Simulate the pre-012 production state: the Core 4 round-state tables exist
// with quantity at numeric(18,2). Only ever run this against columns whose
// values fit 2 decimals (every production value predating 012 does).
async function revertQuantityColumnsTo2dp() {
  await db.query('ALTER TABLE apocalypse_holdings ALTER COLUMN quantity TYPE DECIMAL(18,2)');
  await db.query('ALTER TABLE apocalypse_transactions ALTER COLUMN quantity TYPE DECIMAL(18,2)');
}

async function drop012Tracking() {
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_012]);
}

async function quantityColumnType(table) {
  const { rows } = await db.query(
    `SELECT numeric_precision::int AS precision, numeric_scale::int AS scale
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'quantity'`,
    [table]
  );
  return rows[0];
}

describe('migration 012: fractional round quantities', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 012 to an existing Core 4 database, preserving all legacy and game data exactly', async () => {
    // Give the "existing" database observable legacy + round data that must
    // survive the widening bit-for-bit (2-decimal values are exact at 8).
    await db.query(`INSERT INTO portfolios (user_id, coin_id, quantity) VALUES (1, 1, 12.50)`);
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'fractional-migration-seed', now() - interval '1 hour', now() - interval '30 minutes', 1800000, 'COMPLETED')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status, final_cash)
       VALUES (1, 1, 1000.00, 750.00, 1250.00, 'FINALIZED', 750.00)`
    );
    await db.query(
      `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity)
       VALUES (1, 1, 1, 1, 12.50)`
    );
    await db.query(
      `INSERT INTO apocalypse_transactions (participant_id, cycle_id, user_id, coin_id, type, quantity, price, total_amount)
       VALUES (1, 1, 1, 1, 'BUY', 2.25, 100.00, 225.00)`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await revertQuantityColumnsTo2dp();
    await drop012Tracking();

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toEqual([MIGRATION_012]); // only 012 was missing

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Both quantity columns are now DECIMAL(18,8).
    expect(await quantityColumnType('apocalypse_holdings')).toEqual({ precision: 18, scale: 8 });
    expect(await quantityColumnType('apocalypse_transactions')).toEqual({ precision: 18, scale: 8 });

    // Stored quantities survived the widening exactly.
    const { rows: holding } = await db.query('SELECT quantity FROM apocalypse_holdings WHERE participant_id = 1');
    expect(parseFloat(holding[0].quantity)).toBe(12.5);
    const { rows: tx } = await db.query('SELECT quantity, total_amount FROM apocalypse_transactions WHERE participant_id = 1');
    expect(parseFloat(tx[0].quantity)).toBe(2.25);
    expect(parseFloat(tx[0].total_amount)).toBe(225);

    // Legacy data fully preserved.
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    const { rows: portfolio } = await db.query('SELECT quantity FROM portfolios WHERE user_id = 1 AND coin_id = 1');
    expect(parseFloat(portfolio[0].quantity)).toBe(12.5);

    // The widened columns accept 8-decimal quantities and still reject
    // negative/zero ledger values via the preserved CHECK constraints.
    await db.query(
      `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity)
       VALUES (1, 1, 1, 2, 0.00000001)`
    );
    await expect(
      db.query(
        `INSERT INTO apocalypse_transactions (participant_id, cycle_id, user_id, coin_id, type, quantity, price, total_amount)
         VALUES (1, 1, 1, 1, 'BUY', 0, 100.00, 0.00)`
      )
    ).rejects.toThrow();
  });

  test('re-running the runner is a no-op once 012 is recorded', async () => {
    const again = await runMigrations({ log: () => {} });
    expect(again.applied).toEqual([]);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('SQL-level rerun on columns already at DECIMAL(18,8) is a verified no-op', async () => {
    // Lose only the tracking row: the runner must re-execute 012 against the
    // already-widened columns, detect the applied state, and record it again
    // without altering anything.
    await drop012Tracking();
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([MIGRATION_012]);
    expect(await quantityColumnType('apocalypse_holdings')).toEqual({ precision: 18, scale: 8 });
    expect(await quantityColumnType('apocalypse_transactions')).toEqual({ precision: 18, scale: 8 });
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('a pre-existing INCOMPATIBLE quantity column type fails the migration loudly', async () => {
    await revertQuantityColumnsTo2dp();
    await drop012Tracking();
    // Same column, wrong shape: numeric(18,4) is neither the Core 4
    // predecessor (18,2) nor the applied state (18,8).
    await db.query('ALTER TABLE apocalypse_holdings ALTER COLUMN quantity TYPE DECIMAL(18,4)');

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);
    const { rows: tracking } = await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_012]
    );
    expect(tracking[0].n).toBe(0);
  });

  test('verification fails clearly when quantity columns are still the Core 4 2-decimal shape', async () => {
    await revertQuantityColumnsTo2dp();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toMatch(/apocalypse_holdings: quantity must be DECIMAL\(18,8\)/);
    expect(verification.problems.join(' ')).toMatch(/apocalypse_transactions: quantity must be DECIMAL\(18,8\)/);
  });

  test('seeded test schema (production DDL via db/seed.js) verifies cleanly', async () => {
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });
});
