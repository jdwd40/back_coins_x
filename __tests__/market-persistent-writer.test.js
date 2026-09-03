// Persistent-market Stage 4: the runtime-authoritative persistent market
// writer (models/market-simulator.js) against the REAL disposable test
// database. This suite carries forward — at equal rigor — the writer
// contract coverage of the retired V2-writer suites (v2-market-writer,
// unified-price-path, the writer-coupled parts of market-collapse /
// market-apocalypse-volatility / pricing-checkpoint-db /
// price-history-provenance), now against the persistent path:
//   * world resolution — updateAllPrices resolves THE active persistent
//     world exactly once per batch and never reconciles/creates/rolls over
//     an Apocalypse cycle (no apocalypsePercent/amplitude anywhere);
//   * Director threading — every coin is priced through the persistent
//     engine with the world seed/epoch and the Director environment
//     provider behind the market-environment seam;
//   * determinism — a batch at a pinned simulated instant recomputes
//     identical prices; simulated time is injected explicitly;
//   * atomicity — price + price_history + per-coin market state + pricing
//     checkpoint + Director cursor + market_history commit together or
//     roll back together (invalid price / corrupt checkpoint / malformed
//     dead state all abort with nothing written);
//   * worker restart / checkpoint resume — every batch rebuilds its state
//     from the database alone (the writer holds no in-memory pricing
//     state); a resumed batch is bit-identical to the stateless origin
//     walk, and the Director walk resumes from the committed cursor;
//   * persistent death — a DEAD coin stays exactly £0, is never priced and
//     never gains history; a DEAD coin with a non-zero price aborts the
//     batch safely;
//   * provenance — persistent ticks are world-scoped: cycle_id NULL,
//     source 'MARKET_TICK', created_at stamped with the batch instant;
//   * redaction — no Director internals (seed, rolls, chain index) reach
//     the writer's public status/stats surface.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const marketDomain = require('../game/marketDomain');
const persistentPricing = require('../game/persistentPricing');
const persistentWorld = require('../game/persistentWorld');
const marketDirector = require('../game/marketDirector');
const pricingCheckpointModel = require('../models/pricingCheckpoint.model');
const coinStateModel = require('../models/marketCoinState.model');
const directorStateModel = require('../models/marketDirectorState.model');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const WORLD_SEED = 'stage4-writer-world-seed';
const EPOCH_MS = new Date('2026-08-31T00:00:00.000Z').getTime();
const T1_MS = EPOCH_MS + 10 * 60 * 1000;
const T2_MS = T1_MS + 30 * 1000;

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(EPOCH_MS) });
}

async function coinsSnapshot() {
  const { rows } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
  return rows;
}

async function tableCounts() {
  const history = await db.query('SELECT count(*)::int AS n FROM price_history');
  const marketHistory = await db.query('SELECT count(*)::int AS n FROM market_history');
  const checkpoints = await db.query('SELECT count(*)::int AS n FROM market_price_checkpoints');
  const coinStates = await db.query('SELECT count(*)::int AS n FROM market_coin_state');
  const directorStates = await db.query('SELECT count(*)::int AS n FROM market_director_state');
  const cycles = await db.query('SELECT count(*)::int AS n FROM apocalypse_cycles');
  return {
    priceHistory: history.rows[0].n,
    marketHistory: marketHistory.rows[0].n,
    checkpoints: checkpoints.rows[0].n,
    coinStates: coinStates.rows[0].n,
    directorStates: directorStates.rows[0].n,
    cycles: cycles.rows[0].n
  };
}

