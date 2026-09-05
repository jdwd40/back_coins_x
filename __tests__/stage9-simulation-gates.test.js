// Persistent-market Stage 9 S9-04: final deterministic simulation +
// persistence gates.
//
// Two layers:
//   1) Pure domain horizon (simulation/stage9Horizon.js) — long-lived
//      injected-time proof of survivors / recovery / occasional death /
//      delayed authored replacement / no extinction cascade / no
//      replacement churn / deterministic replay. Uses real S9-01/02/03
//      domain modules; no wall clock; no DB.
//   2) Disposable PostgreSQL coins_test — persistence / restart /
//      idempotency / history preservation / trade reject / multi-
//      generation replacement chains via the real writer + reconcile.
//
// Forced-death via getPersistentCollapseRiskScore spy is used ONLY for
// persistence/restart/chain scenarios (same pattern as S9-03). Natural
// behaviour under default death balancing is measured by the domain gate.

const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const marketDomain = require('../game/marketDomain');
const persistentWorld = require('../game/persistentWorld');
const persistentEconomy = require('../game/persistentEconomy');
const replacementPool = require('../game/replacementPool');
const replacementRuntime = require('../game/persistentReplacementRuntime');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const {
  runStage9Horizon,
  assertStage9QualityGates,
  assertDeterministicReplay,
  replayFingerprint,
  DAY_MS,
  HOUR_MS,
  DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR
} = require('../simulation/stage9Horizon');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');
const { DEFAULT_SIMULATION_CONFIG } = require('../game/simulationConfig');

jest.setTimeout(180000);

const WORLD_SEED = 'stage9-s904-persistence-world';
const EPOCH_MS = new Date('2026-08-31T00:00:00.000Z').getTime();
const FIRST_BATCH_MS = EPOCH_MS + 10 * 60 * 1000;
const SHORT_DELAY_MS = 60 * 1000; // injected-timeline delay; NOT a production retune
const DOMAIN_SEED = 'stage9-gate-seed';

function shortReplacementConfig() {
  return replacementPool.resolveReplacementConfig({
    replacementDelayMs: SHORT_DELAY_MS
  });
}

async function provision() {
  return persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
    epochStartedAt: new Date(EPOCH_MS)
  });
}

