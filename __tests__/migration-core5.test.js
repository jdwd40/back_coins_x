// Migration runner + schema verification coverage for Crypto Chaos Core 5.
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins schema
// and data (via jest.setup.js beforeEach) that migration 010 must preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_010 = '010_create_apocalypse_bots.sql';

// Simulate the pre-Core-5 production state: Coins schema + data + Core 1/3/4
// game tables, but no bot schema (no bot tables, no users.is_bot column).
async function dropCore5Schema() {
  await db.query('DROP TABLE IF EXISTS apocalypse_bot_ticks CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_bots CASCADE');
  await db.query('ALTER TABLE users DROP COLUMN IF EXISTS is_bot');
}

async function dropCore5Tracking() {
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_010]);
}

describe('Core 5: tracked production migration 010', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 010 to an existing Coins database, preserving all legacy and Core 1/3/4 data', async () => {
    // Give the "existing" database observable legacy + Core 4 data that must survive.
    await db.query(`INSERT INTO portfolios (user_id, coin_id, quantity) VALUES (1, 1, 12.50)`);
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'core5-migration-seed', now(), now() + interval '30 minutes', 1800000, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 1000.00, 1000.00, 1000.00, 'ACTIVE')`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');
    const cyclesBefore = await db.query('SELECT count(*)::int AS n FROM apocalypse_cycles');
    const participantsBefore = await db.query('SELECT count(*)::int AS n FROM apocalypse_participants');

    await dropCore5Schema();
    await dropCore5Tracking();

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toEqual([MIGRATION_010]); // only Core 5 was missing

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Legacy and Core 1/3/4 data fully preserved.
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_cycles')).rows[0].n).toBe(cyclesBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_participants')).rows[0].n)
      .toBe(participantsBefore.rows[0].n);
    const { rows: portfolio } = await db.query('SELECT quantity FROM portfolios WHERE user_id = 1 AND coin_id = 1');
    expect(parseFloat(portfolio[0].quantity)).toBe(12.5);

    // The bot marker defaults to false for every pre-existing (human) user.
    const { rows: markers } = await db.query('SELECT count(*)::int AS n FROM users WHERE is_bot = true');
    expect(markers[0].n).toBe(0);
    const { rows: cols } = await db.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_bot'`
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].data_type).toBe('boolean');
    expect(cols[0].is_nullable).toBe('NO');
  });

  test('re-running the runner is a no-op once 010 is recorded', async () => {
    const again = await runMigrations({ log: () => {} });
    expect(again.applied).toEqual([]);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('a pre-existing INCOMPATIBLE same-named bot table fails the migration loudly', async () => {
    // Simulate an operator-created table squatting on the Core 5 name with
    // the wrong shape: the migration must REFUSE (RAISE EXCEPTION), never
    // silently adopt or modify it, and leave schema_migrations untouched.
    await dropCore5Schema();
    await dropCore5Tracking();
    await db.query(`CREATE TABLE apocalypse_bots (bot_id SERIAL PRIMARY KEY, note TEXT)`);

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);
    const { rows: tracking } = await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_010]
    );
    expect(tracking[0].n).toBe(0);
  });

  test('seeded test schema (production DDL via db/seed.js) verifies cleanly', async () => {
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });
});
