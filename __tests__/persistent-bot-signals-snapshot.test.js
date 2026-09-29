// Persistent bot signal path regression (bot trading halted in prod once
// the world passed ~13.8 days of age):
//
//   1. Bounded walk: the bot signal replayed persistent pricing from the
//      world epoch for its 60s-ago comparison price and threw the pricing
//      engine's bounded-walk guard (10,000 cycles) on an old world.
//   2. Checkpoint race: the tick fixed nowMs once but reloaded checkpoints
//      per bot, so a writer batch committed mid-tick handed later bots a
//      checkpoint newer than nowMs ("checkpoint is from the future").
//   3. Either error aborted the WHOLE bot tick.
//
// Fixed contract (covered here against the real disposable test DB with
// real writer batches):
//   * bot recent movement/momentum come from COMMITTED prices through the
//     same query/formula as GET /api/persistent/signals — they agree;
//   * one market snapshot per bot tick, shared by every bot;
//   * per-coin fault isolation; systemic (all-coin) failure stays loud.

const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const persistentWorld = require('../game/persistentWorld');
const persistentBots = require('../game/persistentBots');
const persistentEconomy = require('../game/persistentEconomy');
const persistentSignals = require('../game/persistentSignals');
const persistentMarketSignalsService = require('../game/persistentMarketSignalsService');
const checkpointModel = require('../models/pricingCheckpoint.model');
const coinStateModel = require('../models/marketCoinState.model');
const { BOT_ROSTER } = require('../game/botConfig');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(120000);

const CONFIG = resolveSimulationConfig();
const WORLD_SEED = 'bot-signals-snapshot-seed';
// Fixed instants (never Date.now()): the tick instant T and a world that is
// 21 days old at T.
const T_MS = Date.parse('2026-09-20T12:00:00.000Z');
const OLD_EPOCH_MS = T_MS - 21 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function recordingLogger() {
  const errors = [];
  return {
    errors,
    log: () => {},
    warn: () => {},
    error: (...args) => { errors.push(args.map(String).join(' ')); }
  };
}

// An old world with FRESH committed state — the production shape: the
// writer has been resuming from checkpoints every 30s, so checkpoints and
// MARKET_TICK history are recent while the epoch is weeks back. The writer
// batches run on a young epoch (so the fixture itself never needs a long
// walk), then the epoch is moved back to 21 days before T. Checkpoints
// stay valid (every cursor is after the origin).
async function provisionOldWorldWithFreshState() {
  await persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(T_MS - 10 * 60 * 1000) });
  for (const offset of [-150000, -120000, -90000, -60000, -30000, 0]) {
    await marketSimulator.updateAllPrices({ nowMs: T_MS + offset });
  }
  await db.query('UPDATE market_worlds SET epoch_started_at = $1 WHERE active', [new Date(OLD_EPOCH_MS).toISOString()]);
  const world = await persistentWorld.resolveActiveWorld(db);
  expect(T_MS - world.epochStartedAtMs).toBeGreaterThanOrEqual(20 * DAY_MS);
  return world;
}

async function liveCoinIds(world) {
  const { rows } = await db.query(
    `SELECT c.coin_id FROM coins c
       LEFT JOIN market_coin_state s ON s.coin_id = c.coin_id AND s.world_id = $1
      WHERE c.retired = false AND (s.status IS NULL OR s.status <> 'DEAD')
      ORDER BY c.coin_id`,
    [world.worldId]
  );
  return rows.map((r) => r.coin_id);
}

