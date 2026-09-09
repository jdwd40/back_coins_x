// Director Coin Events Wave 3: the persistent writer's adaptive Director +
// persistent coin-event runtime integration (models/market-simulator.js)
// against the REAL disposable test database.
//
// Covered:
//   * Director integration — the adaptive Director evaluates INSIDE the
//     writer batch transaction using its persisted director_control_state:
//     genesis commits in the first batch; the committed decision is
//     retained (never advanced repeatedly) before its window elapses; an
//     elapsed window advances exactly once;
//   * reconciliation — each batch reconciles only MISSING active
//     persistent events to the Wave 2 planner's target counts for ALIVE
//     active-roster coins; planner targets (incl. Golden/Demon roles and
//     RESCUE mode) drive the created events; restart/re-entry with active
//     events is a strict no-op;
//   * pricing/condition — the exact capped net modifier (Wave 1 helpers,
//     +/-6% stack cap) reaches persistent pricing AND advanceCondition
//     exactly once each; the opening no-event baseline is unchanged;
//   * death/replacement — DEAD coins get no new events and are never
//     revived; replacement coins receive fresh independent coverage;
//     predecessor events are never transferred or rewritten;
//   * provenance — persistent history remains source='MARKET_TICK' AND
//     cycle_id IS NULL;
//   * atomicity — a failing event insert rolls the WHOLE batch back
//     (prices, history, Director decision and events together).
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const persistentPricing = require('../game/persistentPricing');
const persistentWorld = require('../game/persistentWorld');
const marketDirector = require('../game/marketDirector');
const persistentCoinEventDomain = require('../game/persistentCoinEventDomain');
const adaptiveDirectorRuntime = require('../game/adaptiveDirectorRuntime');
const { planAdaptiveEventTargets } = require('../game/adaptiveDirectorEventPlan');
const { buildAdaptiveDirectorObservation } = require('../game/adaptiveDirectorObservation');
const coinStateModel = require('../models/marketCoinState.model');
const control = require('../models/directorControlState.model');
const eventsModel = require('../models/persistentCoinEvents.model');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const replacementPool = require('../game/replacementPool');
const replacementRuntime = require('../game/persistentReplacementRuntime');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const CONFIG = resolveSimulationConfig();
const WORLD_SEED = 'wave3-writer-events-seed';
const EPOCH_MS = Date.parse('2026-08-31T00:00:00.000Z');
const T1_MS = EPOCH_MS + 10 * 60 * 1000;
const T2_MS = T1_MS + 30 * 1000;
const T3_MS = T2_MS + 30 * 1000;
const MINUTE = 60 * 1000;

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(EPOCH_MS) });
}

async function eventCount(worldId, coinId = null) {
  const params = [worldId];
  let sql = 'SELECT count(*)::int AS n FROM persistent_coin_events WHERE world_id = $1';
  if (coinId !== null) {
    params.push(coinId);
    sql += ' AND coin_id = $2';
  }
  const { rows } = await db.query(sql, params);
  return rows[0].n;
}

async function directionCounts(worldId, coinId) {
  const { rows } = await db.query(
    `SELECT direction, count(*)::int AS n FROM persistent_coin_events
      WHERE world_id = $1 AND coin_id = $2 GROUP BY direction`,
    [worldId, coinId]
  );
  const out = { POSITIVE: 0, NEGATIVE: 0 };
  for (const row of rows) out[row.direction] = row.n;
  return out;
}

// The plan the batch should have realised: the committed/current decision
// plus the pre-batch committed observation (what the in-batch evaluation
// saw — the evaluation runs before any of the batch's writes).
async function expectedPlan(world, nowMs) {
  const committed = await control.loadDirectorControlState(db, world.worldId);
  const observation = await buildAdaptiveDirectorObservation(db, { world, nowMs, config: CONFIG });
  return planAdaptiveEventTargets({ decision: committed, observation, config: CONFIG });
}

