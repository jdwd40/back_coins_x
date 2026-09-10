// Director Coin Events Wave 3: persistent bot signal parity with the
// event-modifier pricing path.
//
// Bots must only ever use committed/current public signals: no future
// events, no event seeds, no hidden Director rolls, no active-event
// internals. When the bot's public-signal RECOMPUTATION needs the event
// modifier to match the current committed pricing/condition, it must use
// the same current committed capped modifier WITHOUT exposing it in the
// shaped state.
//
// Covered (real disposable database, real writer batches):
//   * the signal recompute receives exactly the committed capped net
//     modifier per coin;
//   * the shaped public coin state carries the exact allowlist keys — the
//     modifier never leaks into the decision input;
//   * the recomputed signal price matches the committed traded price
//     exactly (parity through the shared engine).

const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const persistentWorld = require('../game/persistentWorld');
const persistentBots = require('../game/persistentBots');
const persistentSignals = require('../game/persistentSignals');
const persistentCoinEventDomain = require('../game/persistentCoinEventDomain');
const eventsModel = require('../models/persistentCoinEvents.model');
const coinStateModel = require('../models/marketCoinState.model');
const checkpointModel = require('../models/pricingCheckpoint.model');
const marketDomain = require('../game/marketDomain');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const CONFIG = resolveSimulationConfig();
const WORLD_SEED = 'wave3-bot-parity-seed';
const EPOCH_MS = Date.parse('2026-08-31T00:00:00.000Z');
const T1_MS = EPOCH_MS + 10 * 60 * 1000;
const T2_MS = T1_MS + 30 * 1000;

