// Persistent-market Stage 2: explicit world identity + per-coin persistent
// market state against the REAL disposable test database — migration 024,
// the single-active-world invariant, world provisioning idempotency/
// identity conflict, per-coin state validation (missing archetype fails
// loudly, never defaults), and the explicit permanent death transition.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const persistentWorld = require('../game/persistentWorld');
const coinStateModel = require('../models/marketCoinState.model');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

const MIGRATION_024 = '024_create_persistent_world.sql';
const MIGRATION_025 = '025_create_market_director_state.sql';
const MIGRATION_026 = '026_create_persistent_economy.sql';
const MIGRATION_027 = '027_create_persistent_bot_debt.sql';
const MIGRATION_028 = '028_create_persistent_bot_ticks.sql';
const WORLD_SEED = 'stage2-world-seed';

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date('2026-08-31T00:00:00Z') });
}

function aliveState(overrides = {}) {
  return {
    coinId: 1,
    worldId: 1,
    archetype: 'ZIP',
    condition: 0.25,
    structuralReference: 0.10,
    peakReference: 0.11,
    status: 'ALIVE',
    diedAt: null,
    ...overrides
  };
}

describe('Stage 2: tracked production migration 024', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} });
  });

  test('applies 024 to an existing database, preserving all pre-existing schema and data', async () => {
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    // Simulate re-applying 024 to an existing database. Dropping
    // market_worlds CASCADE drops the DEPENDENT CONSTRAINTS that reference
    // it — 025's market_director_state FK and 026's persistent_* world
    // FKs — but leaves those tables standing FK-less. Replaying 025/026
    // alone would then hit their "already exists with expected shape"
    // no-op paths and never restore the FKs. The honest fixture therefore
    // removes the whole dependent subtree explicitly (024 + 025 + 026
    // tables), removes ALL THREE ledger records (the ledger must reflect
    // physical reality), and replays the migrations in order so the full
    // schema — every dependent FK included — is restored before the full
    // verifier assertion. The verifier and every FK stay intact; only the
    // fixture changes. (Any future world-dependent migration must extend
    // this replay chain.)
    await db.query('DROP TABLE IF EXISTS persistent_bot_ticks CASCADE');
    await db.query('DROP TABLE IF EXISTS persistent_loans CASCADE');
    await db.query('DROP TABLE IF EXISTS persistent_transactions CASCADE');
    await db.query('DROP TABLE IF EXISTS persistent_holdings CASCADE');
    await db.query('DROP TABLE IF EXISTS persistent_accounts CASCADE');
    await db.query('DROP TABLE IF EXISTS market_director_state CASCADE');
    await db.query('DROP TABLE IF EXISTS market_coin_state CASCADE');
    await db.query('DROP TABLE IF EXISTS market_worlds CASCADE');
    await db.query('DELETE FROM schema_migrations WHERE migration = ANY($1)', [[MIGRATION_024, MIGRATION_025, MIGRATION_026, MIGRATION_027, MIGRATION_028]]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_024);
    expect(result.applied).toContain(MIGRATION_025);
    expect(result.applied).toContain(MIGRATION_026);
    expect(result.applied).toContain(MIGRATION_027);
    expect(result.applied).toContain(MIGRATION_028);
    // The dependent Director + economy schema is restored by replay.
    expect((await db.query(`SELECT to_regclass('public.market_director_state') AS r`)).rows[0].r).not.toBeNull();
    expect((await db.query(`SELECT to_regclass('public.persistent_accounts') AS r`)).rows[0].r).not.toBeNull();

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    // Legacy Apocalypse tables remain present and untouched.
    const legacy = await db.query(`SELECT to_regclass('public.apocalypse_cycles') AS r`);
    expect(legacy.rows[0].r).not.toBeNull();
  });

  test('re-running the migration on an already-migrated database is a tracked no-op', async () => {
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).not.toContain(MIGRATION_024);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });
});

describe('Stage 2: persistent world identity', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('provisioning creates exactly one active world and is idempotent on replay', async () => {
    const first = await provisionedWorld();
    expect(first.version).toBe(persistentWorld.WORLD_VERSION);
    expect(first.seed).toBe(WORLD_SEED);
    expect(first.active).toBe(true);

    const replay = await provisionedWorld();
    expect(replay.worldId).toBe(first.worldId);
    expect((await db.query('SELECT count(*)::int AS n FROM market_worlds')).rows[0].n).toBe(1);

    const resolved = await persistentWorld.resolveActiveWorld(db);
    expect(resolved.worldId).toBe(first.worldId);
  });

  test('provisioning with a different seed while a world is active fails loudly (identity is immutable)', async () => {
    await provisionedWorld();
    await expect(
      persistentWorld.provisionWorld(db, { seed: 'a-different-seed' })
    ).rejects.toThrow(/refusing to rotate world identity/);
  });

  test('resolving with no active world fails loudly (never fabricates one)', async () => {
    await expect(persistentWorld.resolveActiveWorld(db)).rejects.toThrow(/no active market world/);
  });

  test('at most one active world is writable (partial unique index)', async () => {
    await provisionedWorld();
    await expect(
      db.query(
        `INSERT INTO market_worlds (version, seed, epoch_started_at, active) VALUES (1, 'other', now(), true)`
      )
    ).rejects.toThrow();
    // An INACTIVE second world is legitimate history and does not conflict.
    await db.query(
      `INSERT INTO market_worlds (version, seed, epoch_started_at, active) VALUES (1, 'archived', now(), false)`
    );
    expect((await db.query('SELECT count(*)::int AS n FROM market_worlds')).rows[0].n).toBe(2);
    const resolved = await persistentWorld.resolveActiveWorld(db);
    expect(resolved.seed).toBe(WORLD_SEED);
  });

  test('a future-version world row fails validation loudly', () => {
    expect(() => persistentWorld.assertWorldRow({
      world_id: 1, version: persistentWorld.WORLD_VERSION + 1, seed: 'x', epoch_started_at: new Date(), active: true
    })).toThrow(/newer than this server understands/);
  });
});

