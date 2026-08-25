// Migration runner + schema verification coverage for Crypto Chaos V2-1
// price precision (migration 017: 2dp -> 4dp widen on price/value columns).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js only provides the pre-existing
// Coins schema and data (via jest.setup.js beforeEach) that migration 017
// must preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_017 = '017_v2_price_precision.sql';

const WIDENED = [
  ['coins', 'current_price'],
  ['coins', 'cycle_baseline_price'],
  ['coin_collapse_schedule', 'baseline_price'],
  ['price_history', 'price'],
  ['market_history', 'total_value'],
  ['apocalypse_transactions', 'price'],
  ['transactions', 'price'],
  ['portfolios', 'average_purchase_price'],
  ['coin_statistics', 'all_time_high'],
  ['coin_statistics', 'all_time_low']
];

async function scaleOf(table, column) {
  const { rows } = await db.query(
    `SELECT numeric_scale FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows[0] ? rows[0].numeric_scale : null;
}

// Simulate the pre-V2 schema on top of existing data: every widened column
// back to scale 2, and the tracking row removed.
async function revert017() {
  for (const [table, column] of WIDENED) {
    const { rows } = await db.query(
      `SELECT numeric_precision FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    await db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE DECIMAL(${rows[0].numeric_precision}, 2)`);
  }
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_017]);
}

describe('V2-1: tracked production migration 017 (price precision)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('the seeded test schema is fully widened and verifies clean', async () => {
    for (const [table, column] of WIDENED) {
      expect(await scaleOf(table, column)).toBe(4);
    }
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });

  test('applies 017 to an existing database, preserving every pre-existing value exactly', async () => {
    // Pre-existing 2dp data with values that must survive the widen.
    const priceBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    await db.query(`INSERT INTO price_history (coin_id, price) VALUES (1, 0.10), (1, 96.45)`);

    await revert017();
    for (const [table, column] of WIDENED) {
      expect(await scaleOf(table, column)).toBe(2);
    }

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_017);

    for (const [table, column] of WIDENED) {
      expect(await scaleOf(table, column)).toBe(4);
    }
    const priceAfter = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    expect(priceAfter.rows).toEqual(priceBefore.rows);
    const { rows: history } = await db.query('SELECT price FROM price_history ORDER BY price_history_id DESC LIMIT 2');
    expect(parseFloat(history[0].price)).toBe(96.45);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('a rerun after losing only the tracking row is a safe no-op (idempotent on widened columns)', async () => {
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_017]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_017);
    for (const [table, column] of WIDENED) {
      expect(await scaleOf(table, column)).toBe(4);
    }
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('an incompatible pre-existing column aborts the migration and records nothing', async () => {
    // An unexpected scale (3dp) is neither "2dp to widen" nor "4dp already
    // widened" — the migration must refuse rather than silently alter it.
    await db.query('ALTER TABLE coins ALTER COLUMN current_price TYPE DECIMAL(18, 3)');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_017]);

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/migration 017/);

    const { rows } = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_017]);
    expect(rows).toHaveLength(0);
    expect(await scaleOf('coins', 'current_price')).toBe(3); // untouched
  });
});
