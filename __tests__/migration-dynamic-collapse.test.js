// Migration runner + schema verification coverage for Crypto Chaos gameplay
// overhaul Wave 4 (SIM-13/14): the durable dynamic-collapse death record
// (apocalypse_coin_collapses).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins
// schema and data (via jest.setup.js beforeEach) that migration 022 must
// preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_022 = '022_create_dynamic_collapse.sql';

async function drop022() {
  await db.query('DROP TABLE IF EXISTS apocalypse_coin_collapses CASCADE');
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_022]);
}

describe('Wave 4: tracked production migration 022', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 022 to an existing database, preserving all pre-existing schema and data', async () => {
    // "Existing production data": a live cycle with a participant and a
    // legacy scheduled-collapse row (the retired table is preserved data).
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig022-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 10000.00, 10000.00, 10000.00, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO coin_collapse_schedule (cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price)
       VALUES (1, 1, 0, '2026-08-20T10:21:00Z', 0.10)`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await drop022(); // simulate the pre-Wave-4 schema on top of existing data
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_022);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Pre-existing data fully preserved — including the legacy schedule
    // rows; the new death-record table starts empty.
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_participants')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM coin_collapse_schedule')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_coin_collapses')).rows[0].n).toBe(0);
  });

  test('is idempotent: re-running leaves schema and data untouched', async () => {
    await runMigrations({ log: () => {} });
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([]);
    const { problems } = await verifyGameSchema();
    expect(problems).toEqual([]);
  });

  test('SQL-level rerun on a compatible existing table is a verified no-op', async () => {
    // Lose only the tracking row: the runner must re-execute 022 against the
    // existing compatible table, detect compatibility, and record it again.
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_022]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_022);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);

    // Fully tracked again: a further rerun is a pure no-op.
    const again = await runMigrations({ log: () => {} });
    expect(again.applied).toEqual([]);
  });

  test('fails clearly on an incompatible pre-existing apocalypse_coin_collapses table', async () => {
    await drop022();
    await db.query('CREATE TABLE apocalypse_coin_collapses (collapse_id integer)');
    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);

    // The failed migration was rolled back: not recorded.
    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_022]);
    expect(tracked.rows).toHaveLength(0);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
  });

  test('verification fails clearly when the Wave 4 table is absent', async () => {
    await drop022();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('table public.apocalypse_coin_collapses does not exist');
  });

  test('the database enforces the death-record invariants: identity, FKs, non-negative rank', async () => {
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig022-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    const valid = `
      INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
      VALUES (1, 1, 0, '2026-08-20T10:21:00Z')`;
    await db.query(valid);

    // A coin dies at most once per cycle (the no-resurrection backstop).
    await expect(db.query(valid)).rejects.toThrow(/duplicate key/);

    // The execution order is unambiguous within a cycle.
    await expect(db.query(
      `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
       VALUES (1, 2, 0, '2026-08-20T10:22:00Z')`
    )).rejects.toThrow(/duplicate key/);

    // The rank is never negative.
    await expect(db.query(
      `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
       VALUES (1, 2, -1, '2026-08-20T10:22:00Z')`
    )).rejects.toThrow(/violates check/);

    // The cycle FK ties every death to a real cycle.
    await expect(db.query(
      `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
       VALUES (999, 2, 1, '2026-08-20T10:22:00Z')`
    )).rejects.toThrow(/violates foreign key/);

    // The coin FK ties every death to a real coin.
    await expect(db.query(
      `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
       VALUES (1, 999, 1, '2026-08-20T10:22:00Z')`
    )).rejects.toThrow(/violates foreign key/);
  });
});
