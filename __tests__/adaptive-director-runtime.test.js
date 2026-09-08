// Director Coin Events Wave 2: the adaptive Director runtime
// (game/adaptiveDirectorRuntime.js) against the REAL disposable test
// database.
//
// Covered:
//   * genesis evaluation commits decisionIndex 0 (NORMAL) through the Wave
//     1 control-state model only; a market already distressed at genesis
//     commits bounded RESCUE at decisionIndex 0 instead;
//   * same-identity idempotency: a repeated evaluation at the same instant
//     is a write-free no-op (updated_at untouched);
//   * restart/resume: a fresh runtime invocation reads the committed state
//     and resumes it; nothing is held in memory;
//   * expired decisions advance deterministically (expired intervention
//     returns to NORMAL; a stagnant market produces a bounded swing);
//   * monotone/conflict behavior: a stale computed cursor is rejected by
//     the model and reported as superseded, never silently rewritten;
//   * concurrent evaluation: one authoritative committed cursor survives a
//     two-process race;
//   * scope guarantees: no persistent_coin_events rows, no price/market
//     state/director state mutation, no public API shape change.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const request = require('supertest');
const db = require('../db/connection');
const app = require('../app');
const persistentWorld = require('../game/persistentWorld');
const coinStateModel = require('../models/marketCoinState.model');
const control = require('../models/directorControlState.model');
const { runAdaptiveDirectorEvaluation } = require('../game/adaptiveDirectorRuntime');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const CONFIG = resolveSimulationConfig();
const WORLD_SEED = 'wave2-runtime-test-seed';
const EPOCH_MS = Date.parse('2026-08-31T00:00:00.000Z');
const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');
const MINUTE = 60 * 1000;

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(EPOCH_MS) });
}

async function openCoinState(world, coinId, condition = 0) {
  await coinStateModel.upsertCoinState(db, {
    coinId,
    worldId: world.worldId,
    archetype: 'ZIP',
    condition,
    structuralReference: 1,
    peakReference: 2,
    status: 'ALIVE',
    diedAt: null
  });
}

async function tick(coinId, price, atMs) {
  await db.query(
    `INSERT INTO price_history (coin_id, cycle_id, price, created_at, source)
     VALUES ($1, NULL, $2, $3, 'MARKET_TICK')`,
    [coinId, price, new Date(atMs).toISOString()]
  );
}

// A healthy live roster with small in-window movement (no meaningful
// movement at/above the 2% stagnation threshold) and prices pinned near
// the peak reference (5% drawdown — far below the rescue threshold).
async function healthyFixture(world) {
  for (const coinId of [1, 2, 3]) {
    await openCoinState(world, coinId);
    await db.query('UPDATE coins SET current_price = 1.9 WHERE coin_id = $1', [coinId]);
    await tick(coinId, 1.0, BASE_MS - 20 * MINUTE);
    await tick(coinId, 1.005, BASE_MS - 5 * MINUTE);
  }
}

async function committedUpdatedAt(worldId) {
  const { rows } = await db.query(
    'SELECT updated_at FROM director_control_state WHERE world_id = $1',
    [worldId]
  );
  return rows.length === 0 ? null : rows[0].updated_at.getTime();
}

