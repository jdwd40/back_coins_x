// Persistent-market Stage 1: pricing checkpoints against the REAL disposable
// test database — migration 023, the exact Node -> PostgreSQL -> Node double
// round-trip, the store's load/upsert contract, and DB-resumed bit-identity.
// (The Stage 1 live-writer threading coverage moved with the writer's Stage 4
// persistent contract: see __tests__/market-persistent-writer.test.js.)
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const marketDomain = require('../game/marketDomain');
const priceEngine = require('../game/priceEngine');
const pricingCheckpoint = require('../game/pricingCheckpoint');
const pricingCheckpointModel = require('../models/pricingCheckpoint.model');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const MIGRATION_023 = '023_create_market_price_checkpoints.sql';
const SEED = 'stage1-db-checkpoint-seed';
const ROUND_START_MS = 0;

const BASELINE_BY_COIN = new Map([
  [1, 0.10], [2, 1.37], [3, 0.12], [4, 0.10], [5, 96.45],
  [6, 43.46], [7, 3.91], [8, 33.48], [9, 0.10], [10, 32.00]
]);

function originPrice({ coinId, nowMs, lifecycleState = 'GROWTH' }) {
  return priceEngine.unifiedPriceAt({
    seed: SEED,
    coinId,
    baselinePrice: BASELINE_BY_COIN.get(coinId),
    roundStartMs: ROUND_START_MS,
    nowMs,
    amplitude: 1,
    lifecycleState,
    cycleProgress: 0
  });
}

