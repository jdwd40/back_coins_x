// Director Coin Events Wave 4: migration 032 — director_decision_history
// (the append-only Director decision ledger backing the public runtime
// endpoint) against the REAL disposable test database.
//
// Covered:
//   * the seed-built schema already carries the table, constraints and
//     index (DDL single-sourced from the migration) and the schema
//     verifier accepts it;
//   * the migration applies additively to an existing database, seeds
//     EXACTLY ONE history row per committed director_control_state row for
//     its current decision (no control row -> no seed) with the reason
//     mapped safely onto the public summary allowlist (raw reason text is
//     never copied), and is a tracked no-op on re-run;
//   * the migration SQL itself is replay-safe (re-running the file against
//     the correctly-shaped table reseeds nothing);
//   * an incompatible pre-existing table is REJECTED, never silently
//     accepted or "repaired".
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const MIGRATION_032 = '032_create_director_decision_history.sql';
const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', MIGRATION_032),
  'utf8'
);

async function historyRows(worldId) {
  const { rows } = await db.query(
    `SELECT world_id, decision_index, mode, direction, intensity, summary_code
       FROM director_decision_history
      ${worldId === undefined ? '' : 'WHERE world_id = $1'}
      ORDER BY world_id, decision_index`,
    worldId === undefined ? [] : [worldId]
  );
  return rows;
}

async function insertControlRow(worldId, reason, decisionIndex = 0) {
  await db.query(
    `INSERT INTO director_control_state (
       world_id, mode, direction, intensity, started_at, ends_at,
       decision_index, reason
     ) VALUES ($1, 'NORMAL', 'POSITIVE', 0, now(), now() + interval '10 minutes', $2, $3)`,
    [worldId, decisionIndex, reason]
  );
}

describe('migration 032: director_decision_history', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('a fresh schema built by db/seed.js already carries the table (DDL single-sourced)', async () => {
    const { rows } = await db.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'director_decision_history'
        ORDER BY ordinal_position`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'decision_id', 'world_id', 'decision_index', 'mode', 'direction',
      'intensity', 'started_at', 'ends_at', 'summary_code', 'created_at'
    ]);
    expect(rows.find((r) => r.column_name === 'decision_id').data_type).toBe('bigint');
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('an existing database seeds exactly one row per committed control row, mapping the reason safely', async () => {
    await runMigrations({ log: () => {} });

    // Two worlds: one active, one deliberately inactive (the seed is
    // per committed control row regardless of the active flag).
    const activeWorld = await persistentWorld.provisionWorld(db, {
      seed: 'm032-seed-active-world',
      epochStartedAt: new Date('2026-09-08T00:00:00Z')
    });
    const { rows: inactiveRows } = await db.query(
      `INSERT INTO market_worlds (version, seed, epoch_started_at, active)
       VALUES (1, 'm032-seed-inactive-world', now(), false)
       RETURNING world_id`
    );
    const inactiveWorldId = Number(inactiveRows[0].world_id);

    await insertControlRow(activeWorld.worldId, 'rescue: broad drawdown 30% >= 25%', 3);
    await insertControlRow(inactiveWorldId, 'a reason outside every known prefix', 7);

    // Drop the table and the tracking row, then re-apply the migration.
    await db.query('DROP TABLE director_decision_history');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_032]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_032);

    // Exactly one seeded row per committed control row, at its current
    // decision cursor, with the allowlisted summary — never the raw reason.
    expect(await historyRows(activeWorld.worldId)).toEqual([
      {
        world_id: activeWorld.worldId,
        decision_index: 3,
        mode: 'NORMAL',
        direction: 'POSITIVE',
        intensity: 0,
        summary_code: 'RESCUE_DISTRESS'
      }
    ]);
    expect(await historyRows(inactiveWorldId)).toEqual([
      {
        world_id: inactiveWorldId,
        decision_index: 7,
        mode: 'NORMAL',
        direction: 'POSITIVE',
        intensity: 0,
        summary_code: 'OTHER_SAFE'
      }
    ]);
    const rawReasonLeak = await db.query(
      `SELECT count(*)::int AS n FROM director_decision_history
        WHERE summary_code LIKE '%drawdown%' OR summary_code LIKE '%unknown%'`
    );
    expect(rawReasonLeak.rows[0].n).toBe(0);

    // Tracked no-op on re-run: no re-application, no reseed.
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).not.toContain(MIGRATION_032);
    expect((await db.query('SELECT count(*)::int AS n FROM director_decision_history')).rows[0].n).toBe(2);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('no committed control row seeds nothing', async () => {
    await runMigrations({ log: () => {} });
    const world = await persistentWorld.provisionWorld(db, {
      seed: 'm032-no-control-world',
      epochStartedAt: new Date('2026-09-08T00:00:00Z')
    });

    await db.query('DROP TABLE director_decision_history');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_032]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_032);
    expect(await historyRows(world.worldId)).toEqual([]);
  });

  test('the migration SQL itself is replay-safe (re-running the file reseeds nothing)', async () => {
    await runMigrations({ log: () => {} });
    const world = await persistentWorld.provisionWorld(db, {
      seed: 'm032-replay-world',
      epochStartedAt: new Date('2026-09-08T00:00:00Z')
    });
    await insertControlRow(world.worldId, 'genesis: normal open', 0);

    await db.query('DROP TABLE director_decision_history');
    await db.query(MIGRATION_SQL); // fresh apply: seeds one row
    expect((await historyRows(world.worldId))[0].summary_code).toBe('GENESIS_NORMAL');

    // Advance the committed decision, then replay the file: the correctly
    // shaped table is left exactly as-is — no reseed of the new cursor.
    await db.query(
      `UPDATE director_control_state
          SET decision_index = 1, reason = 'normal swing window'
        WHERE world_id = $1`,
      [world.worldId]
    );
    await db.query(MIGRATION_SQL);
    const rows = await historyRows(world.worldId);
    expect(rows).toEqual([
      {
        world_id: world.worldId,
        decision_index: 0,
        mode: 'NORMAL',
        direction: 'POSITIVE',
        intensity: 0,
        summary_code: 'GENESIS_NORMAL'
      }
    ]);
  });

  test('an incompatible pre-existing table is REJECTED (never silently accepted)', async () => {
    await runMigrations({ log: () => {} });
    await db.query('DROP TABLE director_decision_history');
    await db.query('CREATE TABLE director_decision_history (decision_id INTEGER)');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_032]);

    await expect(runMigrations({ log: () => {} }))
      .rejects.toThrow(/director_decision_history table is INCOMPATIBLE/);
    // The failed migration rolled back: 032 was not recorded as applied and
    // the incompatible table was left untouched.
    expect((await db.query(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE migration = $1',
      [MIGRATION_032]
    )).rows[0].n).toBe(0);
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'director_decision_history'`
    );
    expect(rows).toEqual([{ column_name: 'decision_id' }]);
  });
});