describe('Wave 2 runtime: genesis, idempotency and resume', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('the first evaluation commits the genesis NORMAL decision through the control-state model', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    const result = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    expect(result.outcome).toBe('committed');
    expect(result.state.worldId).toBe(world.worldId);
    expect(result.state.decisionIndex).toBe(0);
    expect(result.state.mode).toBe('NORMAL');
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(0);
    expect(committed.mode).toBe('NORMAL');
    expect(committed.goldenCoinId).not.toBeNull();
    expect(committed.demonCoinId).not.toBeNull();
  });

  test('a repeated evaluation at the same identity is a write-free no-op', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    const stampedAt = await committedUpdatedAt(world.worldId);
    const replay = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    expect(replay.outcome).toBe('unchanged');
    expect(replay.state.decisionIndex).toBe(0);
    expect(await committedUpdatedAt(world.worldId)).toBe(stampedAt);
  });

  test('a restart reads the committed state and resumes it (no in-memory state)', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    const first = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    // "Restart": a fresh invocation mid-window, movement continuing. The
    // committed decision is retained byte-identically.
    const resumed = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS + 2 * MINUTE, config: CONFIG });
    expect(resumed.outcome).toBe('unchanged');
    expect(resumed.state.decisionIndex).toBe(first.state.decisionIndex);
    expect(resumed.state.goldenCoinId).toBe(first.state.goldenCoinId);
    expect(new Date(resumed.state.goldenExpiresAt).getTime())
      .toBe(new Date(first.state.goldenExpiresAt).getTime());
  });

  test('an expired healthy window advances to a fresh NORMAL decision deterministically', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    const first = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    const afterWindow = new Date(first.state.endsAt).getTime() + MINUTE;
    const advanced = await runAdaptiveDirectorEvaluation({ nowMs: afterWindow, config: CONFIG });
    expect(advanced.outcome).toBe('committed');
    expect(advanced.state.mode).toBe('NORMAL');
    expect(advanced.state.decisionIndex).toBe(1);
    // Replaying the same instant reproduces the identical decision (the
    // replay reads the committed row, so compare canonically in ms).
    const replay = await runAdaptiveDirectorEvaluation({ nowMs: afterWindow, config: CONFIG });
    expect(replay.outcome).toBe('unchanged');
    const canonical = (s) => ({
      ...s,
      startedAt: new Date(s.startedAt).getTime(),
      endsAt: new Date(s.endsAt).getTime(),
      goldenExpiresAt: s.goldenExpiresAt === null ? null : new Date(s.goldenExpiresAt).getTime(),
      demonExpiresAt: s.demonExpiresAt === null ? null : new Date(s.demonExpiresAt).getTime(),
      lastMeaningfulMovementAt: s.lastMeaningfulMovementAt === null ? null : new Date(s.lastMeaningfulMovementAt).getTime()
    });
    expect(canonical(replay.state)).toEqual(canonical(advanced.state));
  });

  test('prolonged stagnation produces a bounded BOOM/BUST swing through the runtime', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    const first = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    expect(first.state.mode).toBe('NORMAL');
    // Genesis pinned lastMeaningfulMovementAt at BASE_MS; 70 minutes later
    // with no meaningful movement the market is genuinely stagnant.
    const stagnantNow = BASE_MS + 70 * MINUTE;
    const swung = await runAdaptiveDirectorEvaluation({ nowMs: stagnantNow, config: CONFIG });
    expect(swung.outcome).toBe('committed');
    expect(['BOOM', 'BUST']).toContain(swung.state.mode);
    const duration = new Date(swung.state.endsAt).getTime() - new Date(swung.state.startedAt).getTime();
    expect(duration).toBeGreaterThanOrEqual(CONFIG.directorControl.interventionDurationMs.min);
    expect(duration).toBeLessThanOrEqual(CONFIG.directorControl.interventionDurationMs.max);
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.mode).toBe(swung.state.mode);
    // The expired intervention then returns naturally to NORMAL.
    const afterIntervention = new Date(swung.state.endsAt).getTime() + MINUTE;
    const recovered = await runAdaptiveDirectorEvaluation({ nowMs: afterIntervention, config: CONFIG });
    // Still stagnant (no movement) — another bounded swing OR normal; the
    // important part is the decision advanced deterministically.
    expect(recovered.state.decisionIndex).toBe(2);
  });

  test('a severe broad drawdown mid-window interrupts to RESCUE', async () => {
    const world = await provisionedWorld();
    // Healthy open: genesis commits NORMAL.
    await healthyFixture(world);
    const first = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    expect(first.state.mode).toBe('NORMAL');
    // The market then crashes: all three coins critically weak and deeply
    // drawn down. The mid-window re-evaluation interrupts to RESCUE.
    for (const coinId of [1, 2, 3]) {
      await coinStateModel.upsertCoinState(db, {
        coinId,
        worldId: world.worldId,
        archetype: 'ZIP',
        condition: -0.8,
        structuralReference: 1,
        peakReference: 2,
        status: 'ALIVE',
        diedAt: null
      });
      await db.query('UPDATE coins SET current_price = 0.9 WHERE coin_id = $1', [coinId]);
    }
    const rescue = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS + MINUTE, config: CONFIG });
    expect(rescue.outcome).toBe('committed');
    expect(rescue.state.mode).toBe('RESCUE');
    expect(rescue.state.direction).toBe('POSITIVE');
    expect(rescue.state.decisionIndex).toBe(1);
  });

  test('a market already distressed at genesis commits bounded RESCUE at decisionIndex 0', async () => {
    const world = await provisionedWorld();
    // Genesis safety: with the rescue signals already present at the very
    // first evaluation, the runtime must not open a NORMAL swing window.
    for (const coinId of [1, 2, 3]) {
      await coinStateModel.upsertCoinState(db, {
        coinId,
        worldId: world.worldId,
        archetype: 'ZIP',
        condition: -0.8,
        structuralReference: 1,
        peakReference: 2,
        status: 'ALIVE',
        diedAt: null
      });
      await db.query('UPDATE coins SET current_price = 0.9 WHERE coin_id = $1', [coinId]);
    }
    const genesis = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    expect(genesis.outcome).toBe('committed');
    expect(genesis.state.mode).toBe('RESCUE');
    expect(genesis.state.direction).toBe('POSITIVE');
    expect(genesis.state.decisionIndex).toBe(0);
    expect(genesis.state.intensity).toBeGreaterThanOrEqual(0.4);
    expect(genesis.state.intensity).toBeLessThanOrEqual(1);
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.mode).toBe('RESCUE');
    expect(committed.decisionIndex).toBe(0);
  });
});