describe('persistent bot signals: old world, committed-price parity with /api/persistent/signals', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('the fixture reproduces the old failure: the epoch-replay signal trips the bounded-walk guard', async () => {
    const world = await provisionOldWorldWithFreshState();
    const states = await coinStateModel.loadCoinStates(db, world.worldId);
    const checkpoints = await checkpointModel.loadCheckpoints(db, world.seed);
    const coinId = (await liveCoinIds(world))[0];
    const cs = states.get(coinId);
    expect(() => persistentSignals.computePersistentCoinSignal({
      seed: world.seed,
      coinId,
      archetypeId: cs.archetype,
      originMs: world.epochStartedAtMs,
      nowMs: T_MS,
      structuralReference: cs.structuralReference,
      condition: cs.condition,
      checkpoint: checkpoints.get(coinId),
      config: CONFIG
    })).toThrow(/bounded-walk guard \(10000 cycles\)/);
  });

  test('a bot tick on a >=20-day-old world completes with no guard error and signals match the endpoint', async () => {
    const world = await provisionOldWorldWithFreshState();
    const logger = recordingLogger();
    const signalSpy = jest.spyOn(persistentSignals, 'computeCommittedPersistentCoinSignal');

    const result = await persistentBots.runPersistentBotTick({ tickId: 7001, nowMs: T_MS, logger });
    expect(result.claimed).toBe(true);
    expect(result.actions.length).toBeGreaterThanOrEqual(BOT_ROSTER.length);
    for (const action of result.actions) {
      expect(String(action.reason || '')).not.toMatch(/bounded-walk|from the future|decision-error/);
    }
    expect(logger.errors).toEqual([]);
    // Every live coin got a committed-data signal, evaluated at T.
    const live = await liveCoinIds(world);
    expect(signalSpy.mock.calls.map((c) => Number(c[0].coinId)).sort((a, b) => a - b)).toEqual(live);
    for (const [args] of signalSpy.mock.calls) {
      expect(args.nowMs).toBe(T_MS);
    }

    // Parity: the bot's snapshot and the public endpoint at the same instant
    // publish identical movement for every coin.
    const snapshot = await persistentBots.loadPersistentBotMarketSnapshot({ world, nowMs: T_MS, logger });
    expect(snapshot.failures).toEqual([]);
    const endpoint = await persistentMarketSignalsService.getPersistentMarketSignals({ now: new Date(T_MS) });
    let nonNull = 0;
    for (const coin of snapshot.coins) {
      const published = endpoint.coins.find((c) => c.coinId === coin.coinId);
      expect(published).toBeDefined();
      expect(Object.is(coin.currentPrice, published.currentPrice)).toBe(true);
      expect(Object.is(coin.recentChangePct, published.recentChangePct)).toBe(true);
      expect(coin.momentum).toBe(published.momentum);
      expect(coin.dead).toBe(published.dead);
      if (coin.recentChangePct !== null) nonNull += 1;
    }
    // The comparison is non-trivial: committed 60s-old ticks exist.
    expect(nonNull).toBeGreaterThan(0);
    expect(logger.errors).toEqual([]);
  });
});

describe('persistent bot tick: one stable market snapshot per tick (writer race)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('a writer batch committing a newer checkpoint mid-tick never reaches later bots', async () => {
    const world = await provisionOldWorldWithFreshState();
    const logger = recordingLogger();
    const pastSpy = jest.spyOn(persistentMarketSignalsService, 'loadCommittedPastPrices');
    const signalSpy = jest.spyOn(persistentSignals, 'computeCommittedPersistentCoinSignal');

    // After the FIRST bot reads its account, the market writer commits the
    // next batch (checkpoints at T+30s > the tick's fixed nowMs T).
    const realGetAccount = persistentEconomy.getPersistentAccountState;
    let accountReads = 0;
    let raced = false;
    jest.spyOn(persistentEconomy, 'getPersistentAccountState').mockImplementation(async (args) => {
      const account = await realGetAccount(args);
      accountReads += 1;
      if (accountReads === 1) {
        await marketSimulator.updateAllPrices({ nowMs: T_MS + 30000 });
        raced = true;
      }
      return account;
    });

    const result = await persistentBots.runPersistentBotTick({ tickId: 7002, nowMs: T_MS, logger });
    expect(raced).toBe(true);
    expect(accountReads).toBeGreaterThanOrEqual(BOT_ROSTER.length);
    expect(result.claimed).toBe(true);
    const decided = new Set(result.actions.map((a) => a.botKey));
    expect(decided.size).toBe(BOT_ROSTER.length);
    for (const action of result.actions) {
      expect(String(action.reason || '')).not.toMatch(/from the future|bounded-walk|decision-error/);
    }
    expect(logger.errors).toEqual([]);

    // The market state was loaded ONCE for the whole tick (before any bot)
    // and every signal was evaluated against the tick instant with the
    // pre-race checkpoints (checkpointMs <= T).
    expect(pastSpy).toHaveBeenCalledTimes(1);
    const live = await liveCoinIds(world);
    expect(signalSpy).toHaveBeenCalledTimes(live.length);
    for (const [args] of signalSpy.mock.calls) {
      expect(args.nowMs).toBe(T_MS);
      expect(args.checkpoint.checkpointMs).toBeLessThanOrEqual(T_MS);
    }

    // The race was real: the committed checkpoints are now newer than T,
    // and the old per-bot reload + epoch-replay path refuses them.
    const fresh = await checkpointModel.loadCheckpoints(db, world.seed);
    const states = await coinStateModel.loadCoinStates(db, world.worldId);
    const coinId = live[0];
    expect(fresh.get(coinId).checkpointMs).toBeGreaterThan(T_MS);
    expect(() => persistentSignals.computePersistentCoinSignal({
      seed: world.seed,
      coinId,
      archetypeId: states.get(coinId).archetype,
      originMs: world.epochStartedAtMs,
      nowMs: T_MS,
      structuralReference: states.get(coinId).structuralReference,
      condition: states.get(coinId).condition,
      checkpoint: fresh.get(coinId),
      config: CONFIG
    })).toThrow(/is from the future/);
  });

  test('a checkpoint committed between the tick instant and the snapshot load is used, not refused', async () => {
    const world = await provisionOldWorldWithFreshState();
    await marketSimulator.updateAllPrices({ nowMs: T_MS + 30000 }); // committed before the snapshot read
    const logger = recordingLogger();
    const snapshot = await persistentBots.loadPersistentBotMarketSnapshot({ world, nowMs: T_MS, logger });
    expect(logger.errors).toEqual([]);
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.coins.length).toBe(snapshot.liveCoinCount + snapshot.coins.filter((c) => c.dead).length);
    for (const coin of snapshot.coins) {
      if (!coin.dead) expect(typeof coin.phase).toBe('string');
    }
  });
});

