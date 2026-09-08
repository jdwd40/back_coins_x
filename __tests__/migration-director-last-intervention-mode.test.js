// Director Coin Events Wave 2 (PR #36 wave-2 correction): migration 031 —
// director_control_state.last_intervention_mode (the refractory ORIGIN mode:
// the mode of the intervention whose ending set last_intervention_ended_at)
// against the REAL disposable test database.
//
// The adaptive Director emergency policy reads the origin mode to decide
// whether the short emergency refractory may apply during the ordinary
// refractory: a refractory created by an ended BOOM/BUST yields to a newly
// encountered emergency after directorControl.emergencyRefractoryMs, while a
// RESCUE-created refractory always holds the full ordinary refractory (the
// emergency may not override the refractory its own ended window created).
//
// Covered:
//   * the seed-built schema already carries the column (DDL single-sourced
//     from the migration);
//   * the migration applies additively to a 030-shaped table, preserves
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

const MIGRATION_031 = '031_director_control_last_intervention_mode.sql';

const COLUMN_QUERY = `SELECT data_type, is_nullable, character_maximum_length
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'director_control_state'
     AND column_name = 'last_intervention_mode'`;

describe('migration 031: director_control_state.last_intervention_mode', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('a fresh schema built by db/seed.js already carries the column (DDL single-sourced)', async () => {
    const { rows } = await db.query(COLUMN_QUERY);
    expect(rows).toEqual([{ data_type: 'character varying', is_nullable: 'YES', character_maximum_length: 8 }]);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('the migration applies additively to a 030-shaped table, preserves rows, and is a tracked no-op on re-run', async () => {
    await runMigrations({ log: () => {} });

    // A committed legacy row (no origin mode) must survive the column add
    // as NULL — the domain reads that as "refractory origin unknown",
    // treated permissively for a newly encountered emergency.
    const world = await persistentWorld.provisionWorld(db, {
      seed: 'm031-legacy-world',
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
    await db.query('ALTER TABLE director_control_state DROP COLUMN last_intervention_mode');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_031]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_031);

    const { rows } = await db.query(COLUMN_QUERY);
    expect(rows).toEqual([{ data_type: 'character varying', is_nullable: 'YES', character_maximum_length: 8 }]);
    const legacy = await db.query(
      'SELECT last_intervention_mode FROM director_control_state WHERE world_id = $1',
      [world.worldId]
    );
    expect(legacy.rows).toEqual([{ last_intervention_mode: null }]);

    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).not.toContain(MIGRATION_031);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('an incompatible pre-existing column is REJECTED (never silently accepted)', async () => {
    await runMigrations({ log: () => {} });
    await db.query('ALTER TABLE director_control_state DROP COLUMN last_intervention_mode');
    await db.query('ALTER TABLE director_control_state ADD COLUMN last_intervention_mode INTEGER');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_031]);

    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/last_intervention_mode is INCOMPATIBLE/);
    // The failed migration rolled back: 031 was not recorded as applied and
    // the incompatible column was left untouched.
    expect((await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_031]
    )).rows[0].n).toBe(0);
    const { rows } = await db.query(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'director_control_state'
          AND column_name = 'last_intervention_mode'`
    );
    expect(rows).toEqual([{ data_type: 'integer', is_nullable: 'YES' }]);
  });
});
