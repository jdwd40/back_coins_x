// Migration runner + schema verification coverage for Crypto Chaos gameplay
// overhaul Wave 2 (SIM-06/07): the durable per-cycle market-state table
// (apocalypse_market_state).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins
// schema and data (via jest.setup.js beforeEach) that migration 021 must
// preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_021 = '021_create_market_state.sql';

async function drop021() {
  await db.query('DROP TABLE IF EXISTS apocalypse_market_state CASCADE');
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_021]);
}

describe('Wave 2: tracked production migration 021', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 021 to an existing database, preserving all pre-existing schema and data', async () => {
    // "Existing production data": a live cycle with a participant and a
    // Wave 1 market-phase row.
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig021-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 10000.00, 10000.00, 10000.00, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_market_phases
         (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
       VALUES (1, 1, 'BOOM', 'GROWTH', 0.02, '2026-08-20T10:00:00Z', '2026-08-20T10:05:00Z')`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await drop021(); // simulate the pre-Wave-2 schema on top of existing data
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_021);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Pre-existing data fully preserved; the new table starts empty.
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_participants')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_market_phases')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_market_state')).rows[0].n).toBe(0);
  });

  test('is idempotent: re-running leaves schema and data untouched', async () => {
    await runMigrations({ log: () => {} });
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([]);
    const { problems } = await verifyGameSchema();
    expect(problems).toEqual([]);
  });

  test('SQL-level rerun on a compatible existing table is a verified no-op', async () => {
    // Lose only the tracking row: the runner must re-execute 021 against the
    // existing compatible table, detect compatibility, and record it again.
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_021]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_021);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);

    // Fully tracked again: a further rerun is a pure no-op.
    const again = await runMigrations({ log: () => {} });
    expect(again.applied).toEqual([]);
  });

  test('fails clearly on an incompatible pre-existing apocalypse_market_state table', async () => {
    await drop021();
    await db.query('CREATE TABLE apocalypse_market_state (state_id integer)');
    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);

    // The failed migration was rolled back: not recorded.
    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_021]);
    expect(tracked.rows).toHaveLength(0);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
  });

  test('verification fails clearly when the Wave 2 table is absent', async () => {
    await drop021();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('table public.apocalypse_market_state does not exist');
  });

  test('the database enforces the market-state invariants: identity, FK, vocabulary, monotonic peak, ranges', async () => {
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig021-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    const valid = `
      INSERT INTO apocalypse_market_state
        (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
      VALUES (1, 100, 120, 120, '2026-08-20T10:05:00Z', 0, 0.2, 'GROWTH', 250, '2026-08-20T10:05:00Z')`;
    await db.query(valid);

    // The idempotency backstop: one state row per cycle, ever.
    await expect(db.query(valid)).rejects.toThrow(/duplicate key/);

    // The lifecycle vocabulary is closed.
    await expect(db.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES (1, 100, 100, 100, '2026-08-20T10:00:00Z', 0, 0, 'MANIA', 250, '2026-08-20T10:00:00Z')`
    )).rejects.toThrow(/violates check/);

    // Index values are never negative.
    await expect(db.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES (1, -0.5, 0, 0, '2026-08-20T10:00:00Z', 0, 0, 'GROWTH', 0, '2026-08-20T10:00:00Z')`
    )).rejects.toThrow(/violates check/);

    // The peak is monotonic against the starting and current indexes.
    await expect(db.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES (1, 100, 90, 95, '2026-08-20T10:00:00Z', 0.05, -0.1, 'GROWTH', 250, '2026-08-20T10:00:00Z')`
    )).rejects.toThrow(/violates check/);
    await expect(db.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES (1, 100, 130, 120, '2026-08-20T10:00:00Z', 0, 0.3, 'GROWTH', 250, '2026-08-20T10:00:00Z')`
    )).rejects.toThrow(/violates check/);

    // Drawdown is a fraction in [0, 1]; momentum never below -1.
    await expect(db.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES (1, 100, 50, 100, '2026-08-20T10:00:00Z', 1.5, -0.5, 'DECLINE', 250, '2026-08-20T10:00:00Z')`
    )).rejects.toThrow(/violates check/);
    await expect(db.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES (1, 100, 50, 100, '2026-08-20T10:00:00Z', 0.5, -1.5, 'DECLINE', 250, '2026-08-20T10:00:00Z')`
    )).rejects.toThrow(/violates check/);

    // The generated plateau target never sits below the starting index.
    await expect(db.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES (1, 100, 100, 100, '2026-08-20T10:00:00Z', 0, 0, 'GROWTH', 90, '2026-08-20T10:00:00Z')`
    )).rejects.toThrow(/violates check/);

    // The cycle FK ties every row to a real cycle.
    await expect(db.query(
      `INSERT INTO apocalypse_market_state
         (cycle_id, starting_index, current_index, peak_index, peak_at, drawdown, momentum, lifecycle_state, plateau_target, last_evaluated_at)
       VALUES (999, 100, 100, 100, '2026-08-20T10:00:00Z', 0, 0, 'GROWTH', 250, '2026-08-20T10:00:00Z')`
    )).rejects.toThrow(/violates foreign key/);
  });
});