describe('Stage 4 persistent market writer: batch state resolution', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provisionedWorld();
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('updateAllPrices resolves THE active world exactly once per batch', async () => {
    const spy = jest.spyOn(persistentWorld, 'resolveActiveWorld');
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('with no active world the batch aborts before any write (never fabricates one)', async () => {
    await db.query('DELETE FROM market_worlds'); // no active world remains
    const pricesBefore = await coinsSnapshot();
    const countsBefore = await tableCounts();

    await marketSimulator.updateAllPrices({ nowMs: T1_MS }); // fails loudly, writes nothing

    expect(await coinsSnapshot()).toEqual(pricesBefore);
    const countsAfter = await tableCounts();
    expect(countsAfter.priceHistory).toBe(countsBefore.priceHistory);
    expect(countsAfter.marketHistory).toBe(countsBefore.marketHistory);
    expect(countsAfter.checkpoints).toBe(countsBefore.checkpoints);
    expect(countsAfter.coinStates).toBe(countsBefore.coinStates);
    expect(countsAfter.directorStates).toBe(countsBefore.directorStates);
  });

  test('every live coin is priced through the persistent engine with the world identity and Director environment', async () => {
    const priceSpy = jest.spyOn(persistentPricing, 'persistentPriceAt');
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });

    const { rows: coins } = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(priceSpy).toHaveBeenCalledTimes(coins[0].n); // every live coin, exactly once
    for (const call of priceSpy.mock.calls) {
      const arg = call[0];
      expect(arg.seed).toBe(WORLD_SEED);
      expect(arg.originMs).toBe(EPOCH_MS);
      expect(arg.nowMs).toBe(T1_MS);
      expect(arg.structuralReference).toBeGreaterThan(0);
      expect(marketDomain.GAMEPLAY_ROSTER.get(Number(arg.coinId))).toBe(arg.archetypeId);
      expect(arg.environment && arg.environment.id).toBe('DIRECTOR');
      // No Apocalypse inputs anywhere in the persistent pricing call.
      expect(arg.amplitude).toBeUndefined();
      expect(arg.apocalypsePercent).toBeUndefined();
      expect(arg.lifecycleState).toBeUndefined();
    }
  });

  test('the batch never reconciles, creates or rolls over an Apocalypse cycle', async () => {
    const reconcileSpy = jest.spyOn(gameCycleService, 'reconcileCycle');
    const countsBefore = await tableCounts();
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    const countsAfter = await tableCounts();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(countsAfter.cycles).toBe(countsBefore.cycles);
  });

  test('survivors move and record history; the batch is deterministic at a pinned instant', async () => {
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    const afterFirst = await coinsSnapshot();

    // Prices actually moved off the seeded baselines.
    const seeded = require('../db/test_data/coins.json');
    let moved = 0;
    for (const row of afterFirst) {
      const seedPrice = Number(String(seeded.find((c) => c.coin_id === row.coin_id).current_price).replace(/[£,]/g, ''));
      if (Math.abs(parseFloat(row.current_price) - seedPrice) > 1e-9) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);

    // A second batch at the SAME pinned instant recomputes identical prices.
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    const afterSecond = await coinsSnapshot();
    expect(afterSecond).toEqual(afterFirst);
  });

  test('writer owns no pricing timers and no in-memory pricing state outside start()', async () => {
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    expect(marketSimulator.updateIntervalId).toBeNull();
    expect(marketSimulator.coinEvents).toBeUndefined();
    expect(marketSimulator.coinVolatility).toBeUndefined();
    expect(marketSimulator.initialPrices).toBeUndefined();
    expect(marketSimulator.cycleTimeout).toBeUndefined();
  });
});