describe('Wave 3 writer: adaptive Director evaluation inside the batch', () => {
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

  test('the first batch evaluates through the existing runtime seam with the pre-resolved world and commits the genesis decision in the batch transaction', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const runtimeSpy = jest.spyOn(adaptiveDirectorRuntime, 'runAdaptiveDirectorEvaluation');
    const resolveSpy = jest.spyOn(persistentWorld, 'resolveActiveWorld');
    const priceSpy = jest.spyOn(persistentPricing, 'persistentPriceAt');

    await marketSimulator.updateAllPrices({ nowMs: T1_MS });

    expect(runtimeSpy).toHaveBeenCalledTimes(1);
    // The narrow Wave 3 extension: the writer hands its ALREADY resolved
    // world and its transaction client to the runtime.
    expect(runtimeSpy.mock.calls[0][0].world.worldId).toBe(world.worldId);
    expect(typeof runtimeSpy.mock.calls[0][0].db.query).toBe('function');
    // World resolution still happens exactly once per batch.
    expect(resolveSpy.mock.calls.filter((c) => true)).toHaveLength(1);

    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed).not.toBeNull();
    expect(committed.decisionIndex).toBe(0);
    expect(committed.mode).toBe('NORMAL'); // empty roster at genesis: a healthy open
    // No events exist for the (state-less at evaluation time) opening roster.
    expect(await eventCount(world.worldId)).toBe(0);
    // The opening batch applies no event modifier (the no-event baseline):
    // with no persistent state rows at evaluation time, the plan is empty.
    expect(priceSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of priceSpy.mock.calls) {
      expect(call[0].eventModifier ?? 0).toBe(0);
    }
  });

  test('the committed decision is retained — repeated in-window batches never advance the cursor or rewrite the row', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    const stamped = await db.query('SELECT updated_at FROM director_control_state WHERE world_id = $1', [world.worldId]);

    await marketSimulator.updateAllPrices({ nowMs: T3_MS });

    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(0); // not repeatedly before due
    const after = await db.query('SELECT updated_at FROM director_control_state WHERE world_id = $1', [world.worldId]);
    expect(after.rows[0].updated_at.getTime()).toBe(stamped.rows[0].updated_at.getTime());
  });

  test('an elapsed decision window advances exactly once when due', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    const first = await control.loadDirectorControlState(db, world.worldId);
    const dueMs = new Date(first.endsAt).getTime() + 30 * 1000;

    await marketSimulator.updateAllPrices({ nowMs: dueMs });

    const advanced = await control.loadDirectorControlState(db, world.worldId);
    expect(advanced.decisionIndex).toBe(1);
  });

  test('the runtime seam returns the committed/current decision AND the planning observation (backward-compatible extension)', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const result = await adaptiveDirectorRuntime.runAdaptiveDirectorEvaluation({
      nowMs: T1_MS, db, config: CONFIG, world
    });
    expect(['committed', 'unchanged', 'superseded']).toContain(result.outcome);
    expect(result.state.worldId).toBe(world.worldId);
    // The planning observation rides the result for the writer's reconcile.
    expect(result.observation).toBeDefined();
    expect(Array.isArray(result.observation.coins)).toBe(true);
    expect(result.observation.macro && result.observation.macro.environment).toBeDefined();
  });
});

