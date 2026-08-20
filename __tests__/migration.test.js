// Migration runner + schema verification coverage for Crypto Chaos Core 1.
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins schema
// and data (via jest.setup.js beforeEach) that the migration must preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_007 = '007_create_apocalypse_cycles.sql';

async function dropGameSchema() {
  // Core 4 round-state tables depend on apocalypse_cycles (FK); dropping the
  // cycles table CASCADE would silently strip their FK constraints, so the
  // pre-game-schema simulation must remove them explicitly first.
  await db.query('DROP TABLE IF EXISTS apocalypse_transactions CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_holdings CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_participants CASCADE');
  await db.query('DROP TABLE IF EXISTS coin_collapse_schedule CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_cycles CASCADE');
  await db.query('ALTER TABLE coins DROP COLUMN IF EXISTS cycle_baseline_price');
  await db.query('DROP TABLE IF EXISTS schema_migrations CASCADE');
}

describe('Core 1: tracked production migrations', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('applies 007 to an existing Coins database, preserving unrelated data', async () => {
    // Simulate the pre-Core-1 production state: Coins schema + data, no game table.
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');
    await dropGameSchema();

    const result = await runMigrations({ log: () => {} });

    expect(result.applied).toContain(MIGRATION_007);
    // Legacy migrations are baselined (recorded, not executed).
    expect(result.baselined.length).toBeGreaterThan(0);
    expect(result.baselined).toContain('001_create_tables.sql');

    // Tracking row recorded.
    const tracked = await db.query('SELECT migration FROM schema_migrations');
    expect(tracked.rows.map((r) => r.migration)).toContain(MIGRATION_007);

    // Game table now exists and passes full verification.
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Unrelated Coins data untouched.
    const usersAfter = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsAfter = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(usersAfter.rows[0].n).toBe(usersBefore.rows[0].n);
    expect(coinsAfter.rows[0].n).toBe(coinsBefore.rows[0].n);
    expect(usersBefore.rows[0].n).toBeGreaterThan(0);
    expect(coinsBefore.rows[0].n).toBeGreaterThan(0);
  });

  test('safe rerun: a second run applies nothing and skips tracked migrations', async () => {
    await dropGameSchema();
    await runMigrations({ log: () => {} });

    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([]);
    expect(rerun.baselined).toEqual([]);
    expect(rerun.skipped).toContain(MIGRATION_007);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('SQL-level rerun on a compatible existing table is a verified no-op', async () => {
    await dropGameSchema();
    await runMigrations({ log: () => {} });

    // Lose the tracking row only: the runner must re-execute 007 against the
    // existing compatible table, detect compatibility, and record it again.
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_007]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_007);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('fails clearly on an incompatible pre-existing table and records nothing', async () => {
    await dropGameSchema();
    // Legacy/broken object with the same name but a completely wrong shape.
    await db.query('CREATE TABLE apocalypse_cycles (cycle_id integer)');
    await db.query(`INSERT INTO apocalypse_cycles (cycle_id) VALUES (1)`);
    await db.query(`CREATE TABLE schema_migrations (migration VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/INCOMPATIBLE/);

    // The failed migration was rolled back: not recorded, wrong-shaped row intact.
    const tracked = await db.query('SELECT migration FROM schema_migrations');
    expect(tracked.rows.map((r) => r.migration)).not.toContain(MIGRATION_007);
    const rows = await db.query('SELECT * FROM apocalypse_cycles');
    expect(rows.rows).toHaveLength(1);

    // Verification independently reports the mismatch.
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.length).toBeGreaterThan(0);
  });

  test('fails clearly on an incompatible pre-existing single-active index', async () => {
    await dropGameSchema();
    // Compatible table (via one good run), then replace the index with a
    // same-named but wrong (non-unique) index.
    await runMigrations({ log: () => {} });
    await db.query('DROP INDEX apocalypse_cycles_single_active');
    await db.query('CREATE INDEX apocalypse_cycles_single_active ON apocalypse_cycles (status)');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_007]);

    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/INCOMPATIBLE/);
  });

  test('rejects a same-named partial unique index with the wrong predicate', async () => {
    await dropGameSchema();
    await runMigrations({ log: () => {} });
    await db.query('DROP INDEX apocalypse_cycles_single_active');
    await db.query("CREATE UNIQUE INDEX apocalypse_cycles_single_active ON apocalypse_cycles (status) WHERE status = 'COMPLETED'");
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_007]);

    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/INCOMPATIBLE/);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toMatch(/ACTIVE/);
  });

  test('verification fails clearly when the table is absent', async () => {
    await dropGameSchema();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('table public.apocalypse_cycles does not exist');
  });

  test('the migration runner never invokes the destructive seed module', () => {
    // Structural guard: migrate.js must not reference db/seed at all.
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../db/migrate'), 'utf8');
    expect(source).not.toMatch(/require\(['"].*seed['"]\)/);
  });
});
