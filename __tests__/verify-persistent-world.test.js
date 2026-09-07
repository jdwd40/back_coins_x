// Deploy gate: verify-persistent-world + first-time provision CLI.
const db = require('../db/connection');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');
const {
  countActiveWorlds,
  listActiveWorldSummaries,
  verifyPersistentWorld
} = require('../db/verify-persistent-world');
const {
  parseArgs,
  provisionPersistentWorldOnce
} = require('../db/provision-persistent-world');
const persistentWorld = require('../game/persistentWorld');

jest.setTimeout(30000);

const SEED = 'deploy-verify-persistent-world-seed';

describe('verify-persistent-world (read-only gate)', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('0 active worlds fails with provision:persistent-world diagnostic', async () => {
    const result = await verifyPersistentWorld({ queryable: db });
    expect(result.ok).toBe(false);
    expect(result.activeCount).toBe(0);
    expect(result.worlds).toEqual([]);
    expect(result.message).toMatch(/no active market world/i);
    expect(result.message).toMatch(/provision:persistent-world/);
    expect(await countActiveWorlds(db)).toBe(0);
  });

  test('1 active world passes', async () => {
    const world = await persistentWorld.provisionWorld(db, { seed: SEED });
    const result = await verifyPersistentWorld({ queryable: db });
    expect(result.ok).toBe(true);
    expect(result.activeCount).toBe(1);
    expect(result.worlds).toHaveLength(1);
    expect(result.worlds[0].worldId).toBe(world.worldId);
    expect(result.message).toMatch(/PASSED/);
    const summaries = await listActiveWorldSummaries(db);
    expect(summaries).toEqual(result.worlds);
  });

  test('>1 active worlds fails via injectable queryable mock (partial unique index blocks real inserts)', async () => {
    // Documented: market_worlds_single_active prevents >1 active rows in real PG.
    // Assert verifier logic with a mock queryable returning two active rows.
    const mockQueryable = {
      query: async (sql) => {
        if (/FROM market_worlds WHERE active/i.test(sql) && /count/i.test(sql)) {
          return { rows: [{ n: 2 }] };
        }
        return {
          rows: [
            { world_id: 1, version: 1, epoch_started_at: new Date('2026-01-01T00:00:00Z'), active: true },
            { world_id: 2, version: 1, epoch_started_at: new Date('2026-01-02T00:00:00Z'), active: true }
          ]
        };
      }
    };
    const result = await verifyPersistentWorld({ queryable: mockQueryable });
    expect(result.ok).toBe(false);
    expect(result.activeCount).toBe(2);
    expect(result.worlds).toHaveLength(2);
    expect(result.message).toMatch(/2 active market worlds/i);
    expect(result.message).toMatch(/single-active-world invariant/i);
  });

  test('verifier performs no writes (row snapshot unchanged)', async () => {
    await persistentWorld.provisionWorld(db, { seed: SEED });
    const beforeWorlds = await db.query(
      'SELECT world_id, version, seed, epoch_started_at, active, created_at FROM market_worlds ORDER BY world_id'
    );
    const beforeCount = await db.query('SELECT count(*)::int AS n FROM market_worlds');
    const xmaxBefore = await db.query(
      'SELECT world_id, xmax::text AS xmax FROM market_worlds ORDER BY world_id'
    );

    const result = await verifyPersistentWorld({ queryable: db });
    expect(result.ok).toBe(true);

    const afterWorlds = await db.query(
      'SELECT world_id, version, seed, epoch_started_at, active, created_at FROM market_worlds ORDER BY world_id'
    );
    const afterCount = await db.query('SELECT count(*)::int AS n FROM market_worlds');
    const xmaxAfter = await db.query(
      'SELECT world_id, xmax::text AS xmax FROM market_worlds ORDER BY world_id'
    );

    expect(afterCount.rows[0].n).toBe(beforeCount.rows[0].n);
    expect(afterWorlds.rows).toEqual(beforeWorlds.rows);
    expect(xmaxAfter.rows).toEqual(xmaxBefore.rows);
  });
});

describe('provision-persistent-world (first-time only)', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('parseArgs accepts --seed, --seed=, PERSISTENT_WORLD_SEED, and --help', () => {
    expect(parseArgs(['node', 'db/provision-persistent-world.js', '--seed', 'abc']).seed).toBe('abc');
    expect(parseArgs(['node', 'db/provision-persistent-world.js', '--seed=xyz']).seed).toBe('xyz');
    expect(parseArgs(['node', 'db/provision-persistent-world.js'], { PERSISTENT_WORLD_SEED: 'from-env' }).seed).toBe('from-env');
    expect(parseArgs(['node', 'db/provision-persistent-world.js', '--help']).help).toBe(true);
    expect(() => parseArgs(['node', 'db/provision-persistent-world.js', '--seed'])).toThrow(/--seed requires/);
  });

  test('provisionPersistentWorldOnce creates when none exist', async () => {
    const world = await provisionPersistentWorldOnce({ seed: SEED, queryable: db });
    expect(world.worldId).toBeGreaterThan(0);
    expect(world.seed).toBe(SEED);
    expect(world.active).toBe(true);
    expect(await countActiveWorlds(db)).toBe(1);
  });

  test('provisionPersistentWorldOnce refuses when an active world already exists', async () => {
    await provisionPersistentWorldOnce({ seed: SEED, queryable: db });
    await expect(
      provisionPersistentWorldOnce({ seed: SEED, queryable: db })
    ).rejects.toThrow(/refuse: active persistent world already exists/i);
    await expect(
      provisionPersistentWorldOnce({ seed: 'other-seed', queryable: db })
    ).rejects.toThrow(/first-time only/i);
    expect(await countActiveWorlds(db)).toBe(1);
  });
});