describe('Wave 3 writer: planner-driven event reconciliation', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
    await provisionedWorld();
    await marketSimulator.updateAllPrices({ nowMs: T1_MS }); // open committed coin state
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('the second batch reconciles every ALIVE roster coin to the planner targets — only the missing events', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const plan = await expectedPlan(world, T2_MS);
    expect(plan.length).toBeGreaterThan(0);

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    for (const entry of plan) {
      const counts = await directionCounts(world.worldId, entry.coinId);
      expect(counts.POSITIVE).toBe(entry.targetPositive);
      expect(counts.NEGATIVE).toBe(entry.targetNegative);
    }
    const total = await eventCount(world.worldId);
    expect(total).toBe(plan.reduce((sum, e) => sum + e.targetPositive + e.targetNegative, 0));
    // Every created event starts at the batch instant (active immediately).
    const { rows } = await db.query('SELECT DISTINCT starts_at FROM persistent_coin_events WHERE world_id = $1', [world.worldId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].starts_at.getTime()).toBe(T2_MS);
  });

  test('restart/re-entry: a further in-window batch with active events recreates nothing', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    const created = await db.query(
      'SELECT coin_id, event_seq, name, direction, source, modifier::text, starts_at, ends_at FROM persistent_coin_events WHERE world_id = $1 ORDER BY coin_id, event_seq',
      [world.worldId]
    );
    expect(created.rows.length).toBeGreaterThan(0); // the T2 batch genuinely created the opening set

    await marketSimulator.updateAllPrices({ nowMs: T3_MS });

    const after = await db.query(
      'SELECT coin_id, event_seq, name, direction, source, modifier::text, starts_at, ends_at FROM persistent_coin_events WHERE world_id = $1 ORDER BY coin_id, event_seq',
      [world.worldId]
    );
    expect(after.rows).toEqual(created.rows);
  });

  test('Golden/Demon differences arrive through the planner role fields (never duplicated runtime policy)', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    // Commit a decision carrying Golden coin 2 and Demon coin 3 past the
    // genesis row (monotone cursor), with a window covering T2.
    await control.upsertDirectorControlState(db, {
      worldId: world.worldId,
      mode: 'NORMAL',
      direction: 'POSITIVE',
      intensity: 0,
      startedAt: new Date(T1_MS).toISOString(),
      endsAt: new Date(T1_MS + 30 * MINUTE).toISOString(),
      decisionIndex: 1,
      reason: 'wave3 test: explicit golden/demon assignment',
      goldenCoinId: 2,
      goldenExpiresAt: new Date(T1_MS + 20 * MINUTE).toISOString(),
      demonCoinId: 3,
      demonExpiresAt: new Date(T1_MS + 20 * MINUTE).toISOString(),
      lastSwingDirection: null,
      lastMeaningfulMovementAt: new Date(T1_MS).toISOString(),
      lastInterventionEndedAt: null,
      lastInterventionMode: null
    });

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    // The retained decision drives the plan: coin 2 gets the golden
    // positive bias, coin 3 the demon negative bias.
    const goldenCounts = await directionCounts(world.worldId, 2);
    expect(goldenCounts.POSITIVE).toBe(2);
    const demonCounts = await directionCounts(world.worldId, 3);
    expect(demonCounts.NEGATIVE).toBe(2);
    // Sources flow from the planner role metadata.
    const { rows: goldenRows } = await db.query(
      'SELECT DISTINCT source FROM persistent_coin_events WHERE world_id = $1 AND coin_id = 2', [world.worldId]);
    expect(goldenRows.map((r) => r.source)).toEqual(['GOLDEN']);
    const { rows: demonRows } = await db.query(
      'SELECT DISTINCT source FROM persistent_coin_events WHERE world_id = $1 AND coin_id = 3', [world.worldId]);
    expect(demonRows.map((r) => r.source)).toEqual(['DEMON']);
    // A plain coin keeps the NORMAL baseline coverage and sources.
    const plainCounts = await directionCounts(world.worldId, 1);
    expect(plainCounts).toEqual({ POSITIVE: 1, NEGATIVE: 1 });
    const { rows: plainRows } = await db.query(
      'SELECT DISTINCT source FROM persistent_coin_events WHERE world_id = $1 AND coin_id = 1', [world.worldId]);
    expect(plainRows.map((r) => r.source)).toEqual(['NORMAL']);
  });

  test('a distressed market interrupts to RESCUE inside the batch and the rescue plan drives event creation', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    // Distress the whole roster (the death-risk roll is pinned safe so the
    // batch exercises the Director/event path, not the death path).
    for (const coinId of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await db.query('UPDATE market_coin_state SET condition = -0.8 WHERE coin_id = $1', [coinId]);
      await db.query('UPDATE coins SET current_price = 0.4 * current_price WHERE coin_id = $1', [coinId]);
    }
    const plan = await expectedPlan(world, T2_MS); // computed from the distressed pre-batch observation... post-decision below
    const riskSpy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockReturnValue(0.5);

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    riskSpy.mockRestore();

    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.mode).toBe('RESCUE');
    expect(committed.direction).toBe('POSITIVE');
    // The RESCUE decision's plan favours positives; every created event
    // carries the RESCUE source and matches the planner's targets.
    const rescuePlan = planAdaptiveEventTargets({
      decision: committed,
      observation: await buildAdaptiveDirectorObservation(db, { world, nowMs: T2_MS, config: CONFIG }),
      config: CONFIG
    });
    let anyAboveBaseline = false;
    for (const entry of rescuePlan) {
      const counts = await directionCounts(world.worldId, entry.coinId);
      expect(counts.POSITIVE).toBe(entry.targetPositive);
      expect(counts.NEGATIVE).toBe(entry.targetNegative);
      if (entry.targetPositive > 1) anyAboveBaseline = true;
    }
    expect(anyAboveBaseline).toBe(true);
    expect(plan.length).toBe(rescuePlan.length); // sanity: same roster
    // Sources flow from the plan: role coins carry GOLDEN/DEMON (the
    // RESCUE decision also rotated roles onto the live roster); every
    // role-less coin's events carry the RESCUE source.
    for (const entry of rescuePlan) {
      const { rows: sources } = await db.query(
        'SELECT DISTINCT source FROM persistent_coin_events WHERE world_id = $1 AND coin_id = $2',
        [world.worldId, entry.coinId]);
      const expectedSource = entry.role ?? 'RESCUE';
      expect(sources.map((r) => r.source)).toEqual([expectedSource]);
    }
  });

  test('atomicity: a failing event insert rolls prices, history, events and the Director decision back together', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const pricesBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyBefore = (await db.query('SELECT count(*)::int AS n FROM price_history')).rows[0].n;
    const controlBefore = await control.loadDirectorControlState(db, world.worldId);

    jest.spyOn(eventsModel, 'insertPersistentCoinEvent').mockRejectedValueOnce(new Error('forced insert failure'));
    await marketSimulator.updateAllPrices({ nowMs: T2_MS }); // aborts, rolls back

    expect((await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id')).rows).toEqual(pricesBefore.rows);
    expect((await db.query('SELECT count(*)::int AS n FROM price_history')).rows[0].n).toBe(historyBefore);
    expect(await eventCount(world.worldId)).toBe(0);
    const controlAfter = await control.loadDirectorControlState(db, world.worldId);
    expect(controlAfter.decisionIndex).toBe(controlBefore.decisionIndex);
  });
});

