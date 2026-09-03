// Persistent-market Stage 9 S9-01: authoritative living → DEAD decision.
//
// Proves death is a deliberate named transition after living pricing /
// condition advance when collapse risk crosses the configured threshold —
// never an implicit side effect of the living positive safety floor (§27).

const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const marketDomain = require('../game/marketDomain');
const persistentPricing = require('../game/persistentPricing');
const persistentWorld = require('../game/persistentWorld');
const persistentEconomy = require('../game/persistentEconomy');
const persistentCoinDeath = require('../game/persistentCoinDeath');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const { resolveSimulationConfig, DEFAULT_SIMULATION_CONFIG } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const WORLD_SEED = 'stage9-coin-death-world-seed';
const EPOCH_MS = new Date('2026-08-31T00:00:00.000Z').getTime();
const T1_MS = EPOCH_MS + 10 * 60 * 1000;
const T2_MS = T1_MS + 30 * 1000;
const T3_MS = T2_MS + 30 * 1000;

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
    epochStartedAt: new Date(EPOCH_MS)
  });
}

describe('Stage 9 S9-01: pure authoritative death decision', () => {
  test('death config threshold sits above the public CRITICAL band', () => {
    expect(DEFAULT_SIMULATION_CONFIG.persistent.death.riskThreshold).toBeGreaterThan(
      collapseRiskDomain.RISK_THRESHOLDS.CRITICAL
    );
  });

  test('threshold/risk conditions lead to an explicit death decision', () => {
    const decision = persistentCoinDeath.decideAuthoritativePersistentDeath({
      seed: 'death-unit',
      coinId: 3,
      archetypeId: 'RUG',
      condition: -1,
      phase: 'FALL',
      recentChangePct: -20,
      nowMs: T1_MS
    });
    expect(decision.shouldDie).toBe(true);
    expect(decision.riskScore).toBeGreaterThanOrEqual(decision.threshold);
    expect(decision.reason).toBe('PERSISTENT_COLLAPSE_RISK_THRESHOLD');
  });

  test('healthy condition below the threshold does not decide death', () => {
    const decision = persistentCoinDeath.decideAuthoritativePersistentDeath({
      seed: 'death-unit',
      coinId: 1,
      archetypeId: 'ZIP',
      condition: 0,
      phase: 'BOOM',
      recentChangePct: 2,
      nowMs: T1_MS
    });
    expect(decision.shouldDie).toBe(false);
    expect(decision.reason).toBeNull();
  });

  test('reaching a configured threshold is what kills — not the living floor constant', () => {
    const atFloorHealthy = persistentCoinDeath.decideAuthoritativePersistentDeath({
      seed: 'death-unit',
      coinId: 1,
      archetypeId: 'ZIP',
      condition: 0.2,
      phase: 'BULL',
      recentChangePct: 0,
      nowMs: T1_MS
    });
    expect(atFloorHealthy.shouldDie).toBe(false);

    const lowThreshold = resolveSimulationConfig({
      persistent: { death: { riskThreshold: 4.51 } }
    });
    const forced = persistentCoinDeath.decideAuthoritativePersistentDeath({
      seed: 'death-unit',
      coinId: 3,
      archetypeId: 'RUG',
      condition: -0.8,
      phase: 'FALL',
      recentChangePct: -12,
      nowMs: T1_MS,
      config: lowThreshold
    });
    expect(forced.shouldDie).toBe(true);
  });

  test('deterministic behaviour is maintained for identical inputs', () => {
    const args = {
      seed: 'death-determinism',
      coinId: 9,
      archetypeId: 'DEGEN',
      condition: -0.95,
      phase: 'FALL',
      recentChangePct: -18,
      nowMs: T2_MS
    };
    const a = persistentCoinDeath.decideAuthoritativePersistentDeath(args);
    const b = persistentCoinDeath.decideAuthoritativePersistentDeath(args);
    expect(a).toEqual(b);
  });
});