describe('Stage 4 persistent market writer: atomicity and fail-safe guards', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provisionedWorld();
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('a fundamentally invalid calculated price fails the batch: nothing is written anywhere', async () => {
    const pricesBefore = await coinsSnapshot();
    const countsBefore = await tableCounts();

    jest.spyOn(marketSimulator, 'calculateNewPrice').mockReturnValue(NaN);
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });

    expect(await coinsSnapshot()).toEqual(pricesBefore);
    const countsAfter = await tableCounts();
    expect(countsAfter.priceHistory).toBe(countsBefore.priceHistory);
    expect(countsAfter.marketHistory).toBe(countsBefore.marketHistory);
    expect(countsAfter.checkpoints).toBe(countsBefore.checkpoints);
    expect(countsAfter.coinStates).toBe(countsBefore.coinStates);
    expect(countsAfter.directorStates).toBe(countsBefore.directorStates);
  });

  test('a corrupt (future) checkpoint aborts the batch and rolls price, history, state and cursor back together', async () => {
    await marketSimulator.updateAllPrices({ nowMs: T1_MS }); // establishes committed state
    const pricesBefore = await coinsSnapshot();
    const countsBefore = await tableCounts();
    const checkpointsBefore = await db.query(
      'SELECT coin_id, checkpoint_ms FROM market_price_checkpoints WHERE seed = $1 ORDER BY coin_id',
      [WORLD_SEED]
    );
    expect(checkpointsBefore.rows.length).toBeGreaterThan(0);

    // Corrupt one accumulator into the future (the CHECK constraints allow
    // any non-negative ms; the ENGINE validation is the loud guard).
    await db.query(
      'UPDATE market_price_checkpoints SET checkpoint_ms = $1 WHERE seed = $2 AND coin_id = $3',
      [T2_MS + 30 * 60 * 1000, WORLD_SEED, checkpointsBefore.rows[0].coin_id]
    );
    // The state the aborted batch must leave EXACTLY untouched: the corrupt
    // row as-is (failing loudly must never silently repair or re-anchor),
    // every other accumulator as the last good batch wrote it.
    const corruptedState = await db.query(
      'SELECT coin_id, checkpoint_ms FROM market_price_checkpoints WHERE seed = $1 ORDER BY coin_id',
      [WORLD_SEED]
    );

    await marketSimulator.updateAllPrices({ nowMs: T2_MS }); // must abort internally and roll back

    expect(await coinsSnapshot()).toEqual(pricesBefore);
    const countsAfter = await tableCounts();
    expect(countsAfter.priceHistory).toBe(countsBefore.priceHistory);
    expect(countsAfter.marketHistory).toBe(countsBefore.marketHistory);
    expect(countsAfter.directorStates).toBe(countsBefore.directorStates);
    const checkpointsAfter = await db.query(
      'SELECT coin_id, checkpoint_ms FROM market_price_checkpoints WHERE seed = $1 ORDER BY coin_id',
      [WORLD_SEED]
    );
    expect(checkpointsAfter.rows).toEqual(corruptedState.rows);
  });

  test('a coin outside the explicit gameplay roster aborts the batch (never defaults an archetype)', async () => {
    await db.query(
      `INSERT INTO coins (name, symbol, current_price, market_cap, circulating_supply, founder, cycle_baseline_price)
       VALUES ('OffRoster', 'OFF', 1.00, 1000000, 1000000, 'test', 1.00)`
    );
    const pricesBefore = await coinsSnapshot();
    const countsBefore = await tableCounts();

    await marketSimulator.updateAllPrices({ nowMs: T1_MS }); // aborts loudly

    expect(await coinsSnapshot()).toEqual(pricesBefore);
    const countsAfter = await tableCounts();
    expect(countsAfter.priceHistory).toBe(countsBefore.priceHistory);
    expect(countsAfter.checkpoints).toBe(countsBefore.checkpoints);
  });

  test('a RETIRED off-roster coin is preserved history: skipped, while roster coins price normally', async () => {
    await db.query(
      `INSERT INTO coins (name, symbol, current_price, market_cap, circulating_supply, founder, cycle_baseline_price, retired)
       VALUES ('RetiredOld', 'OLD', 5.00, 1000000, 1000000, 'test', 5.00, TRUE)`
    );
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });

    // The batch committed: roster coins priced and checkpointed.
    const counts = await tableCounts();
    expect(counts.checkpoints).toBeGreaterThan(0);
    // The retired coin was never priced and never opened persistent state.
    const { rows } = await db.query(`SELECT current_price FROM coins WHERE symbol = 'OLD'`);
    expect(parseFloat(rows[0].current_price)).toBe(5);
    const { rows: stateRows } = await db.query(
      `SELECT count(*)::int AS n FROM market_coin_state ms JOIN coins c ON c.coin_id = ms.coin_id WHERE c.symbol = 'OLD'`
    );
    expect(stateRows[0].n).toBe(0);
  });
});

