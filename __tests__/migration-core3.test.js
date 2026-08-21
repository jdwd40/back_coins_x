// Migration runner + schema verification coverage for Crypto Chaos Core 3.
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

const MIGRATION_008 = '008_create_coin_collapse_schedule.sql';

// Simulate the pre-Core-3 production state: Coins schema + data + Core 1 game
// table, but no collapse schedule and no baseline column. An initial runner
// invocation first establishes the tracking table (seed drops it) so that the
// second run applies ONLY migration 008.
async function dropCore3Schema() {
  await db.query('DROP TABLE IF EXISTS coin_collapse_schedule CASCADE');
  await db.query('ALTER TABLE coins DROP COLUMN IF EXISTS cycle_baseline_price');
}

async function dropCore3Tracking() {
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_008]);
}

describe('Core 3: tracked production migration 008', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 008 to an existing Coins database, preserving data and backfilling the baseline non-destructively', async () => {
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    // Disturb one live price so the backfill is observably sourced from it.
    await db.query('UPDATE coins SET current_price = 999.99 WHERE coin_id = $1', [coinsBefore.rows[0].coin_id]);
    await dropCore3Schema();
    await dropCore3Tracking();

    const result = await runMigrations({ log: () => {} });

    expect(result.applied).toEqual([MIGRATION_008]); // only Core 3 was missing

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Existing Coins data untouched; baseline backfilled from the live price.
    const usersAfter = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsAfter = await db.query('SELECT coin_id, current_price, cycle_baseline_price FROM coins ORDER BY coin_id');
    expect(usersAfter.rows[0].n).toBe(usersBefore.rows[0].n);
    expect(coinsAfter.rows).toHaveLength(coinsBefore.rows.length);
    for (const coin of coinsAfter.rows) {
      expect(coin.cycle_baseline_price).toBe(coin.current_price);
    }
    expect(coinsAfter.rows[0].cycle_baseline_price).toBe('999.99');

    // The schedule table starts empty — no collapse state is fabricated.
    const { rows } = await db.query('SELECT count(*)::int AS n FROM coin_collapse_schedule');
    expect(rows[0].n).toBe(0);
  });

  test('a second 008 run never overwrites an existing baseline value', async () => {
    await dropCore3Schema();
    await dropCore3Tracking();
    await runMigrations({ log: () => {} });

    // Operator-adjusted baseline must survive a re-run of the backfill path.
    await db.query('UPDATE coins SET cycle_baseline_price = 42.50 WHERE coin_id = (SELECT min(coin_id) FROM coins)');
    await db.query('UPDATE coins SET current_price = 777 WHERE coin_id = (SELECT min(coin_id) FROM coins)');
    await dropCore3Tracking();

    await runMigrations({ log: () => {} });
    const { rows } = await db.query('SELECT cycle_baseline_price FROM coins WHERE coin_id = (SELECT min(coin_id) FROM coins)');
    expect(rows[0].cycle_baseline_price).toBe('42.50');
  });

  test('safe rerun: tracked migration is skipped entirely', async () => {
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toContain(MIGRATION_008);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('SQL-level rerun on compatible existing objects is a verified no-op', async () => {
    // Lose only the tracking row: the runner re-executes 008 against the
    // existing compatible table/column/index, detects compatibility, and
    // records it again without error.
    await dropCore3Tracking();
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_008);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('fails clearly on an incompatible pre-existing coin_collapse_schedule table and records nothing', async () => {
    await dropCore3Schema();
    await dropCore3Tracking();
    await db.query('CREATE TABLE coin_collapse_schedule (schedule_id integer)');

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);

    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_008]);
    expect(tracked.rows).toHaveLength(0);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.length).toBeGreaterThan(0);
  });

  test('fails clearly on an incompatible pre-existing cycle_baseline_price column', async () => {
    await dropCore3Schema();
    await dropCore3Tracking();
    await db.query(`ALTER TABLE coins ADD COLUMN cycle_baseline_price TEXT`);

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);

    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_008]);
    expect(tracked.rows).toHaveLength(0);
  });

  test('fails clearly on a same-named but wrong due-reconciliation index', async () => {
    // Compatible objects via one good run, then replace the partial index
    // with a same-named non-partial one.
    await runMigrations({ log: () => {} });
    await db.query('DROP INDEX idx_coin_collapse_schedule_due');
    await db.query('CREATE INDEX idx_coin_collapse_schedule_due ON coin_collapse_schedule (scheduled_at)');
    await dropCore3Tracking();

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);
  });

  test('fails loudly rather than guessing a baseline when a coin price is non-positive', async () => {
    await dropCore3Schema();
    await dropCore3Tracking();
    // Corrupt a live price; no safe baseline can be derived from it.
    await db.query('ALTER TABLE coins ALTER COLUMN current_price DROP NOT NULL');
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = (SELECT min(coin_id) FROM coins)');

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/cannot derive a safe baseline/);
  });

  test('verification fails clearly when Core 3 objects are absent', async () => {
    await dropCore3Schema();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('table public.coin_collapse_schedule does not exist');
    expect(verification.problems).toContain('missing column: coins.cycle_baseline_price');
  });

  test('verification catches a live zero-priced coin with no executed collapse row', async () => {
    const { reconcileCycle } = require('../game/gameCycleService');
    // Fixed early-cycle time: an ACTIVE cycle exists with a schedule, but no
    // collapse is due yet — deterministic regardless of the wall clock.
    await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = (SELECT min(coin_id) FROM coins)');

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toMatch(/zero-priced coins have no executed collapse/);
  });

  test('verification catches a collapsed coin revived to a non-zero price', async () => {
    const { reconcileCycle } = require('../game/gameCycleService');
    const start = new Date('2026-08-20T10:00:00.000Z');
    const windowStart = new Date(start.getTime() + 30 * 60 * 1000 * 0.70);
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    await reconcileCycle({ now: windowStart }); // rank 0 collapses
    await db.query(
      `UPDATE coins SET current_price = 10
       WHERE coin_id = (SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0)`,
      [cycle.cycle_id]
    );

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toMatch(/collapsed coins in the ACTIVE\/SETTLING cycle have a non-zero live price/);
  });
});