describe('Stage 2: per-coin persistent market state', () => {
  let world;

  beforeEach(async () => {
    assertDisposableTestDatabase();
    world = await provisionedWorld();
  });

  function stateFor(overrides = {}) {
    return aliveState({ worldId: world.worldId, ...overrides });
  }

  test('upsert + load round-trips the exact state (float8 bit-exact)', async () => {
    const state = stateFor({ condition: 0.1 + 0.2, structuralReference: 1 / 3, peakReference: 0.09999999999999999 });
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await coinStateModel.upsertCoinState(client, state);
      const loaded = (await coinStateModel.loadCoinStates(client, world.worldId)).get(1);
      await client.query('COMMIT');
      expect(Object.is(loaded.condition, state.condition)).toBe(true);
      expect(Object.is(loaded.structuralReference, state.structuralReference)).toBe(true);
      expect(Object.is(loaded.peakReference, state.peakReference)).toBe(true);
      expect(loaded.archetype).toBe('ZIP');
      expect(loaded.status).toBe('ALIVE');
      expect(loaded.diedAt).toBeNull();
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  });

  test('a missing or unknown archetype fails validation loudly — never defaults', async () => {
    for (const bad of [undefined, null, '', 'MOONLIT', 'moon']) {
      await expect(coinStateModel.upsertCoinState(db, stateFor({ archetype: bad }))).rejects.toThrow(/never default silently/);
    }
    expect((await db.query('SELECT count(*)::int AS n FROM market_coin_state')).rows[0].n).toBe(0);
  });

  test('out-of-range condition / non-positive references fail validation and DB CHECKs', async () => {
    await expect(coinStateModel.upsertCoinState(db, stateFor({ condition: 1.5 }))).rejects.toThrow(/condition/);
    await expect(coinStateModel.upsertCoinState(db, stateFor({ condition: -1.5 }))).rejects.toThrow(/condition/);
    await expect(coinStateModel.upsertCoinState(db, stateFor({ structuralReference: 0 }))).rejects.toThrow(/structuralReference/);
    await expect(coinStateModel.upsertCoinState(db, stateFor({ peakReference: -2 }))).rejects.toThrow(/peakReference/);
    // The DB CHECKs backstop direct SQL writes too.
    await expect(db.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference)
       VALUES (2, $1, 'MOON', 2, 1, 1)`, [world.worldId]
    )).rejects.toThrow();
    await expect(db.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference)
       VALUES (2, $1, 'MOON', 0, 0, 1)`, [world.worldId]
    )).rejects.toThrow();
  });

  test('death is explicit, permanent, timestamped and replay-idempotent', async () => {
    await coinStateModel.upsertCoinState(db, stateFor());
    const diedAt = new Date('2026-09-15T12:00:00Z');

    const first = await coinStateModel.recordDeath(db, { coinId: 1, worldId: world.worldId, diedAt });
    expect(first).toEqual({ died: true, alreadyDead: false });

    const replay = await coinStateModel.recordDeath(db, { coinId: 1, worldId: world.worldId, diedAt });
    expect(replay).toEqual({ died: false, alreadyDead: true });

    await expect(
      coinStateModel.recordDeath(db, { coinId: 1, worldId: world.worldId, diedAt: new Date('2026-09-16T12:00:00Z') })
    ).rejects.toThrow(/death is permanent and cannot move/);

    const { rows } = await db.query('SELECT status, died_at FROM market_coin_state WHERE coin_id = 1');
    expect(rows[0].status).toBe('DEAD');
    expect(new Date(rows[0].died_at).getTime()).toBe(diedAt.getTime());
  });

  test('death consistency is enforced structurally (CHECK constraint)', async () => {
    await expect(db.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference, status, died_at)
       VALUES (3, $1, 'RUG', 0, 1, 1, 'DEAD', NULL)`, [world.worldId]
    )).rejects.toThrow();
    await expect(db.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference, status, died_at)
       VALUES (3, $1, 'RUG', 0, 1, 1, 'ALIVE', now())`, [world.worldId]
    )).rejects.toThrow();
  });

  test('upsert of live fields never touches a recorded death', async () => {
    await coinStateModel.upsertCoinState(db, stateFor());
    const diedAt = new Date('2026-09-15T12:00:00Z');
    await coinStateModel.recordDeath(db, { coinId: 1, worldId: world.worldId, diedAt });

    // A state rewrite (e.g. a restart refreshing accumulators) updates only
    // the live fields: the UPDATE path never writes status/died_at, so the
    // recorded death is preserved exactly.
    await coinStateModel.upsertCoinState(db, stateFor({ condition: -0.5, status: 'DEAD', diedAt }));

    const { rows } = await db.query('SELECT status, died_at, condition FROM market_coin_state WHERE coin_id = 1');
    expect(rows[0].status).toBe('DEAD');
    expect(new Date(rows[0].died_at).getTime()).toBe(diedAt.getTime());
    expect(rows[0].condition).toBe(-0.5); // live fields did update
  });
});