describe('Stage 4 persistent market writer: simulated time, restart and checkpoint resume', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provisionedWorld();
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('a batch writes price, history, coin state, checkpoint and Director cursor atomically, bit-identical to the origin walk', async () => {
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });

    const config = resolveSimulationConfig();
    const { rows: checkpointRows } = await db.query(
      'SELECT * FROM market_price_checkpoints WHERE seed = $1', [WORLD_SEED]
    );
    expect(checkpointRows.length).toBeGreaterThan(0);

    const world = await persistentWorld.resolveActiveWorld(db);
    const states = await coinStateModel.loadCoinStates(db, world.worldId);
    const environment = marketDirector.createMarketDirectorProvider({ seed: WORLD_SEED, originMs: EPOCH_MS });
    const { rows: coinRows } = await db.query(
      'SELECT coin_id, current_price FROM coins WHERE current_price > 0 ORDER BY coin_id'
    );
    expect(coinRows.length).toBeGreaterThan(0);
    for (const coin of coinRows) {
      const state = states.get(coin.coin_id);
      // Every written price equals the stateless origin walk exactly,
      // against the committed structural reference the batch priced from.
      // (The first batch opens the reference at the pre-batch live price
      // and advances it with zero elapsed time, so the committed reference
      // IS the opening reference the batch used.)
      const expected = persistentPricing.persistentPriceAt({
        seed: WORLD_SEED,
        coinId: coin.coin_id,
        archetypeId: state.archetype,
        originMs: EPOCH_MS,
        nowMs: T1_MS,
        structuralReference: state.structuralReference,
        environment,
        checkpoint: null,
        config
      });
      expect(Object.is(parseFloat(coin.current_price), expected)).toBe(true);
      // The persisted checkpoint is well-formed, world-scoped and resumable.
      const stored = pricingCheckpointModel.rowToCheckpoint(
        checkpointRows.find((r) => Number(r.coin_id) === coin.coin_id)
      );
      expect(stored.activationContext).toBe(persistentPricing.PERSISTENT_ACTIVATION_CONTEXT);
      const resolved = persistentPricing.resolvePersistentCheckpoint({
        stored, seed: WORLD_SEED, coinId: coin.coin_id, nowMs: T2_MS
      });
      expect(resolved.domainCheckpoint).not.toBeNull();
      expect(resolved.crashCheckpoint).not.toBeNull();
    }

    // The Director cursor committed in the same batch, in its OWN table.
    const director = await directorStateModel.loadDirectorState(db, world.worldId);
    expect(director).not.toBeNull();
    expect(director.regimeIndex).toBeGreaterThanOrEqual(0);
    expect(director.intensity).toBeGreaterThanOrEqual(0);
    expect(director.intensity).toBeLessThanOrEqual(1);
    const pure = marketDirector.walkDirectorChain({ seed: WORLD_SEED, originMs: EPOCH_MS, nowMs: T1_MS });
    expect(director.regime).toBe(pure.regime);
    expect(director.regimeIndex).toBe(pure.regimeIndex);
    expect(Object.is(director.intensity, pure.intensity)).toBe(true);
    expect(new Date(director.regimeStartedAt).getTime()).toBe(pure.startMs);
  });

  test('a second batch resumes from the persisted checkpoints and committed cursor, bit-identical to the origin walk', async () => {
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });

    // Committed state BEFORE the second batch (the second batch prices
    // from it): the origin-walk expectation uses these exact references.
    const world = await persistentWorld.resolveActiveWorld(db);
    const statesBefore = await coinStateModel.loadCoinStates(db, world.worldId);
    const directorBefore = await directorStateModel.loadDirectorState(db, world.worldId);
    expect(directorBefore).not.toBeNull();

    const resumeSpy = jest.spyOn(marketDirector, 'resumeDirectorCursor');
    const priceSpy = jest.spyOn(persistentPricing, 'persistentPriceAt');
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    // Worker-restart resume: the Director walk resumed from the committed
    // cursor row, not a fresh origin walk.
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy.mock.calls[0][0].state.regimeIndex).toBe(directorBefore.regimeIndex);
    // Threading proof: the second batch priced through the persisted
    // accumulators, not the origin walk.
    const resumedCalls = priceSpy.mock.calls.filter((c) => c[0].checkpoint);
    expect(resumedCalls.length).toBeGreaterThan(0);

    const config = resolveSimulationConfig();
    const environment = marketDirector.createMarketDirectorProvider({ seed: WORLD_SEED, originMs: EPOCH_MS });
    const { rows: coinRows } = await db.query(
      'SELECT coin_id, current_price FROM coins WHERE current_price > 0 ORDER BY coin_id'
    );
    for (const coin of coinRows) {
      const stateBefore = statesBefore.get(coin.coin_id);
      const expected = persistentPricing.persistentPriceAt({
        seed: WORLD_SEED,
        coinId: coin.coin_id,
        archetypeId: stateBefore.archetype,
        originMs: EPOCH_MS,
        nowMs: T2_MS,
        structuralReference: stateBefore.structuralReference,
        environment,
        checkpoint: null, // stateless origin walk — the resumed batch must match it bit-for-bit
        config
      });
      expect(Object.is(parseFloat(coin.current_price), expected)).toBe(true);
    }

    // Simulated time advanced the committed checkpoint instants exactly.
    const { rows: checkpointRows } = await db.query(
      'SELECT checkpoint_ms FROM market_price_checkpoints WHERE seed = $1', [WORLD_SEED]
    );
    for (const row of checkpointRows) {
      expect(Number(row.checkpoint_ms)).toBe(T2_MS);
    }
  });

  test('a tampered committed Director cursor fails loudly (bit-verified resume) and aborts the batch', async () => {
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    const world = await persistentWorld.resolveActiveWorld(db);
    const committed = await directorStateModel.loadDirectorState(db, world.worldId);

    // Tamper the committed intensity behind the chain's back (the CHECK
    // bounds admit it; the bit-exact chain verification is the loud guard).
    await db.query(
      'UPDATE market_director_state SET intensity = $1 WHERE world_id = $2',
      [committed.intensity === 0.5 ? 0.25 : 0.5, world.worldId]
    );

    const pricesBefore = await coinsSnapshot();
    const countsBefore = await tableCounts();
    await marketSimulator.updateAllPrices({ nowMs: T2_MS }); // aborts: corrupt cursor

    expect(await coinsSnapshot()).toEqual(pricesBefore);
    const countsAfter = await tableCounts();
    expect(countsAfter.priceHistory).toBe(countsBefore.priceHistory);
    expect(countsAfter.marketHistory).toBe(countsBefore.marketHistory);
  });
});

