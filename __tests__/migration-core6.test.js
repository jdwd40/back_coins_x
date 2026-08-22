// Migration runner + schema verification coverage for Crypto Chaos Core 6.
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins schema
// and data (via jest.setup.js beforeEach) that migration 011 must preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_011 = '011_create_apocalypse_results.sql';

// Simulate the pre-Core-6 production state: Coins schema + data + Core 1/3/4/5
// game objects, but no settlement schema: no results table, no immutability
// function, no single-settling index, no settlement observability columns,
// and the Core 1 shape of the apocalypse_cycles status CHECK.
async function dropCore6Schema() {
  await db.query('DROP TABLE IF EXISTS apocalypse_results CASCADE');
  await db.query('DROP FUNCTION IF EXISTS apocalypse_results_immutable()');
  await db.query('DROP INDEX IF EXISTS apocalypse_cycles_single_settling');
  await db.query('ALTER TABLE apocalypse_cycles DROP COLUMN IF EXISTS settlement_started_at');
  await db.query('ALTER TABLE apocalypse_cycles DROP COLUMN IF EXISTS settled_at');
  // Restore the Core 1 status CHECK shape (ACTIVE/COMPLETED only). No SETTLING
  // rows can exist in this simulated state.
  await db.query('ALTER TABLE apocalypse_cycles DROP CONSTRAINT IF EXISTS apocalypse_cycles_status_check');
  await db.query(
    `ALTER TABLE apocalypse_cycles
     ADD CONSTRAINT apocalypse_cycles_status_check CHECK (status IN ('ACTIVE', 'COMPLETED'))`
  );
}

async function dropCore6Tracking() {
  // 015 (leaderboard_eligible) alters apocalypse_results, which
  // dropCore6Schema drops — clear its tracking row too so the rerun
  // restores the canonical post-#19 schema.
  await db.query('DELETE FROM schema_migrations WHERE migration = ANY($1)', [[MIGRATION_011, '015_leaderboard_eligible.sql']]);
}

describe('Core 6: tracked production migration 011', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 011 to an existing Coins database, preserving all legacy and Core 1/3/4/5 data', async () => {
    // Give the "existing" database observable legacy + game data that must
    // survive, including a LEGACY completed cycle (pre-Core-6: settled_at is
    // NULL and no results rows exist — the verifier must exempt it).
    await db.query(`INSERT INTO portfolios (user_id, coin_id, quantity) VALUES (1, 1, 12.50)`);
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'core6-migration-seed', now() - interval '1 hour', now() - interval '30 minutes', 1800000, 'COMPLETED')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status, final_cash)
       VALUES (1, 1, 1000.00, 750.00, 1250.00, 'FINALIZED', 750.00)`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');
    const participantsBefore = await db.query('SELECT count(*)::int AS n FROM apocalypse_participants');

    await dropCore6Schema();
    await dropCore6Tracking();

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toEqual([MIGRATION_011, '015_leaderboard_eligible.sql']); // only Core 6 was missing

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Legacy and Core 1/3/4/5 data fully preserved.
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM apocalypse_participants')).rows[0].n)
      .toBe(participantsBefore.rows[0].n);
    const { rows: portfolio } = await db.query('SELECT quantity FROM portfolios WHERE user_id = 1 AND coin_id = 1');
    expect(parseFloat(portfolio[0].quantity)).toBe(12.5);
    // The legacy completed cycle survives with its NULL settled_at exempt.
    const { rows: legacy } = await db.query(
      `SELECT status, settled_at FROM apocalypse_cycles WHERE apocalypse_id = 'APOC-0001'`
    );
    expect(legacy[0].status).toBe('COMPLETED');
    expect(legacy[0].settled_at).toBeNull();

    // The status CHECK now accepts SETTLING (the Core 6 lifecycle phase).
    const { rows: checks } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'public.apocalypse_cycles'::regclass AND contype = 'c'`
    );
    expect(checks.some((r) => /ACTIVE/.test(r.def) && /SETTLING/.test(r.def) && /COMPLETED/.test(r.def))).toBe(true);

    // The results table starts empty — no result state is fabricated.
    const { rows: results } = await db.query('SELECT count(*)::int AS n FROM apocalypse_results');
    expect(results[0].n).toBe(0);
  });

  test('re-running the runner is a no-op once 011 is recorded', async () => {
    const again = await runMigrations({ log: () => {} });
    expect(again.applied).toEqual([]);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('SQL-level rerun on compatible existing objects is a verified no-op', async () => {
    // Lose only the tracking row: the runner must re-execute 011 against the
    // existing compatible objects, detect compatibility, and record it again.
    await dropCore6Tracking();
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([MIGRATION_011, '015_leaderboard_eligible.sql']);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('a pre-existing INCOMPATIBLE same-named results table fails the migration loudly', async () => {
    await dropCore6Schema();
    await dropCore6Tracking();
    await db.query(`CREATE TABLE apocalypse_results (result_id SERIAL PRIMARY KEY, note TEXT)`);

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);
    const { rows: tracking } = await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_011]
    );
    expect(tracking[0].n).toBe(0);
  });

  test('a pre-existing INCOMPATIBLE same-named single-settling index fails the migration loudly', async () => {
    await dropCore6Schema();
    await dropCore6Tracking();
    // Same name, wrong shape (non-unique).
    await db.query('CREATE INDEX apocalypse_cycles_single_settling ON apocalypse_cycles (status)');

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);
    const { rows: tracking } = await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_011]
    );
    expect(tracking[0].n).toBe(0);
  });

  test('a pre-existing status CHECK without SETTLING is widened, not rejected', async () => {
    // The Core 1 status CHECK shape is the expected predecessor, not an
    // incompatibility: the migration must widen it in place.
    await dropCore6Schema();
    await dropCore6Tracking();

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toEqual([MIGRATION_011, '015_leaderboard_eligible.sql']);
    const { rows: checks } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'public.apocalypse_cycles'::regclass AND contype = 'c'`
    );
    expect(checks.some((r) => /SETTLING/.test(r.def))).toBe(true);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('verification fails clearly when Core 6 objects are absent', async () => {
    await dropCore6Schema();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('table public.apocalypse_results does not exist');
    expect(verification.problems.join(' ')).toMatch(/apocalypse_cycles_single_settling/);
    expect(verification.problems.join(' ')).toMatch(/settlement_started_at/);
  });

  test('seeded test schema (production DDL via db/seed.js) verifies cleanly', async () => {
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });
});