describe('Stage 1: tracked production migration 023', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 023 to an existing database, preserving all pre-existing schema and data', async () => {
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'mig023-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');

    await db.query('DROP TABLE IF EXISTS market_price_checkpoints CASCADE');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_023]);
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_023);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(usersBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM coins')).rows[0].n).toBe(coinsBefore.rows[0].n);
    expect((await db.query('SELECT count(*)::int AS n FROM market_price_checkpoints')).rows[0].n).toBe(0);
  });

  test('re-running the migration on an already-migrated database is a tracked no-op', async () => {
    const result = await runMigrations({ log: () => {} });
    expect(result.applied).not.toContain(MIGRATION_023);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('structurally impossible accumulator state is unwritable (CHECK constraints)', async () => {
    const base = {
      coin_id: 1, seed: SEED, checkpoint_ms: 1000,
      domain_cycle_index: 3, domain_cycle_start_ms: 900,
      domain_anchor: 1.01, domain_boundary: 0.99,
      crash_episode_index: 4, crash_cursor_ms: 950, crash_factor: 0.98,
      activation_context: 'GROWTH'
    };
    const insert = (overrides) => db.query(
      `INSERT INTO market_price_checkpoints (
         coin_id, seed, checkpoint_ms, domain_cycle_index, domain_cycle_start_ms,
         domain_anchor, domain_boundary, crash_episode_index, crash_cursor_ms,
         crash_factor, activation_context
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        overrides.coin_id, overrides.seed, overrides.checkpoint_ms,
        overrides.domain_cycle_index, overrides.domain_cycle_start_ms,
        overrides.domain_anchor, overrides.domain_boundary,
        overrides.crash_episode_index, overrides.crash_cursor_ms,
        overrides.crash_factor, overrides.activation_context
      ]
    );
    await expect(insert({ ...base, domain_anchor: 0 })).rejects.toThrow();
    await expect(insert({ ...base, domain_anchor: -1 })).rejects.toThrow();
    await expect(insert({ ...base, domain_boundary: -0.5 })).rejects.toThrow();
    await expect(insert({ ...base, domain_cycle_index: -1 })).rejects.toThrow();
    await expect(insert({ ...base, crash_episode_index: 0 })).rejects.toThrow();
    await expect(insert({ ...base, crash_factor: 0 })).rejects.toThrow();
    await expect(insert({ ...base, crash_factor: -2 })).rejects.toThrow();
    await expect(insert({ ...base, checkpoint_ms: -5 })).rejects.toThrow();
    await expect(insert({ ...base, coin_id: 9999 })).rejects.toThrow(); // FK to coins
    await insert(base); // the valid row lands
    expect((await db.query('SELECT count(*)::int AS n FROM market_price_checkpoints')).rows[0].n).toBe(1);
  });
});

describe('Stage 1: exact Node -> PostgreSQL -> Node precision round-trip', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('float8 accumulator columns round-trip IEEE 754 doubles bit-identically', async () => {
    const nastyDoubles = [
      0.1 + 0.2,            // 0.30000000000000004
      1 / 3,
      Math.PI,
      Number.EPSILON,
      1 - Number.EPSILON,
      0.9999999999999999,
      1.7976931348623157e308, // Number.MAX_VALUE
      5e-324,                 // Number.MIN_VALUE (subnormal)
      123456789.12345679,
      0.0001
    ];
    for (const value of nastyDoubles) {
      const { rows } = await db.query('SELECT $1::float8 AS v', [value]);
      expect(Object.is(rows[0].v, value)).toBe(true);
    }
  });

  test('bigint millisecond positions round-trip exactly', async () => {
    const values = [0, 1, 1756653600000, 9007199254740991]; // up to 2^53-1
    for (const value of values) {
      const { rows } = await db.query('SELECT $1::bigint AS v', [value]);
      expect(Number(rows[0].v)).toBe(value);
    }
  });

  test('a stored checkpoint row round-trips bit-identically through the model', async () => {
    const stored = pricingCheckpoint.extractPricingCheckpoint({
      seed: SEED, coinId: 5, roundStartMs: ROUND_START_MS,
      nowMs: 13 * 60 * 1000 + 777, lifecycleState: 'DECLINE'
    });
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await pricingCheckpointModel.upsertCheckpoint(client, stored);
      const loaded = (await pricingCheckpointModel.loadCheckpoints(client, SEED)).get(5);
      await client.query('COMMIT');
      expect(loaded.coinId).toBe(stored.coinId);
      expect(loaded.seed).toBe(stored.seed);
      expect(loaded.checkpointMs).toBe(stored.checkpointMs);
      expect(loaded.domainCycleIndex).toBe(stored.domainCycleIndex);
      expect(loaded.domainCycleStartMs).toBe(stored.domainCycleStartMs);
      expect(Object.is(loaded.domainAnchor, stored.domainAnchor)).toBe(true);
      expect(Object.is(loaded.domainBoundary, stored.domainBoundary)).toBe(true);
      expect(loaded.crashEpisodeIndex).toBe(stored.crashEpisodeIndex);
      expect(loaded.crashCursorMs).toBe(stored.crashCursorMs);
      expect(Object.is(loaded.crashFactor, stored.crashFactor)).toBe(true);
      expect(loaded.activationContext).toBe(stored.activationContext);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  });

  test('upsert is idempotent and tracks the latest instant (PK conflict update)', async () => {
    const first = pricingCheckpoint.extractPricingCheckpoint({
      seed: SEED, coinId: 1, roundStartMs: ROUND_START_MS, nowMs: 5 * 60 * 1000, lifecycleState: 'GROWTH'
    });
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await pricingCheckpointModel.upsertCheckpoint(client, first);
      await pricingCheckpointModel.upsertCheckpoint(client, first); // replay: same values
      const second = pricingCheckpoint.extractPricingCheckpoint({
        seed: SEED, coinId: 1, roundStartMs: ROUND_START_MS, nowMs: 5 * 60 * 1000 + 30 * 1000,
        lifecycleState: 'GROWTH', stored: first
      });
      await pricingCheckpointModel.upsertCheckpoint(client, second);
      const loaded = (await pricingCheckpointModel.loadCheckpoints(client, SEED)).get(1);
      await client.query('COMMIT');
      expect(loaded.checkpointMs).toBe(second.checkpointMs);
      expect(Object.is(loaded.domainAnchor, second.domainAnchor)).toBe(true);
      expect((await db.query('SELECT count(*)::int AS n FROM market_price_checkpoints WHERE seed = $1', [SEED])).rows[0].n).toBe(1);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  });

  test('a DB-loaded checkpoint resumes bit-identically to the origin engine', async () => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const checkpointAtMs = 10 * 60 * 1000;
      for (const coinId of [1, 3, 5, 9]) {
        const stored = pricingCheckpoint.extractPricingCheckpoint({
          seed: SEED, coinId, roundStartMs: ROUND_START_MS, nowMs: checkpointAtMs, lifecycleState: 'PLATEAU'
        });
        await pricingCheckpointModel.upsertCheckpoint(client, stored);
      }
      const loadedByCoin = await pricingCheckpointModel.loadCheckpoints(client, SEED);
      await client.query('COMMIT');

      for (const coinId of [1, 3, 5, 9]) {
        const stored = loadedByCoin.get(coinId);
        for (const tMs of [checkpointAtMs, checkpointAtMs + 3000, checkpointAtMs + 120 * 1000]) {
          const resume = pricingCheckpoint.resolveResumeCheckpoints({
            stored, seed: SEED, coinId, nowMs: tMs, lifecycleState: 'PLATEAU'
          });
          const resumed = priceEngine.unifiedPriceAt({
            seed: SEED, coinId, baselinePrice: BASELINE_BY_COIN.get(coinId),
            roundStartMs: ROUND_START_MS, nowMs: tMs, amplitude: 1,
            lifecycleState: 'PLATEAU', cycleProgress: 0,
            domainCheckpoint: resume.domainCheckpoint,
            crashCheckpoint: resume.crashCheckpoint
          });
          const origin = originPrice({ coinId, nowMs: tMs, lifecycleState: 'PLATEAU' });
          expect(Object.is(resumed, origin)).toBe(true);
        }
      }
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  });
});