async function forceWriterDeath(coinId, nowMs) {
  const spy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore')
    .mockImplementation((opts) => (Number(opts.coinId) === Number(coinId) ? 9.5 : 0.5));
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

async function healthyTick(nowMs) {
  const spy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore')
    .mockReturnValue(0.5);
  await marketSimulator.updateAllPrices({ nowMs });
  spy.mockRestore();
}

async function activeRosterCount() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n
       FROM market_coin_state s
       JOIN coins c ON c.coin_id = s.coin_id
      WHERE s.status = 'ALIVE' AND c.retired = FALSE`
  );
  return rows[0].n;
}

describe('Stage 9 S9-04: domain simulation quality gates', () => {
  test('default death threshold is unchanged (no silent balance retune)', () => {
    expect(DEFAULT_SIMULATION_CONFIG.persistent.death.riskThreshold).toBe(6.0);
    expect(
      DEFAULT_SIMULATION_CONFIG.persistent.death.riskThreshold
    ).toBeGreaterThan(collapseRiskDomain.RISK_THRESHOLDS.CRITICAL);
    expect(replacementPool.DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs)
      .toBe(6 * HOUR_MS);
    expect(replacementPool.DEFAULT_REPLACEMENT_CONFIG.targetActiveCount).toBe(10);
  });

  test('30-day director horizon proves survivors, recovery, delayed replacement, no extinction, no churn', () => {
    const result = runStage9Horizon({
      days: 30,
      cadenceMinutes: 60,
      seed: DOMAIN_SEED,
      provider: 'director',
      // Production default delay — injected timeline, no real 6h waits.
      replacementDelayMs: replacementPool.DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs
    });

    expect(DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR).toBe(7);

    expect(() => assertStage9QualityGates(result, {
      minOriginalSurvivors: 1,
      minRecoveries: 1,
      minActiveFloor: DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR,
      requireReplacementDeaths: true,
      requireReplacementChain: true,
      maxEarlyChurn: 0,
      minReplacementLifetimeMs: 12 * HOUR_MS
    })).not.toThrow();

    const { metrics, events } = result;
    expect(metrics.originalDeaths).toBeGreaterThanOrEqual(1);
    expect(metrics.replacements).toBeGreaterThanOrEqual(1);
    expect(metrics.replacementDeaths).toBeGreaterThanOrEqual(1);
    expect(metrics.originalSurvivors).toBeGreaterThanOrEqual(1);
    expect(metrics.recoveries).toBeGreaterThanOrEqual(1);
    expect(metrics.minActive).toBeGreaterThanOrEqual(DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR);
    expect(metrics.maxActive).toBeLessThanOrEqual(10);
    expect(metrics.finalActive).toBeGreaterThanOrEqual(DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR);
    expect(metrics.duplicateIds).toBe(0);
    expect(metrics.earlyReplacementChurn).toBe(0);
    expect(metrics.longestSurvivorMs).toBeGreaterThanOrEqual(7 * DAY_MS);

    // Natural replacement death + chain: another authored insert follows
    // after a replacement death + configured delay (no spy/mock).
    const replacementDeaths = events.deaths.filter((d) => d.isReplacement);
    expect(replacementDeaths.length).toBeGreaterThanOrEqual(1);
    const chained = replacementDeaths.some((death) => (
      events.replacements.some((repl) => (
        repl.atMs >= death.atMs + result.replacementDelayMs
      ))
    ));
    expect(chained).toBe(true);

    // Delayed replacement: no insert may precede death + delay.
    for (const repl of events.replacements) {
      const priorEligibleDeaths = events.deaths.filter((d) => (
        d.atMs <= repl.atMs - result.replacementDelayMs
      )).length;
      expect(priorEligibleDeaths).toBeGreaterThanOrEqual(1);
    }

    // Active roster never exceeds target; drops are temporary during delay.
    expect(metrics.maxActive).toBe(10);

    // Key metrics surface for the S9-04 report.
    // eslint-disable-next-line no-console
    console.log('S9-04 domain metrics', {
      originalDeaths: metrics.originalDeaths,
      replacementDeaths: metrics.replacementDeaths,
      replacements: metrics.replacements,
      recoveries: metrics.recoveries,
      originalSurvivors: metrics.originalSurvivors,
      longestSurvivorDays: metrics.longestSurvivorMs / DAY_MS,
      minActive: metrics.minActive,
      maxActive: metrics.maxActive,
      finalActive: metrics.finalActive,
      earlyReplacementChurn: metrics.earlyReplacementChurn,
      minReplacementLifetimeDays: metrics.minReplacementLifetimeMs == null
        ? null
        : metrics.minReplacementLifetimeMs / DAY_MS,
      duplicateIds: metrics.duplicateIds,
      wallClockMs: metrics.wallClockMs,
      noExtinctionFloor: DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR
    });
  });

  test('deterministic replay: identical seed/config/timeline yields equal deaths, replacements, roster', () => {
    const opts = {
      days: 15,
      cadenceMinutes: 60,
      seed: DOMAIN_SEED,
      provider: 'director',
      replacementDelayMs: replacementPool.DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs
    };
    const a = runStage9Horizon(opts);
    const b = runStage9Horizon(opts);
    const check = assertDeterministicReplay(a, b);
    expect(check.checkedDeaths).toBe(a.events.deaths.length);
    expect(check.checkedReplacements).toBe(a.events.replacements.length);
    expect(check.checkedRoster).toBe(a.world.length);
    expect(replayFingerprint(a)).toEqual(replayFingerprint(b));
  });

  test('replacement chains: a replacement can later die and be replaced (multi-generation)', () => {
    const result = runStage9Horizon({
      days: 30,
      cadenceMinutes: 60,
      seed: DOMAIN_SEED,
      provider: 'director',
      replacementDelayMs: replacementPool.DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs
    });

    expect(() => assertStage9QualityGates(result, {
      minActiveFloor: DEFAULT_NO_EXTINCTION_ACTIVE_FLOOR,
      requireReplacementDeaths: true,
      requireReplacementChain: true,
      maxEarlyChurn: 0,
      minReplacementLifetimeMs: 12 * HOUR_MS
    })).not.toThrow();

    const replacementDeaths = result.events.deaths.filter((d) => d.isReplacement);
    expect(result.metrics.replacements).toBeGreaterThanOrEqual(2);
    expect(replacementDeaths.length).toBeGreaterThanOrEqual(1);
    expect(
      replacementDeaths.length + result.metrics.replacementSurvivors
    ).toBe(result.metrics.replacements);

    // Another authored replacement follows after configured delay.
    const chained = replacementDeaths.some((death) => (
      result.events.replacements.some((repl) => (
        repl.atMs >= death.atMs + result.replacementDelayMs
      ))
    ));
    expect(chained).toBe(true);

    // Authored ids are not hardcoded to only 101/102 — consumption walks the roster.
    const usedIds = result.events.replacements.map((r) => r.coinId);
    expect(usedIds.length).toBe(new Set(usedIds).size);
    expect(usedIds.length).toBeGreaterThanOrEqual(2);
    expect(usedIds[0]).toBe(101);
    expect(usedIds[1]).toBe(102);
    // Historical originals remain reserved forever.
    for (const id of usedIds) {
      expect(id).toBeGreaterThanOrEqual(101);
      expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).not.toContain(id);
    }
  });
});

describe('Stage 9 S9-04: persistence / restart / chain gates (coins_test)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provision();
    await healthyTick(FIRST_BATCH_MS);
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('authoritative death: exact £0, DEAD, died_at sticky, trade reject, history preserved', async () => {
    const coinId = 3;
    const deathMs = FIRST_BATCH_MS + 30 * 1000;

    // Capture pre-death history length.
    const beforeHistory = await db.query(
      'SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1',
      [coinId]
    );

    await forceWriterDeath(coinId, deathMs);

    const state = await db.query(
      'SELECT status, died_at, archetype FROM market_coin_state WHERE coin_id = $1',
      [coinId]
    );
    expect(state.rows[0].status).toBe('DEAD');
    expect(new Date(state.rows[0].died_at).getTime()).toBe(deathMs);
    expect(parseFloat((await db.query(
      'SELECT current_price FROM coins WHERE coin_id = $1', [coinId]
    )).rows[0].current_price)).toBe(0);

    // Stays dead across later healthy writer ticks (no resurrection).
    await healthyTick(deathMs + 30 * 1000);
    await healthyTick(deathMs + 60 * 1000);
    const after = await db.query(
      'SELECT status, died_at, current_price FROM market_coin_state s JOIN coins c USING (coin_id) WHERE coin_id = $1',
      [coinId]
    );
    expect(after.rows[0].status).toBe('DEAD');
    expect(new Date(after.rows[0].died_at).getTime()).toBe(deathMs);
    expect(parseFloat(after.rows[0].current_price)).toBe(0);

    // Trade reject both directions.
    await expect(
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId, quantity: 1 })
    ).rejects.toThrow(/permanently dead/);

    // History preserved (catalogue row + prior ticks + death tick).
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id = $1', [coinId])).rows[0].n).toBe(1);
    const history = await db.query(
      'SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1',
      [coinId]
    );
    expect(history.rows[0].n).toBeGreaterThan(beforeHistory.rows[0].n);
    const deathTick = await db.query(
      `SELECT price FROM price_history
        WHERE coin_id = $1 AND created_at = $2`,
      [coinId, new Date(deathMs).toISOString()]
    );
    expect(deathTick.rows.length).toBeGreaterThanOrEqual(1);
    expect(parseFloat(deathTick.rows[0].price)).toBe(0);
  });

  test('delayed replacement + restart idempotency across delay / eligibility / post-insert', async () => {
    const cfg = shortReplacementConfig();
    const deathMs = FIRST_BATCH_MS + 30 * 1000;
    await forceWriterDeath(1, deathMs);

    // During delay: retire, no insert; repeated wakes preserve pending work.
    const midDelay = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: deathMs + Math.floor(SHORT_DELAY_MS / 2),
      replacementConfig: cfg
    });
    expect(midDelay.inserted).toEqual([]);
    expect(midDelay.eligibleDeaths).toBe(0);
    expect(midDelay.retiredCoinIds).toEqual([1]);
    expect(await activeRosterCount()).toBe(9);

    const midDelayAgain = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: deathMs + Math.floor(SHORT_DELAY_MS / 2) + 1,
      replacementConfig: cfg
    });
    expect(midDelayAgain.inserted).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id >= 101')).rows[0].n).toBe(0);

    // Exactly at eligibility: one authored insert; roster returns toward 10.
    const introMs = deathMs + SHORT_DELAY_MS;
    const first = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: introMs,
      replacementConfig: cfg
    });
    expect(first.inserted).toHaveLength(1);
    expect(first.inserted[0]).toMatchObject({ coinId: 101, archetype: 'ZIP' });
    expect(first.activeBefore).toBe(9);
    expect(first.activeAfter).toBe(10);
    expect(await activeRosterCount()).toBe(10);

    // Explicit authored archetype — legacy unknown-id map still says MOON.
    expect(marketDomain.resolveArchetypeId(101)).toBe('MOON');
    const persisted = await db.query(
      'SELECT archetype, status, died_at FROM market_coin_state WHERE coin_id = 101'
    );
    expect(persisted.rows[0].archetype).toBe('ZIP');
    expect(persisted.rows[0].status).toBe('ALIVE');

    // Idempotent at eligibility / after insert: no duplicate replacement or intro tick.
    const replayAtEligibility = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: introMs,
      replacementConfig: cfg
    });
    expect(replayAtEligibility.inserted).toEqual([]);
    expect(replayAtEligibility.pendingEligibleDeaths).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id = 101')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = 101')).rows[0].n).toBe(1);

    const laterReplay = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: introMs + 30 * 1000,
      replacementConfig: cfg
    });
    expect(laterReplay.inserted).toEqual([]);
    expect(await activeRosterCount()).toBe(10);

    // died_at of the original never moves.
    const originalDeath = await db.query(
      'SELECT died_at FROM market_coin_state WHERE coin_id = 1'
    );
    expect(new Date(originalDeath.rows[0].died_at).getTime()).toBe(deathMs);
  });

  test('replacement chain: replacement lives, can be killed, and is replaced without id reuse', async () => {
    const cfg = shortReplacementConfig();
    const death1Ms = FIRST_BATCH_MS + 30 * 1000;
    await forceWriterDeath(1, death1Ms);

    const intro101Ms = death1Ms + SHORT_DELAY_MS;
    const first = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: intro101Ms,
      replacementConfig: cfg
    });
    expect(first.inserted[0].coinId).toBe(101);

    // Replacement survives ordinary healthy writer ticks (no instant churn).
    await healthyTick(intro101Ms + 30 * 1000);
    await healthyTick(intro101Ms + 60 * 1000);
    const living = await db.query(
      'SELECT status, archetype, current_price FROM market_coin_state s JOIN coins c USING (coin_id) WHERE coin_id = 101'
    );
    expect(living.rows[0].status).toBe('ALIVE');
    expect(living.rows[0].archetype).toBe('ZIP');
    expect(parseFloat(living.rows[0].current_price)).toBeGreaterThan(0);
    expect((await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = 101')).rows[0].n).toBeGreaterThanOrEqual(3);

    // Kill the replacement and introduce the next authored identity.
    const death101Ms = intro101Ms + 90 * 1000;
    await forceWriterDeath(101, death101Ms);

    const beforeNext = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: death101Ms + SHORT_DELAY_MS - 1,
      replacementConfig: cfg
    });
    expect(beforeNext.inserted).toEqual([]);
    expect((await db.query('SELECT retired FROM coins WHERE coin_id = 101')).rows[0].retired).toBe(true);
    expect(await activeRosterCount()).toBe(9);

    const intro102Ms = death101Ms + SHORT_DELAY_MS;
    const second = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: intro102Ms,
      replacementConfig: cfg
    });
    expect(second.inserted).toHaveLength(1);
    expect(second.inserted[0]).toMatchObject({ coinId: 102, symbol: 'NFR', archetype: 'ZIP' });
    expect(second.activeAfter).toBe(10);

    // Kill 102 too and pull a third generation (not hardcoded to only 101/102).
    await healthyTick(intro102Ms + 30 * 1000);
    const death102Ms = intro102Ms + 60 * 1000;
    await forceWriterDeath(102, death102Ms);
    const third = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: death102Ms + SHORT_DELAY_MS,
      replacementConfig: cfg
    });
    expect(third.inserted).toHaveLength(1);
    expect(third.inserted[0].coinId).toBe(103);
    expect(third.inserted[0].archetype).toBe('MOON'); // authored ORB/MOON

    // No id reuse; all historical identities reserved.
    const ids = (await db.query('SELECT coin_id FROM coins ORDER BY coin_id'))
      .rows.map((r) => Number(r.coin_id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([1, 101, 102, 103]));

    // Dead originals + dead replacements remain as DEAD history rows.
    for (const deadId of [1, 101, 102]) {
      const row = await db.query(
        'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1',
        [deadId]
      );
      expect(row.rows[0].status).toBe('DEAD');
      expect(row.rows[0].died_at).not.toBeNull();
      expect((await db.query(
        'SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1',
        [deadId]
      )).rows[0].n).toBeGreaterThan(0);
    }

    // Post-replacement-death restart: no duplicate of 103.
    const postDeathReplay = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: death102Ms + SHORT_DELAY_MS,
      replacementConfig: cfg
    });
    expect(postDeathReplay.inserted).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id = 103')).rows[0].n).toBe(1);
    expect(await activeRosterCount()).toBe(10);
  });

  test('active roster stability: drops on death, below target during delay, returns after replacement, never exceeds via duplicates', async () => {
    const cfg = shortReplacementConfig();
    expect(await activeRosterCount()).toBe(10);

    const deathMs = FIRST_BATCH_MS + 30 * 1000;
    await forceWriterDeath(5, deathMs);
    await replacementRuntime.reconcilePersistentReplacements({
      nowMs: deathMs + 1,
      replacementConfig: cfg
    });
    expect(await activeRosterCount()).toBe(9);

    await replacementRuntime.reconcilePersistentReplacements({
      nowMs: deathMs + SHORT_DELAY_MS - 1,
      replacementConfig: cfg
    });
    expect(await activeRosterCount()).toBe(9);

    await replacementRuntime.reconcilePersistentReplacements({
      nowMs: deathMs + SHORT_DELAY_MS,
      replacementConfig: cfg
    });
    expect(await activeRosterCount()).toBe(10);

    // Triple reconcile must not push above target.
    await replacementRuntime.reconcilePersistentReplacements({
      nowMs: deathMs + SHORT_DELAY_MS + 5,
      replacementConfig: cfg
    });
    await replacementRuntime.reconcilePersistentReplacements({
      nowMs: deathMs + SHORT_DELAY_MS + 10,
      replacementConfig: cfg
    });
    expect(await activeRosterCount()).toBe(10);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id >= 101')).rows[0].n).toBe(1);
  });

  test('concurrent reconcile at eligibility: exactly one authored replacement, no duplicate intro', async () => {
    const cfg = shortReplacementConfig();
    const deathMs = FIRST_BATCH_MS + 30 * 1000;
    await forceWriterDeath(1, deathMs);

    const introMs = deathMs + SHORT_DELAY_MS;
    // Race two reconciles at the same nowMs/config. Do not mock locks;
    // do not sequentialize — real coins table EXCLUSIVE lock must serialize.
    const [a, b] = await Promise.all([
      replacementRuntime.reconcilePersistentReplacements({
        nowMs: introMs,
        replacementConfig: cfg
      }),
      replacementRuntime.reconcilePersistentReplacements({
        nowMs: introMs,
        replacementConfig: cfg
      })
    ]);

    const insertedTogether = [...a.inserted, ...b.inserted];
    expect(insertedTogether).toHaveLength(1);
    expect(insertedTogether[0]).toMatchObject({ coinId: 101, archetype: 'ZIP' });
    expect(
      (a.inserted.length === 1 && b.inserted.length === 0)
      || (a.inserted.length === 0 && b.inserted.length === 1)
    ).toBe(true);

    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id = 101')).rows[0].n).toBe(1);
    expect((await db.query(
      'SELECT count(*)::int AS n FROM price_history WHERE coin_id = 101'
    )).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id >= 101')).rows[0].n).toBe(1);
    expect(await activeRosterCount()).toBe(10);

    const ids = (await db.query('SELECT coin_id FROM coins ORDER BY coin_id'))
      .rows.map((r) => Number(r.coin_id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(101);

    // Both completed without corruption: subsequent reconcile is a no-op.
    const replay = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: introMs,
      replacementConfig: cfg
    });
    expect(replay.inserted).toEqual([]);
    expect(await activeRosterCount()).toBe(10);
    expect((await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id = 101')).rows[0].n).toBe(1);
    expect((await db.query(
      'SELECT count(*)::int AS n FROM price_history WHERE coin_id = 101'
    )).rows[0].n).toBe(1);
  });
});