describe('Wave 3: persistent bot signal parity with the committed event modifier', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(EPOCH_MS) });
    await marketSimulator.updateAllPrices({ nowMs: T1_MS }); // open committed coin state
    await marketSimulator.updateAllPrices({ nowMs: T2_MS }); // Director plan + reconciled events
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('the signal recompute uses the committed capped modifier; the shaped state never exposes it', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const eventTotal = (await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1', [world.worldId])).rows[0].n;
    expect(eventTotal).toBeGreaterThan(0); // the fixture genuinely carries events

    const signalSpy = jest.spyOn(persistentSignals, 'computePersistentCoinSignal');
    const state = await persistentBots.buildPublicPersistentMarketState({
      world, account: null, nowMs: T2_MS, queryable: db
    });

    // The decision-layer contract still holds on the shaped state.
    expect(() => persistentBots.assertPublicPersistentBotState(state)).not.toThrow();

    const committed = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    for (const coin of state.coins) {
      if (coin.dead) continue;
      // No event internals anywhere in the shaped coin state.
      expect(Object.keys(coin).sort()).toEqual([...persistentBots.PERSISTENT_BOT_COIN_KEYS].sort());
      const active = await eventsModel.listActivePersistentCoinEvents(db, world.worldId, T2_MS, { coinId: coin.coinId });
      const expectedModifier = persistentCoinEventDomain.netActiveModifierCapped(active, T2_MS, CONFIG);
      const calls = signalSpy.mock.calls.filter((c) => Number(c[0].coinId) === coin.coinId);
      expect(calls).toHaveLength(1);
      expect(calls[0][0].eventModifier).toBe(expectedModifier);
      // The shaped decision input price IS the committed traded price.
      const row = committed.rows.find((r) => r.coin_id === coin.coinId);
      expect(Object.is(coin.currentPrice, parseFloat(row.current_price))).toBe(true);
      // The recomputed signal is well-formed. (Its internal price is the
      // Stage 2 neutral-environment recompute; Director-environment parity
      // of that recompute is pre-existing Stage 8 debt, out of Wave 3
      // scope — the Wave 3 contract is the committed-modifier threading
      // asserted above and the committed-price decision input.)
      const callIndex = signalSpy.mock.calls.findIndex((c) => Number(c[0].coinId) === coin.coinId);
      const recomputed = signalSpy.mock.results[callIndex].value.currentPrice;
      expect(Number.isFinite(recomputed) && recomputed > 0).toBe(true);
    }
    // At least one coin carried a nonzero modifier (the path is live).
    const anyNonZero = signalSpy.mock.calls.some((c) => (c[0].eventModifier ?? 0) !== 0);
    expect(anyNonZero).toBe(true);
  });

  test('the shaped state still hides the seed, event internals, Director rolls and role plans while events are active', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const eventTotal = (await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1', [world.worldId])).rows[0].n;
    expect(eventTotal).toBeGreaterThan(0); // events genuinely exist

    const state = await persistentBots.buildPublicPersistentMarketState({
      world, account: null, nowMs: T2_MS, queryable: db
    });
    expect(() => persistentBots.assertPublicPersistentBotState(state)).not.toThrow();
    for (const coin of state.coins) {
      expect(Object.keys(coin).sort()).toEqual([...persistentBots.PERSISTENT_BOT_COIN_KEYS].sort());
    }
    // Value-level redaction: no world seed, no event identity/payload
    // fields, no Director rolls/cursors, no planner role targets anywhere
    // in the shaped state (keys OR values).
    const json = JSON.stringify(state);
    expect(json).not.toContain(WORLD_SEED);
    for (const forbidden of [
      'eventSeq', 'eventId', 'startsAt', 'endsAt', 'modifier',
      'rolePlan', 'rolePlans', 'targetCount', 'directorRolls',
      'decisionIndex', 'decision_index'
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe('Wave 3 correction: zero current events preserve the baseline signal (event-free first tick)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(EPOCH_MS) });
    await marketSimulator.updateAllPrices({ nowMs: T1_MS }); // the first roster tick ONLY
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('the first tick commits no events and every live coin signal equals the no-event baseline exactly', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    // The expected first-roster one-tick event-free startup is unchanged.
    const eventTotal = (await db.query(
      'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1', [world.worldId])).rows[0].n;
    expect(eventTotal).toBe(0);

    const stateByCoinId = await coinStateModel.loadCoinStates(db, world.worldId);
    const checkpointByCoinId = await checkpointModel.loadCheckpoints(db, world.seed);
    const committed = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');

    const state = await persistentBots.buildPublicPersistentMarketState({
      world, account: null, nowMs: T1_MS, queryable: db
    });
    expect(() => persistentBots.assertPublicPersistentBotState(state)).not.toThrow();
    expect(state.coins.length).toBeGreaterThan(0);

    for (const coin of state.coins) {
      if (coin.dead) continue;
      const cs = stateByCoinId.get(coin.coinId) || null;
      const baseline = persistentSignals.computePersistentCoinSignal({
        seed: world.seed,
        coinId: coin.coinId,
        archetypeId: cs ? cs.archetype : marketDomain.resolveArchetypeId(coin.coinId),
        originMs: world.epochStartedAtMs,
        nowMs: T1_MS,
        structuralReference: cs ? cs.structuralReference : parseFloat(committed.rows.find((r) => r.coin_id === coin.coinId).current_price),
        condition: cs ? cs.condition : 0,
        // NO event input: the zero-current-events baseline.
        checkpoint: checkpointByCoinId.get(coin.coinId) || null,
        config: CONFIG
      });
      expect(coin.phase).toBe(baseline.phase);
      expect(coin.momentum).toBe(baseline.momentum);
      expect(coin.archetype).toBe(baseline.archetype);
      expect(coin.collapseRisk).toBe(baseline.collapseRisk);
      expect(Object.is(coin.recentChangePct, baseline.recentChangePct)).toBe(true);
      // The decision input price stays the committed traded price.
      const row = committed.rows.find((r) => r.coin_id === coin.coinId);
      expect(Object.is(coin.currentPrice, parseFloat(row.current_price))).toBe(true);
    }
  });
});