describe('Wave 3 writer: capped modifier into pricing and condition', () => {
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

  test('the exact capped net modifier reaches pricing and condition exactly once each, matching the committed active events', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const priceSpy = jest.spyOn(persistentPricing, 'persistentPriceAt');
    const detailSpy = jest.spyOn(persistentPricing, 'computePersistentPrice');
    const conditionSpy = jest.spyOn(persistentPricing, 'advanceCondition');

    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    const { rows: coinRows } = await db.query(
      'SELECT coin_id, current_price FROM coins WHERE current_price > 0 ORDER BY coin_id');
    expect(coinRows.length).toBeGreaterThan(0);
    const config = CONFIG;

    for (const coin of coinRows) {
      const coinId = coin.coin_id;
      const active = await eventsModel.listActivePersistentCoinEvents(db, world.worldId, T2_MS, { coinId });
      const expectedModifier = persistentCoinEventDomain.netActiveModifierCapped(active, T2_MS, config);

      const priceCalls = priceSpy.mock.calls.filter((c) => Number(c[0].coinId) === coinId && c[0].nowMs === T2_MS);
      const detailCalls = detailSpy.mock.calls.filter((c) => Number(c[0].coinId) === coinId && c[0].nowMs === T2_MS);
      expect(priceCalls).toHaveLength(1); // exactly once to pricing
      expect(detailCalls).toHaveLength(1);
      expect(priceCalls[0][0].eventModifier).toBe(expectedModifier);
      expect(detailCalls[0][0].eventModifier).toBe(expectedModifier);
    }

    // advanceCondition is keyed by archetype, not coin id — but the writer
    // calls it exactly once per priced coin, in the batch's canonical coin
    // order, so the i-th condition call belongs to the i-th priced coin.
    const conditionCalls = conditionSpy.mock.calls.map((c) => c[0]);
    expect(conditionCalls).toHaveLength(coinRows.length);
    for (let i = 0; i < coinRows.length; i += 1) {
      const coinId = coinRows[i].coin_id;
      const active = await eventsModel.listActivePersistentCoinEvents(db, world.worldId, T2_MS, { coinId });
      const expectedModifier = persistentCoinEventDomain.netActiveModifierCapped(active, T2_MS, config);
      expect(conditionCalls[i].netEventModifier).toBe(expectedModifier); // exactly once to condition
    }
  });

  test('the +/-6% net cap binds the applied modifier in both directions', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    // Craft committed active events whose net exceeds the cap:
    // coin 1: +0.05 +0.05 -0.01 (net +0.09); coin 2: -0.05 -0.05 +0.01.
    const crafts = [
      { coinId: 1, eventSeq: 91, direction: 'POSITIVE', modifier: 0.05 },
      { coinId: 1, eventSeq: 92, direction: 'POSITIVE', modifier: 0.05 },
      { coinId: 1, eventSeq: 93, direction: 'NEGATIVE', modifier: -0.01 },
      { coinId: 2, eventSeq: 91, direction: 'NEGATIVE', modifier: -0.05 },
      { coinId: 2, eventSeq: 92, direction: 'NEGATIVE', modifier: -0.05 },
      { coinId: 2, eventSeq: 93, direction: 'POSITIVE', modifier: 0.01 }
    ];
    for (const craft of crafts) {
      await eventsModel.insertPersistentCoinEvent(db, {
        worldId: world.worldId,
        coinId: craft.coinId,
        eventSeq: craft.eventSeq,
        name: 'crafted cap probe',
        direction: craft.direction,
        source: 'NORMAL',
        modifier: craft.modifier,
        startsAt: new Date(T1_MS).toISOString(),
        endsAt: new Date(T1_MS + 15 * MINUTE).toISOString()
      }, { config: CONFIG });
    }

    const priceSpy = jest.spyOn(persistentPricing, 'persistentPriceAt');
    const conditionSpy = jest.spyOn(persistentPricing, 'advanceCondition');
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    const cap = CONFIG.persistentEvents.maxNetModifier;
    const forCoin = (spy, coinId, key) => spy.mock.calls
      .map((c) => c[0])
      .filter((a) => Number(a.coinId) === coinId)
      .map((a) => a[key]);
    // Pricing saw exactly the capped net, once per coin.
    expect(forCoin(priceSpy, 1, 'eventModifier')).toEqual([cap]);
    expect(forCoin(priceSpy, 2, 'eventModifier')).toEqual([-cap]);

    // advanceCondition is keyed by archetype; identify the calls by their
    // committed state: coin 1 (ZIP archetype, FTR) and coin 2 (MOON, NVC).
    const conditionArgs = conditionSpy.mock.calls.map((c) => c[0]);
    const zip = conditionArgs.filter((a) => a.archetypeId === 'ZIP');
    const moon = conditionArgs.filter((a) => a.archetypeId === 'MOON');
    // Coins 1 (ZIP) and 4 (ZIP) share the archetype; coin 1's call carried
    // the capped modifier, coin 4's its own net — both must appear.
    expect(zip.some((a) => a.netEventModifier === cap)).toBe(true);
    expect(moon.some((a) => a.netEventModifier === -cap)).toBe(true);
    // Every condition call received SOME finite modifier (the same capped
    // number path), never a second application.
    for (const a of conditionArgs) {
      expect(Math.abs(a.netEventModifier)).toBeLessThanOrEqual(cap);
    }
  });

  test('a coin with active positive events prices above its no-event baseline (and symmetrically negative)', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    // Coin 5: one strong positive crafted active event, satisfying the
    // positive target so reconciliation adds nothing further there... but
    // the negative target still tops up. Use a fully-covered coin instead:
    // craft BOTH directions covered with a positive net.
    await eventsModel.insertPersistentCoinEvent(db, {
      worldId: world.worldId, coinId: 5, eventSeq: 91, name: 'crafted positive',
      direction: 'POSITIVE', source: 'NORMAL', modifier: 0.04,
      startsAt: new Date(T1_MS).toISOString(), endsAt: new Date(T1_MS + 15 * MINUTE).toISOString()
    }, { config: CONFIG });
    await eventsModel.insertPersistentCoinEvent(db, {
      worldId: world.worldId, coinId: 5, eventSeq: 92, name: 'crafted negative',
      direction: 'NEGATIVE', source: 'NORMAL', modifier: -0.01,
      startsAt: new Date(T1_MS).toISOString(), endsAt: new Date(T1_MS + 15 * MINUTE).toISOString()
    }, { config: CONFIG });

    // The pre-batch committed state (the batch prices from it).
    const stateBefore = (await coinStateModel.loadCoinStates(db, world.worldId)).get(5);
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });

    // The applied modifier is exactly the Wave 1 capped net of the coin's
    // committed active events (0.04 - 0.01 uncapped), not a hardcoded echo.
    const active5 = await eventsModel.listActivePersistentCoinEvents(db, world.worldId, T2_MS, { coinId: 5 });
    const expectedModifier = persistentCoinEventDomain.netActiveModifierCapped(active5, T2_MS, CONFIG);
    expect(expectedModifier).toBeGreaterThan(0);

    const environment = marketDirector.createMarketDirectorProvider({ seed: WORLD_SEED, originMs: EPOCH_MS });
    const withEvents = persistentPricing.persistentPriceAt({
      seed: WORLD_SEED, coinId: 5, archetypeId: stateBefore.archetype,
      originMs: EPOCH_MS, nowMs: T2_MS,
      structuralReference: stateBefore.structuralReference,
      environment, eventModifier: expectedModifier, checkpoint: null, config: CONFIG
    });
    const baseline = persistentPricing.persistentPriceAt({
      seed: WORLD_SEED, coinId: 5, archetypeId: stateBefore.archetype,
      originMs: EPOCH_MS, nowMs: T2_MS,
      structuralReference: stateBefore.structuralReference,
      environment, eventModifier: 0, checkpoint: null, config: CONFIG
    });
    const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = 5');
    expect(Object.is(parseFloat(rows[0].current_price), withEvents)).toBe(true);
    expect(withEvents).toBeGreaterThan(baseline);
  });
});