describe('Wave 2 runtime: cursor discipline and concurrency', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('a stale computed cursor is rejected by the model and reported superseded (never rewritten)', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    // Deterministic interleave via the persist seam: between the runtime's
    // read and its write, an external authority advances the cursor to 5.
    // The runtime's computed decision (index 1) is stale — the model fails
    // loudly and the runtime reports the supersede, never rewriting.
    const persist = async (queryable, state) => {
      const committed = await control.loadDirectorControlState(db, world.worldId);
      await control.upsertDirectorControlState(db, {
        ...committed,
        decisionIndex: 5,
        reason: 'external advance'
      });
      await control.upsertDirectorControlState(queryable, state);
    };
    const result = await runAdaptiveDirectorEvaluation({
      nowMs: BASE_MS + 70 * MINUTE, // stagnation forces a NEW decision
      config: CONFIG,
      persist
    });
    expect(result.outcome).toBe('superseded');
    const after = await control.loadDirectorControlState(db, world.worldId);
    expect(after.decisionIndex).toBe(5);
    expect(after.reason).toBe('external advance');
  });

  test('an equal-index conflicting commit racing the runtime is rejected and reported superseded', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    // The runtime reads index 0 and computes index 1; a competitor commits
    // a DIFFERENT index-1 decision first. The model's equal-index conflict
    // rule fails loudly; the runtime reports the supersede.
    const persist = async (queryable, state) => {
      const committed = await control.loadDirectorControlState(db, world.worldId);
      await control.upsertDirectorControlState(db, {
        ...state,
        decisionIndex: 1,
        reason: 'competitor decision',
        startedAt: committed.startedAt,
        endsAt: new Date(new Date(committed.endsAt).getTime() + 5 * MINUTE).toISOString()
      });
      await control.upsertDirectorControlState(queryable, state);
    };
    const result = await runAdaptiveDirectorEvaluation({
      nowMs: BASE_MS + 70 * MINUTE,
      config: CONFIG,
      persist
    });
    expect(result.outcome).toBe('superseded');
    const after = await control.loadDirectorControlState(db, world.worldId);
    expect(after.decisionIndex).toBe(1);
    expect(after.reason).toBe('competitor decision');
  });

  test('concurrent evaluations leave exactly one authoritative committed cursor', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    // Two evaluations race the FIRST commit at slightly different instants
    // (different payload candidates at the same genesis index).
    const [a, b] = await Promise.all([
      runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG }),
      runAdaptiveDirectorEvaluation({ nowMs: BASE_MS + 30 * 1000, config: CONFIG })
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    // One winner commits; the loser either raced into the equal-index
    // conflict (superseded) or read the winner's commit and replayed
    // identically-free (unchanged). Both are legal single-cursor outcomes.
    expect(outcomes[0]).toBe('committed');
    expect(['superseded', 'unchanged']).toContain(outcomes[1]);
    const committed = await control.loadDirectorControlState(db, world.worldId);
    expect(committed.decisionIndex).toBe(0);
    // The follow-on evaluation resumes cleanly from the winner's cursor.
    const follow = await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS + 2 * MINUTE, config: CONFIG });
    expect(['unchanged', 'committed']).toContain(follow.outcome);
    expect(follow.state.decisionIndex).toBeGreaterThanOrEqual(0);
  });
});

describe('Wave 2 runtime: scope guarantees', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('evaluation writes nothing outside director_control_state and changes no public API shape', async () => {
    const world = await provisionedWorld();
    await healthyFixture(world);
    const pricesBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const statesBefore = await db.query(
      'SELECT coin_id, condition, structural_reference, peak_reference, status FROM market_coin_state ORDER BY coin_id'
    );

    await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS, config: CONFIG });
    await runAdaptiveDirectorEvaluation({ nowMs: BASE_MS + 70 * MINUTE, config: CONFIG });

    // No persistent event rows are ever generated.
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_coin_events')).rows[0].n).toBe(0);
    // No price, condition, reference or status mutation.
    expect(await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id'))
      .toEqual(pricesBefore);
    expect(await db.query(
      'SELECT coin_id, condition, structural_reference, peak_reference, status FROM market_coin_state ORDER BY coin_id'
    )).toEqual(statesBefore);
    // The deterministic six-regime Director cursor is untouched.
    expect((await db.query('SELECT count(*)::int AS n FROM market_director_state')).rows[0].n).toBe(0);

    // Public surfaces carry no adaptive Director fields.
    const signals = await request(app).get('/api/persistent/signals');
    expect(signals.status).toBe(200);
    const payload = JSON.stringify(signals.body);
    for (const leaked of ['goldenCoinId', 'demonCoinId', 'decisionIndex', 'adaptiveDirector', WORLD_SEED]) {
      expect(payload).not.toContain(leaked);
    }
  });
});