describe('persistent bot tick: per-coin fault isolation', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('one coin with a corrupt committed checkpoint is logged and excluded; every other coin and bot continues', async () => {
    const world = await provisionOldWorldWithFreshState();
    const live = await liveCoinIds(world);
    const badCoinId = live[0];
    // A corrupt stored accumulator: the engine refuses it loudly.
    await db.query(
      "UPDATE market_price_checkpoints SET domain_anchor = 'NaN' WHERE coin_id = $1 AND seed = $2",
      [badCoinId, world.seed]
    );
    const logger = recordingLogger();

    const result = await persistentBots.runPersistentBotTick({ tickId: 7003, nowMs: T_MS, logger });
    expect(result.claimed).toBe(true);
    expect(new Set(result.actions.map((a) => a.botKey)).size).toBe(BOT_ROSTER.length);
    for (const action of result.actions) {
      if (action.coinId !== undefined) expect(action.coinId).not.toBe(badCoinId);
    }
    // Logged once for the tick, naming the coin and the error.
    const coinErrors = logger.errors.filter((e) => e.includes('Persistent bot signal failed'));
    expect(coinErrors).toHaveLength(1);
    expect(coinErrors[0]).toContain(`coin ${badCoinId}`);
    expect(coinErrors[0]).toMatch(/checkpoint|finite|anchor/i);

    const snapshot = await persistentBots.loadPersistentBotMarketSnapshot({ world, nowMs: T_MS, logger: recordingLogger() });
    expect(snapshot.failures.map((f) => f.coinId)).toEqual([badCoinId]);
    expect(snapshot.coins.find((c) => c.coinId === badCoinId)).toBeUndefined();
    expect(snapshot.coins.filter((c) => !c.dead).length).toBe(live.length - 1);
  });

  test('a signal failure on EVERY live coin is systemic: logged at error level and the tick fails loudly', async () => {
    await provisionOldWorldWithFreshState();
    jest.spyOn(persistentSignals, 'computeCommittedPersistentCoinSignal').mockImplementation(() => {
      throw new Error('synthetic signal outage');
    });
    const logger = recordingLogger();
    await expect(persistentBots.runPersistentBotTick({ tickId: 7004, nowMs: T_MS, logger }))
      .rejects.toThrow(/failed for all \d+ live coins/);
    expect(logger.errors.some((e) => /failed for ALL \d+ live coins/.test(e))).toBe(true);
    // No trade was attempted on a fully degraded snapshot.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM persistent_transactions t JOIN users u ON u.user_id = t.user_id WHERE u.is_bot`
    );
    expect(rows[0].n).toBe(0);
  });

  test('a bot holding a coin whose signal failed never takes a loan on the degraded snapshot', async () => {
    const world = await provisionOldWorldWithFreshState();
    const live = await liveCoinIds(world);
    const badCoinId = live[0];
    const tick = await persistentBots.runPersistentBotTick({ tickId: 7005, nowMs: T_MS, logger: recordingLogger() });
    expect(tick.claimed).toBe(true);
    // Make one bot "bankrupt except for" a holding in the failing coin.
    const { rows: [bot] } = await db.query(
      `SELECT pa.account_id, pa.user_id, pa.world_id FROM persistent_accounts pa JOIN users u ON u.user_id = pa.user_id
        WHERE u.is_bot ORDER BY pa.user_id LIMIT 1`
    );
    await db.query('DELETE FROM persistent_holdings WHERE account_id = $1', [bot.account_id]);
    await db.query('UPDATE persistent_accounts SET cash = 0 WHERE account_id = $1', [bot.account_id]);
    await db.query(
      `INSERT INTO persistent_holdings (account_id, world_id, user_id, coin_id, quantity, cost_basis) VALUES ($1, $2, $3, $4, 1000, 1000)`,
      [bot.account_id, bot.world_id, bot.user_id, badCoinId]
    );
    await db.query(
      "UPDATE market_price_checkpoints SET domain_anchor = 'NaN' WHERE coin_id = $1 AND seed = $2",
      [badCoinId, world.seed]
    );
    const result = await persistentBots.runPersistentBotTick({ tickId: 7006, nowMs: T_MS, logger: recordingLogger() });
    const own = result.actions.filter((a) => a.userId === bot.user_id);
    expect(own.map((a) => a.action)).not.toContain('LOAN');
    expect(own.some((a) => a.action === 'SKIP' && /loan-deferred/.test(a.reason))).toBe(true);
  });
});
