// Director Coin Events Wave 2 (PR #36 correction): migration 030 —
// director_control_state.last_intervention_ended_at (the post-intervention
// refractory tracker) against the REAL disposable test database.
//
// Covered:
//   * the seed-built schema already carries the column (DDL single-sourced
//     from the migration);
//   * the migration applies additively to a 029-shaped table, preserves
//     legacy rows, and is a tracked no-op on re-run;
//   * an incompatible pre-existing column is REJECTED, never silently
//     accepted or "repaired".
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const MIGRATION_030 = '030_director_control_refractory.sql';

const COLUMN_QUERY = `SELECT data_type, is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'director_control_state'
     AND column_name = 'last_intervention_ended_at'`;

describe('migration 030: director_control_state.last_intervention_ended_at', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('a fresh schema built by db/seed.js already carries the column (DDL single-sourced)', async () => {
    const { rows } = await db.query(COLUMN_QUERY);
    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('the migration applies additively to a 029-shaped table, preserves rows, and is a tracked no-op on re-run', async () => {
    await runMigrations({ log: () => {} });

    // A committed legacy row (no tracker) must survive the column add as
    // NULL — the domain reads that as "no refractory in progress".
    const world = await persistentWorld.provisionWorld(db, {
      seed: 'm030-legacy-world',
      epochStartedAt: new Date('2026-08-31T00:00:00Z')
    });
    await db.query(
      `INSERT INTO director_control_state (
         world_id, mode, direction, intensity, started_at, ends_at,
         decision_index, reason
       ) VALUES ($1, 'NORMAL', 'POSITIVE', 0, now(), now() + interval '10 minutes', 0, 'legacy row')`,
      [world.worldId]
    );

    // Drop the column and the tracking row, then re-apply the migration.
    await db.query('ALTER TABLE director_control_state DROP COLUMN last_intervention_ended_at');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_030]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_030);

    const { rows } = await db.query(COLUMN_QUERY);
    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
    const legacy = await db.query(
      'SELECT last_intervention_ended_at FROM director_control_state WHERE world_id = $1',
      [world.worldId]
    );
    expect(legacy.rows).toEqual([{ last_intervention_ended_at: null }]);

    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).not.toContain(MIGRATION_030);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('an incompatible pre-existing column is REJECTED (never silently accepted)', async () => {
    await runMigrations({ log: () => {} });
    await db.query('ALTER TABLE director_control_state DROP COLUMN last_intervention_ended_at');
    await db.query('ALTER TABLE director_control_state ADD COLUMN last_intervention_ended_at INTEGER');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_030]);

    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/last_intervention_ended_at is INCOMPATIBLE/);
    // The failed migration rolled back: 030 was not recorded as applied and
    // the incompatible column was left untouched.
    expect((await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_030]
    )).rows[0].n).toBe(0);
    const { rows } = await db.query(COLUMN_QUERY);
    expect(rows).toEqual([{ data_type: 'integer', is_nullable: 'YES' }]);
  });
});