describe('Stage 9 S9-01: writer authoritative death path', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provisionedWorld();
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('reaching the living price floor alone does not kill a coin', async () => {
    const coinId = 1;
    jest.spyOn(persistentPricing, 'persistentPriceAt').mockReturnValue(marketDomain.MIN_POSITIVE_PRICE);
    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockReturnValue(1.0);

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    const { rows: state } = await db.query(
      'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1',
      [coinId]
    );
    expect(state[0].status).toBe('ALIVE');
    expect(state[0].died_at).toBeNull();
    const { rows: price } = await db.query(
      'SELECT current_price FROM coins WHERE coin_id = $1',
      [coinId]
    );
    expect(parseFloat(price[0].current_price)).toBe(marketDomain.MIN_POSITIVE_PRICE);
    expect(parseFloat(price[0].current_price)).toBeGreaterThan(0);
  });

  test('threshold/risk conditions lead to an explicit death decision in the writer', async () => {
    const coinId = 1;
    const decideSpy = jest.spyOn(persistentCoinDeath, 'decideAuthoritativePersistentDeath');
    const applySpy = jest.spyOn(persistentCoinDeath, 'applyAuthoritativePersistentDeath');
    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockReturnValue(9.5);

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    expect(decideSpy).toHaveBeenCalled();
    const verdicts = decideSpy.mock.results.map((r) => r.value).filter(Boolean);
    expect(verdicts.some((v) => v.shouldDie)).toBe(true);
    expect(applySpy).toHaveBeenCalled();

    const { rows } = await db.query(
      'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1',
      [coinId]
    );
    expect(rows[0].status).toBe('DEAD');
    expect(new Date(rows[0].died_at).getTime()).toBe(T2_MS);
  });

  test('authoritative death sets price exactly to zero (not the living floor)', async () => {
    const coinId = 2;
    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockImplementation((opts) => (
      Number(opts.coinId) === coinId ? 9.5 : 0.5
    ));

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    const { rows } = await db.query(
      'SELECT current_price FROM coins WHERE coin_id = $1',
      [coinId]
    );
    expect(parseFloat(rows[0].current_price)).toBe(0);
    expect(parseFloat(rows[0].current_price)).not.toBe(marketDomain.MIN_POSITIVE_PRICE);
  });

  test('status becomes permanently DEAD and repeated updates cannot resurrect', async () => {
    const coinId = 3;
    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockImplementation((opts) => (
      Number(opts.coinId) === coinId ? 9.5 : 0.5
    ));

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    const afterDeath = await db.query(
      'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1',
      [coinId]
    );
    expect(afterDeath.rows[0].status).toBe('DEAD');
    const diedAt = new Date(afterDeath.rows[0].died_at).getTime();

    jest.restoreAllMocks();
    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockReturnValue(0.1);
    await marketSimulator.updateAllPrices({ nowMs: T3_MS });
    await marketSimulator.updateAllPrices({ nowMs: T3_MS + 30 * 1000 });

    const { rows } = await db.query(
      'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1',
      [coinId]
    );
    expect(rows[0].status).toBe('DEAD');
    expect(new Date(rows[0].died_at).getTime()).toBe(diedAt);
    const price = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
    expect(parseFloat(price.rows[0].current_price)).toBe(0);
  });

  test('restart/reload preserves DEAD state (DB is the authority)', async () => {
    const coinId = 4;
    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockImplementation((opts) => (
      Number(opts.coinId) === coinId ? 9.5 : 0.5
    ));
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    jest.restoreAllMocks();

    marketSimulator.stop();
    marketSimulator.lastBatch = null;

    await marketSimulator.updateAllPrices({ nowMs: T3_MS });

    const { rows } = await db.query(
      'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1',
      [coinId]
    );
    expect(rows[0].status).toBe('DEAD');
    expect(new Date(rows[0].died_at).getTime()).toBe(T2_MS);
    const price = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
    expect(parseFloat(price.rows[0].current_price)).toBe(0);
  });

  test('historical price and trade data remain preserved after death', async () => {
    const coinId = 1;
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = $1', [coinId]);
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId, quantity: 5 });

    const historyBefore = await db.query(
      'SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1 AND price > 0',
      [coinId]
    );
    const ledgerBefore = await db.query(
      'SELECT count(*)::int AS n FROM persistent_transactions WHERE coin_id = $1',
      [coinId]
    );
    expect(historyBefore.rows[0].n).toBeGreaterThan(0);
    expect(ledgerBefore.rows[0].n).toBe(1);

    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockImplementation((opts) => (
      Number(opts.coinId) === coinId ? 9.5 : 0.5
    ));
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    const historyAfter = await db.query(
      'SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1 AND price > 0',
      [coinId]
    );
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n);

    const deathTicks = await db.query(
      `SELECT price, source, cycle_id FROM price_history
        WHERE coin_id = $1 AND price = 0 ORDER BY created_at DESC LIMIT 1`,
      [coinId]
    );
    expect(deathTicks.rows.length).toBe(1);
    expect(parseFloat(deathTicks.rows[0].price)).toBe(0);
    expect(deathTicks.rows[0].source).toBe('MARKET_TICK');
    expect(deathTicks.rows[0].cycle_id).toBeNull();

    const ledgerAfter = await db.query(
      'SELECT type, quantity, price, total_amount FROM persistent_transactions WHERE coin_id = $1',
      [coinId]
    );
    expect(ledgerAfter.rows.length).toBe(1);
    expect(ledgerAfter.rows[0].type).toBe('BUY');
    expect(parseFloat(ledgerAfter.rows[0].quantity)).toBe(5);

    const { rows: coins } = await db.query('SELECT coin_id FROM coins WHERE coin_id = $1', [coinId]);
    expect(coins.length).toBe(1);
  });

  test('buy attempts against DEAD coins fail', async () => {
    const coinId = 1;
    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockImplementation((opts) => (
      Number(opts.coinId) === coinId ? 9.5 : 0.5
    ));
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    await expect(
      persistentEconomy.buyPersistentTrade({ userId: 1, coinId, quantity: 1 })
    ).rejects.toThrow(/permanently dead/);
  });

  test('sell attempts against DEAD coins fail', async () => {
    const coinId = 1;
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = $1', [coinId]);
    await persistentEconomy.buyPersistentTrade({ userId: 1, coinId, quantity: 4 });

    jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockImplementation((opts) => (
      Number(opts.coinId) === coinId ? 9.5 : 0.5
    ));
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    await expect(
      persistentEconomy.sellPersistentTrade({ userId: 1, coinId, quantity: 1 })
    ).rejects.toThrow(/permanently dead/);

    const { rows } = await db.query(
      'SELECT quantity FROM persistent_holdings WHERE user_id = 1 AND coin_id = $1',
      [coinId]
    );
    expect(parseFloat(rows[0].quantity)).toBe(4);
  });

  test('applyAuthoritativePersistentDeath is effect-idempotent on exact replay and rejects a moved death with zero writes', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const coinId = 5;
    const existing = await db.query('SELECT status FROM market_coin_state WHERE coin_id = $1', [coinId]);
    expect(existing.rows[0].status).toBe('ALIVE');

    const { rows: checkpointRows } = await db.query(
      `SELECT coin_id, seed, checkpoint_ms, domain_cycle_index, domain_cycle_start_ms,
              domain_anchor, domain_boundary, crash_episode_index, crash_cursor_ms,
              crash_factor, activation_context
         FROM market_price_checkpoints WHERE coin_id = $1`,
      [coinId]
    );
    expect(checkpointRows.length).toBe(1);
    const baseCheckpoint = {
      coinId,
      seed: checkpointRows[0].seed,
      checkpointMs: Number(checkpointRows[0].checkpoint_ms),
      domainCycleIndex: Number(checkpointRows[0].domain_cycle_index),
      domainCycleStartMs: Number(checkpointRows[0].domain_cycle_start_ms),
      domainAnchor: checkpointRows[0].domain_anchor,
      domainBoundary: checkpointRows[0].domain_boundary,
      crashEpisodeIndex: Number(checkpointRows[0].crash_episode_index),
      crashCursorMs: Number(checkpointRows[0].crash_cursor_ms),
      crashFactor: checkpointRows[0].crash_factor,
      activationContext: checkpointRows[0].activation_context
    };
    const firstCheckpoint = { ...baseCheckpoint, crashFactor: 0.5 };
    const replayCheckpoint = { ...baseCheckpoint, crashFactor: 2.5 };

    const firstNextState = {
      coinId,
      worldId: world.worldId,
      archetype: marketDomain.GAMEPLAY_ROSTER.get(coinId),
      condition: -1,
      structuralReference: 1,
      peakReference: 1,
      status: 'ALIVE',
      diedAt: null
    };
    const replayNextState = {
      ...firstNextState,
      condition: 0.25,
      structuralReference: 99,
      peakReference: 99
    };
    const applyArgs = {
      coinId,
      worldId: world.worldId,
      diedAt: T2_MS,
      nextState: firstNextState,
      checkpoint: firstCheckpoint,
      batchInstant: new Date(T2_MS).toISOString()
    };

    async function snapshot(client) {
      const price = await client.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
      const state = await client.query(
        `SELECT status, died_at, condition, structural_reference, peak_reference
           FROM market_coin_state WHERE coin_id = $1`,
        [coinId]
      );
      const ticks = await client.query(
        `SELECT count(*)::int AS n FROM price_history
          WHERE coin_id = $1 AND price = 0 AND source = 'MARKET_TICK'`,
        [coinId]
      );
      const history = await client.query(
        'SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1',
        [coinId]
      );
      const checkpoint = await client.query(
        `SELECT checkpoint_ms, crash_factor, domain_cycle_index, domain_anchor
           FROM market_price_checkpoints WHERE coin_id = $1`,
        [coinId]
      );
      return {
        price: parseFloat(price.rows[0].current_price),
        status: state.rows[0].status,
        diedAtMs: new Date(state.rows[0].died_at).getTime(),
        condition: state.rows[0].condition,
        structuralReference: state.rows[0].structural_reference,
        peakReference: state.rows[0].peak_reference,
        zeroTicks: ticks.rows[0].n,
        historyCount: history.rows[0].n,
        checkpointMs: Number(checkpoint.rows[0].checkpoint_ms),
        crashFactor: checkpoint.rows[0].crash_factor,
        domainCycleIndex: Number(checkpoint.rows[0].domain_cycle_index),
        domainAnchor: checkpoint.rows[0].domain_anchor
      };
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const first = await persistentCoinDeath.applyAuthoritativePersistentDeath(client, applyArgs);
      expect(first.died).toBe(true);
      expect(first.alreadyDead).toBe(false);
      expect(first.price).toBe(0);

      const afterFirst = await snapshot(client);
      expect(afterFirst.price).toBe(0);
      expect(afterFirst.status).toBe('DEAD');
      expect(afterFirst.diedAtMs).toBe(T2_MS);
      expect(afterFirst.condition).toBe(-1);
      expect(afterFirst.structuralReference).toBe(1);
      expect(afterFirst.peakReference).toBe(1);
      expect(afterFirst.zeroTicks).toBe(1);
      expect(afterFirst.crashFactor).toBe(0.5);

      const replay = await persistentCoinDeath.applyAuthoritativePersistentDeath(client, {
        ...applyArgs,
        nextState: replayNextState,
        checkpoint: replayCheckpoint
      });
      expect(replay.alreadyDead).toBe(true);
      expect(replay.died).toBe(false);
      expect(replay.price).toBe(0);

      const afterReplay = await snapshot(client);
      expect(afterReplay).toEqual(afterFirst);

      await expect(
        persistentCoinDeath.applyAuthoritativePersistentDeath(client, {
          ...applyArgs,
          diedAt: T3_MS,
          nextState: replayNextState,
          checkpoint: replayCheckpoint,
          batchInstant: new Date(T3_MS).toISOString()
        })
      ).rejects.toThrow(/already DEAD|cannot move/);

      const afterMoved = await snapshot(client);
      expect(afterMoved).toEqual(afterFirst);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
