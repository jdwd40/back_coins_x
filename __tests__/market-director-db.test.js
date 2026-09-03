// Persistent-market Stage 3: world-level Market Director state against the
// REAL disposable test database — migration 025, the Director cursor
// validation contract, and the deterministic chain/persistence parity.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const persistentWorld = require('../game/persistentWorld');
const marketDirector = require('../game/marketDirector');
const directorStateModel = require('../models/marketDirectorState.model');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

const MIGRATION_025 = '025_create_market_director_state.sql';
const WORLD_SEED = 'stage3-director-db-seed';

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date('2026-08-31T00:00:00Z') });
}

describe('Stage 3: tracked production migration 025', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} });
  });

  test('applies 025 to an existing database, preserving all pre-existing schema and data', async () => {
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await db.query('DROP TABLE IF EXISTS market_director_state CASCADE');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_025]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_025);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    const legacy = await db.query(`SELECT to_regclass('public.apocalypse_cycles') AS r`);
    expect(legacy.rows[0].r).not.toBeNull();
  });

  test('re-running the migration on an already-migrated database is a tracked no-op', async () => {
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).not.toContain(MIGRATION_025);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });
});

describe('Stage 3: Director cursor persistence + validation', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('committing the deterministic chain cursor round-trips and is replay-safe', async () => {
    const world = await provisionedWorld();
    const provider = marketDirector.createMarketDirectorProvider({ seed: WORLD_SEED, originMs: 0 });
    const located = provider.regimeAt(3 * 24 * 60 * 60 * 1000);

    const state = {
      worldId: world.worldId,
      regime: located.regime,
      regimeStartedAt: new Date(located.startMs).toISOString(),
      intensity: located.intensity,
      regimeIndex: located.regimeIndex
    };
    await directorStateModel.upsertDirectorState(db, state);
    const loaded = await directorStateModel.loadDirectorState(db, world.worldId);
    expect(loaded.regime).toBe(located.regime);
    expect(new Date(loaded.regimeStartedAt).getTime()).toBe(located.startMs);
    expect(Object.is(loaded.intensity, located.intensity)).toBe(true);
    expect(loaded.regimeIndex).toBe(located.regimeIndex);

    // Replay: re-committing the same deterministic cursor is a no-op write.
    await directorStateModel.upsertDirectorState(db, state);
    const replayed = await directorStateModel.loadDirectorState(db, world.worldId);
    expect(replayed.regime).toBe(located.regime);
  });

  test('no cursor exists before the first commit (the world opens at genesis)', async () => {
    const world = await provisionedWorld();
    const loaded = await directorStateModel.loadDirectorState(db, world.worldId);
    expect(loaded).toBeNull();
  });

  test('corrupt Director state fails loudly at the model layer', async () => {
    const world = await provisionedWorld();
    const base = {
      worldId: world.worldId,
      regime: 'BULL',
      regimeStartedAt: new Date(0).toISOString(),
      intensity: 0.5,
      regimeIndex: 3
    };
    await expect(directorStateModel.upsertDirectorState(db, { ...base, regime: 'SIDEWAYS' }))
      .rejects.toThrow(/regime/);
    await expect(directorStateModel.upsertDirectorState(db, { ...base, intensity: 1.5 }))
      .rejects.toThrow(/intensity/);
    await expect(directorStateModel.upsertDirectorState(db, { ...base, intensity: -0.1 }))
      .rejects.toThrow(/intensity/);
    await expect(directorStateModel.upsertDirectorState(db, { ...base, regimeIndex: -1 }))
      .rejects.toThrow(/regimeIndex/);
    await expect(directorStateModel.upsertDirectorState(db, { ...base, regimeStartedAt: 'not-a-date' }))
      .rejects.toThrow(/regimeStartedAt/);
    await expect(directorStateModel.upsertDirectorState(db, { ...base, regimeIndex: 2.5 }))
      .rejects.toThrow(/regimeIndex/);
    // The CHECK constraints back the model up at the SQL layer.
    await expect(db.query(
      `INSERT INTO market_director_state (world_id, regime, regime_started_at, intensity, regime_index)
       VALUES ($1, 'SIDEWAYS', now(), 0.5, 0)`,
      [world.worldId]
    )).rejects.toThrow();
  });
});