describe('Stage 4 persistent market writer: persistent death', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provisionedWorld();
    await marketSimulator.updateAllPrices({ nowMs: T1_MS }); // establish live committed state
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  async function killCoin(coinId) {
    const world = await persistentWorld.resolveActiveWorld(db);
    await coinStateModel.recordDeath(db, { coinId, worldId: world.worldId, diedAt: new Date(T2_MS) });
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [coinId]);
    return world;
  }

  test('a persistently dead coin is never priced, never revived and gains no history', async () => {
    const coinId = 1;
    await killCoin(coinId);
    const calcSpy = jest.spyOn(marketSimulator, 'calculateNewPrice');
    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    for (const call of calcSpy.mock.calls) {
      expect(call[0].coin_id).not.toBe(coinId);
    }
    const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
    expect(parseFloat(rows[0].current_price)).toBe(0);
    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n);
  });

  test('a zero-priced dead coin does not trip the invalid-write protection: the batch commits for survivors', async () => {
    await killCoin(1);
    const marketHistoryBefore = await db.query('SELECT count(*)::int AS n FROM market_history');
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    const marketHistoryAfter = await db.query('SELECT count(*)::int AS n FROM market_history');
    expect(marketHistoryAfter.rows[0].n).toBe(marketHistoryBefore.rows[0].n + 1);
  });

  test('malformed state (dead coin with a non-zero price) fails safely: nothing written, nothing revived', async () => {
    const coinId = 1;
    const world = await persistentWorld.resolveActiveWorld(db);
    await coinStateModel.recordDeath(db, { coinId, worldId: world.worldId, diedAt: new Date(T2_MS) });
    await db.query('UPDATE coins SET current_price = 5 WHERE coin_id = $1', [coinId]); // corrupt behind the record's back

    const pricesBefore = await coinsSnapshot();
    const countsBefore = await tableCounts();
    await marketSimulator.updateAllPrices({ nowMs: T2_MS }); // logs the error, aborts the batch

    expect(await coinsSnapshot()).toEqual(pricesBefore);
    const countsAfter = await tableCounts();
    expect(countsAfter.priceHistory).toBe(countsBefore.priceHistory);
    expect(countsAfter.marketHistory).toBe(countsBefore.marketHistory);
  });

  test('death survives repeated batches exactly (permanent, replay-idempotent)', async () => {
    const coinId = 1;
    await killCoin(coinId);
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    await marketSimulator.updateAllPrices({ nowMs: T2_MS + 30 * 1000 });

    const { rows } = await db.query(
      'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1', [coinId]
    );
    expect(rows[0].status).toBe('DEAD');
    expect(new Date(rows[0].died_at).getTime()).toBe(T2_MS);
    const price = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
    expect(parseFloat(price.rows[0].current_price)).toBe(0);
  });
});

describe('Stage 4 persistent market writer: provenance and redaction', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provisionedWorld();
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('persistent ticks are world-scoped: cycle_id NULL, source MARKET_TICK, created_at is the batch instant', async () => {
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    const { rows } = await db.query(
      `SELECT coin_id, cycle_id, source, created_at FROM price_history`
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.cycle_id).toBeNull(); // persistent world: no cycle provenance
      expect(row.source).toBe('MARKET_TICK');
      expect(new Date(row.created_at).getTime()).toBe(T1_MS);
    }
    const { rows: live } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price > 0');
    expect(rows.length).toBe(live[0].n); // one row per live coin
  });

  test('the public status/stats surface carries no Director internals or seeds', async () => {
    await marketSimulator.start();
    const deadline = Date.now() + 5000;
    while (marketSimulator.lastBatch === null && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    marketSimulator.stop();
    expect(marketSimulator.lastBatch).not.toBeNull();

    const status = JSON.stringify(marketSimulator.getMarketStatus());
    const stats = JSON.stringify(await marketSimulator.getMarketStats('30M'));
    for (const payload of [status, stats]) {
      expect(payload).not.toContain(WORLD_SEED);
      expect(payload).not.toContain('regimeIndex');
      expect(payload).not.toContain('regime_index');
      expect(payload).not.toContain('transitionRoll');
      expect(payload).not.toContain('directorRolls');
    }
  });
});
