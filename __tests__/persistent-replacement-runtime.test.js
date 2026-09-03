// Persistent-market Stage 9 S9-03: real-DB integration coverage for
// permanent death -> delayed authored replacement -> replacement death.
//
// jest.setup.js reseeds the disposable test DB before each test. These tests
// deliberately drive the real persistent market writer so a replacement id
// outside the legacy GAMEPLAY_ROSTER proves it can survive normal runtime
// pricing using its persisted authored archetype/checkpoint.

const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const persistentWorld = require('../game/persistentWorld');
const replacementPool = require('../game/replacementPool');
const replacementRuntime = require('../game/persistentReplacementRuntime');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const marketDomain = require('../game/marketDomain');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const WORLD_SEED = 'stage9-replacement-runtime-world';
const EPOCH_MS = new Date('2026-08-31T00:00:00.000Z').getTime();
const FIRST_BATCH_MS = EPOCH_MS + 10 * 60 * 1000;
const FIRST_DEATH_MS = FIRST_BATCH_MS + 30 * 1000;
const DELAY_MS = replacementPool.DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs;

async function provision() {
  return persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
    epochStartedAt: new Date(EPOCH_MS)
  });
}

async function forceWriterDeath(coinId, nowMs) {
  const spy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore')
    .mockImplementation((opts) => Number(opts.coinId) === Number(coinId) ? 9.5 : 0.5);
  await marketSimulator.updateAllPrices({ nowMs });
  spy.mockRestore();
  const { rows } = await db.query(
    'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1',
    [coinId]
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('DEAD');
  expect(new Date(rows[0].died_at).getTime()).toBe(nowMs);
  expect(parseFloat((await db.query(
    'SELECT current_price FROM coins WHERE coin_id = $1',
    [coinId]
  )).rows[0].current_price)).toBe(0);
}

describe('Stage 9 S9-03: persistent replacement runtime', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provision();
    const healthySpy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore')
      .mockReturnValue(0.5);
    await marketSimulator.updateAllPrices({ nowMs: FIRST_BATCH_MS });
    healthySpy.mockRestore();
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('does not fabricate replacements before any persistent state/death work exists', async () => {
    // The beforeEach has created state, but there are still no deaths. A
    // roster shortfall alone is never replacement authority.
    await db.query('UPDATE coins SET retired = TRUE WHERE coin_id = 10');
    const result = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: FIRST_BATCH_MS + DELAY_MS + 1
    });
    expect(result.inserted).toEqual([]);
    expect(result.eligibleDeaths).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id >= 101')).rows[0].n).toBe(0);
  });

  test('waits, inserts exactly once, survives writer runtime, and replaces a dead replacement without id reuse', async () => {
    await forceWriterDeath(1, FIRST_DEATH_MS);

    // Reconciliation immediately retires the DEAD catalogue identity, but
    // the configured six-hour delay is authoritative: no replacement yet.
    const beforeDelay = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: FIRST_DEATH_MS + DELAY_MS - 1
    });
    expect(beforeDelay.retiredCoinIds).toEqual([1]);
    expect(beforeDelay.inserted).toEqual([]);
    expect(beforeDelay.eligibleDeaths).toBe(0);
    expect((await db.query('SELECT retired FROM coins WHERE coin_id = 1')).rows[0].retired).toBe(true);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE retired = FALSE')).rows[0].n).toBe(9);

    // Exactly at eligibility the first authored identity enters and restores
    // the active roster to ten.
    const introducedAtMs = FIRST_DEATH_MS + DELAY_MS;
    const first = await replacementRuntime.reconcilePersistentReplacements({ nowMs: introducedAtMs });
    expect(first.inserted).toHaveLength(1);
    expect(first.inserted[0]).toMatchObject({ coinId: 101, symbol: 'PLD', archetype: 'ZIP' });
    expect(first.activeBefore).toBe(9);
    expect(first.activeAfter).toBe(10);

    const { rows: replacementCoin } = await db.query(
      `SELECT coin_id, name, symbol, current_price, cycle_baseline_price,
              retired, date_added
         FROM coins WHERE coin_id = 101`
    );
    expect(replacementCoin).toHaveLength(1);
    expect(replacementCoin[0].symbol).toBe('PLD');
    expect(parseFloat(replacementCoin[0].current_price)).toBe(0.12);
    expect(parseFloat(replacementCoin[0].cycle_baseline_price)).toBe(0.12);
    expect(replacementCoin[0].retired).toBe(false);
    expect(new Date(replacementCoin[0].date_added).getTime()).toBe(introducedAtMs);

    const { rows: replacementState } = await db.query(
      `SELECT archetype, condition, structural_reference, peak_reference,
              status, died_at
         FROM market_coin_state WHERE coin_id = 101`
    );
    expect(replacementState).toHaveLength(1);
    // Legacy unknown-id resolution would be MOON. Persisted authored state
    // must win instead; S9-03 never adds replacement ids to that old map.
    expect(marketDomain.resolveArchetypeId(101)).toBe('MOON');
    expect(replacementState[0].archetype).toBe('ZIP');
    expect(replacementState[0].status).toBe('ALIVE');
    expect(replacementState[0].died_at).toBeNull();

    const checkpoint = await db.query(
      `SELECT checkpoint_ms, seed, activation_context
         FROM market_price_checkpoints
        WHERE coin_id = 101 AND seed = $1`,
      [WORLD_SEED]
    );
    expect(checkpoint.rows).toHaveLength(1);
    expect(Number(checkpoint.rows[0].checkpoint_ms)).toBe(introducedAtMs);
    expect(checkpoint.rows[0].activation_context).toBe('PERSISTENT');

    const introTicks = await db.query(
      `SELECT price, cycle_id, source, created_at
         FROM price_history
        WHERE coin_id = 101
        ORDER BY created_at`
    );
    expect(introTicks.rows).toHaveLength(1);
    expect(parseFloat(introTicks.rows[0].price)).toBe(0.12);
    expect(introTicks.rows[0].cycle_id).toBeNull();
    expect(introTicks.rows[0].source).toBe('MARKET_TICK');

    // Exact runtime replay derives zero outstanding work: no second coin,
    // no duplicate intro history, active roster remains ten.
    const replay = await replacementRuntime.reconcilePersistentReplacements({ nowMs: introducedAtMs });
    expect(replay.inserted).toEqual([]);
    expect(replay.pendingEligibleDeaths).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id = 101')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = 101')).rows[0].n).toBe(1);

    // Critical integration proof: the ordinary persistent writer can price
    // and kill replacement 101 even though it is absent from GAMEPLAY_ROSTER.
    // Its explicit persisted ZIP archetype + introduction checkpoint are the
    // authority; there is no silent MOON fallback and no missing-roster abort.
    const replacementDeathMs = introducedAtMs + 30 * 1000;
    await forceWriterDeath(101, replacementDeathMs);

    const afterReplacementDeath = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: replacementDeathMs + DELAY_MS - 1
    });
    expect(afterReplacementDeath.inserted).toEqual([]);
    expect((await db.query('SELECT retired FROM coins WHERE coin_id = 101')).rows[0].retired).toBe(true);

    const second = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: replacementDeathMs + DELAY_MS
    });
    expect(second.inserted).toHaveLength(1);
    expect(second.inserted[0]).toMatchObject({ coinId: 102, symbol: 'NFR', archetype: 'ZIP' });
    expect(second.activeAfter).toBe(10);

    const ids = (await db.query('SELECT coin_id FROM coins ORDER BY coin_id')).rows.map((r) => Number(r.coin_id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([1, 101, 102]));

    // Original/dead identities and their history still exist; replacement
    // means new identity, never overwrite/reuse.
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id = 1')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM market_coin_state WHERE coin_id = 1 AND status = \'DEAD\'')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = 1')).rows[0].n).toBeGreaterThan(0);
  });
});