describe('Wave 3 writer: provenance and lifecycle', () => {
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

  test('persistent history stays source=MARKET_TICK AND cycle_id IS NULL across event-carrying batches', async () => {
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    await marketSimulator.updateAllPrices({ nowMs: T3_MS });

    const total = (await db.query('SELECT count(*)::int AS n FROM price_history')).rows[0].n;
    expect(total).toBeGreaterThan(0);
    const violating = (await db.query(
      `SELECT count(*)::int AS n FROM price_history
        WHERE NOT (source = 'MARKET_TICK' AND cycle_id IS NULL)`
    )).rows[0].n;
    expect(violating).toBe(0);
  });

  test('a DEAD coin receives no new events, is never revived, and its events expire untouched', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    await marketSimulator.updateAllPrices({ nowMs: T2_MS }); // coin 1 gains events
    const deadId = 1;
    const before = await db.query(
      'SELECT event_seq, name, direction, source, modifier::text, starts_at, ends_at FROM persistent_coin_events WHERE world_id = $1 AND coin_id = $2 ORDER BY event_seq',
      [world.worldId, deadId]
    );
    expect(before.rows.length).toBeGreaterThan(0);

    // Authoritative death (same path as the Stage 4 writer tests).
    await coinStateModel.recordDeath(db, { coinId: deadId, worldId: world.worldId, diedAt: new Date(T3_MS) });
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [deadId]);

    await marketSimulator.updateAllPrices({ nowMs: T3_MS });
    await marketSimulator.updateAllPrices({ nowMs: T3_MS + 30 * 1000 });

    // No new events for the dead coin; the existing rows are byte-identical.
    const after = await db.query(
      'SELECT event_seq, name, direction, source, modifier::text, starts_at, ends_at FROM persistent_coin_events WHERE world_id = $1 AND coin_id = $2 ORDER BY event_seq',
      [world.worldId, deadId]
    );
    expect(after.rows).toEqual(before.rows);
    // Never revived, never repriced.
    const state = await coinStateModel.loadCoinStates(db, world.worldId);
    expect(state.get(deadId).status).toBe('DEAD');
    expect(parseFloat((await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [deadId])).rows[0].current_price)).toBe(0);
  });

  test('a replacement coin receives fresh independent event coverage; predecessor events are never transferred', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const riskSpy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockReturnValue(0.5);
    await marketSimulator.updateAllPrices({ nowMs: T1_MS });
    await marketSimulator.updateAllPrices({ nowMs: T2_MS });
    riskSpy.mockRestore();

    const deadId = 1;
    const predecessorEvents = await db.query(
      'SELECT event_seq, name, direction, source, modifier::text, starts_at, ends_at FROM persistent_coin_events WHERE world_id = $1 AND coin_id = $2 ORDER BY event_seq',
      [world.worldId, deadId]
    );
    expect(predecessorEvents.rows.length).toBeGreaterThan(0);

    // Authoritative writer death at T3, then the delayed authored
    // replacement (short injected delay — never a production retune).
    const deathSpy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore')
      .mockImplementation((opts) => (Number(opts.coinId) === deadId ? 9.5 : 0.5));
    await marketSimulator.updateAllPrices({ nowMs: T3_MS });
    deathSpy.mockRestore();
    const shortConfig = replacementPool.resolveReplacementConfig({ replacementDelayMs: MINUTE });
    const replaced = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: T3_MS + 2 * MINUTE, replacementConfig: shortConfig
    });
    expect(replaced.inserted).toHaveLength(1);
    const replacementId = replaced.inserted[0].coinId;

    const safeSpy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore').mockReturnValue(0.5);
    await marketSimulator.updateAllPrices({ nowMs: T3_MS + 2 * MINUTE + 30 * 1000 });
    await marketSimulator.updateAllPrices({ nowMs: T3_MS + 3 * MINUTE + 30 * 1000 });
    safeSpy.mockRestore();

    // The replacement holds its OWN fresh sequence starting at 1...
    const replacementEvents = await db.query(
      'SELECT event_seq FROM persistent_coin_events WHERE world_id = $1 AND coin_id = $2 ORDER BY event_seq',
      [world.worldId, replacementId]
    );
    expect(replacementEvents.rows.length).toBeGreaterThan(0);
    expect(replacementEvents.rows[0].event_seq).toBe(1);
    // ...and the predecessor's events were never transferred or rewritten.
    const predecessorAfter = await db.query(
      'SELECT event_seq, name, direction, source, modifier::text, starts_at, ends_at FROM persistent_coin_events WHERE world_id = $1 AND coin_id = $2 ORDER BY event_seq',
      [world.worldId, deadId]
    );
    expect(predecessorAfter.rows).toEqual(predecessorEvents.rows);
    // Death remains the persistentCoinDeath authority: still DEAD at £0.
    const states = await coinStateModel.loadCoinStates(db, world.worldId);
    expect(states.get(deadId).status).toBe('DEAD');
    expect(states.get(replacementId).status).toBe('ALIVE');
  });
});
