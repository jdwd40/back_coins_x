// Director Coin Events Wave 2: the bounded current-market observation
// (game/adaptiveDirectorObservation.js) against the REAL disposable test
// database.
//
// Covered:
//   * the exact persisted-source definition: live coins come from
//     market_coin_state (status ALIVE) joined to the non-retired coins
//     catalogue rows; movement/breadth/meaningful movement come ONLY from
//     persistent price_history ticks (source='MARKET_TICK' AND
//     cycle_id IS NULL) inside the bounded lookback, clipped at the world
//     epoch; deaths/replacements come from market_coin_state.died_at and
//     market_coin_state.created_at inside their windows; the macro regime
//     resumes from the committed market_director_state cursor (or the
//     genesis walk).
//   * boundedness: ticks older than the lookback window or older than the
//     world epoch contribute nothing;
//   * determinism: two builds at the same instant are identical;
//   * the observation changes nothing (read-only).
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const coinStateModel = require('../models/marketCoinState.model');
const directorStateModel = require('../models/marketDirectorState.model');
const marketDirector = require('../game/marketDirector');
const { buildAdaptiveDirectorObservation } = require('../game/adaptiveDirectorObservation');
const { resolveSimulationConfig, MARKET_PHASE_IDS } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const CONFIG = resolveSimulationConfig();
const WORLD_SEED = 'wave2-observation-test-seed';
const EPOCH_MS = Date.parse('2026-08-31T00:00:00.000Z');
const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');
const MINUTE = 60 * 1000;

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(EPOCH_MS) });
}

async function openCoinState(world, coinId, { condition = 0, peakReference = 2, structuralReference = 1 } = {}) {
  await coinStateModel.upsertCoinState(db, {
    coinId,
    worldId: world.worldId,
    archetype: 'ZIP',
    condition,
    structuralReference,
    peakReference,
    status: 'ALIVE',
    diedAt: null
  });
}

async function setPrice(coinId, price) {
  await db.query('UPDATE coins SET current_price = $2 WHERE coin_id = $1', [coinId, price]);
}

async function tick(coinId, price, atMs, source = 'MARKET_TICK') {
  await db.query(
    `INSERT INTO price_history (coin_id, cycle_id, price, created_at, source)
     VALUES ($1, NULL, $2, $3, $4)`,
    [coinId, price, new Date(atMs).toISOString(), source]
  );
}

async function standardFixture(world) {
  // Six live coins with explicit conditions/peaks and fixed prices.
  const conditions = { 1: 0.1, 2: -0.4, 3: 0.0, 4: -0.7, 5: 0.2, 6: -0.1 };
  const peaks = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2 };
  const prices = { 1: 1.9, 2: 1.8, 3: 1.9, 4: 1.5, 5: 2.0, 6: 1.9 };
  for (const coinId of [1, 2, 3, 4, 5, 6]) {
    await openCoinState(world, coinId, { condition: conditions[coinId], peakReference: peaks[coinId] });
    await setPrice(coinId, prices[coinId]);
  }
  // In-window ticks (lookback = 30m before BASE_MS).
  await tick(1, 1.00, BASE_MS - 20 * MINUTE);
  await tick(1, 1.03, BASE_MS - 12 * MINUTE); // +3.0% vs previous tick: meaningful
  await tick(1, 1.01, BASE_MS - 5 * MINUTE);  // -1.9% vs previous: not meaningful
  await tick(2, 2.00, BASE_MS - 20 * MINUTE);
  await tick(2, 2.02, BASE_MS - 5 * MINUTE);  // +1.0%
  await tick(3, 1.00, BASE_MS - 20 * MINUTE);
  await tick(3, 0.98, BASE_MS - 5 * MINUTE);  // -2.0%: meaningful (at threshold)
  // Coins 4-6: no in-window ticks (flat, null movement).
}

describe('Wave 2 observation: persisted-source definition and boundedness', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('live coins, movement, breadth, health and drawdown come from the documented persisted sources', async () => {
    const world = await provisionedWorld();
    await standardFixture(world);

    const obs = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });

    expect(obs.nowMs).toBe(BASE_MS);
    expect(obs.liveCoinCount).toBe(6);
    expect(obs.coins.map((c) => c.coinId)).toEqual([1, 2, 3, 4, 5, 6]);
    // Per-coin movement over the bounded lookback (last/first - 1).
    expect(obs.coins[0].movementPct).toBeCloseTo(0.01, 10);   // 1.01/1.00 - 1
    expect(obs.coins[1].movementPct).toBeCloseTo(0.01, 10);   // 2.02/2.00 - 1
    expect(obs.coins[2].movementPct).toBeCloseTo(-0.02, 10);  // 0.98/1.00 - 1
    expect(obs.coins[3].movementPct).toBeNull();
    expect(obs.coins[4].movementPct).toBeNull();
    expect(obs.coins[5].movementPct).toBeNull();
    // Conditions and peaks come from market_coin_state; price from coins.
    expect(obs.coins[1].condition).toBeCloseTo(-0.4, 10);
    expect(obs.coins[3].condition).toBeCloseTo(-0.7, 10);
    expect(obs.coins[0].peakReference).toBeCloseTo(2, 10);
    expect(obs.coins[0].currentPrice).toBeCloseTo(1.9, 10);
    // Breadth at breadthThresholdPct = 0.005: coins 1,2 rising; coin 3
    // falling; 4-6 flat (null movement counts as flat).
    expect(obs.breadth).toEqual({ rising: 2, falling: 1, flat: 3 });
    // Median of the observed movements [0.01, 0.01, -0.02] = 0.01.
    expect(obs.medianMovementPct).toBeCloseTo(0.01, 10);
    // Broad movement: mean of observed movements.
    expect(obs.broadMovementPct).toBeCloseTo((0.01 + 0.01 - 0.02) / 3, 10);
    // Drawdown: mean of max(0, 1 - price/peak) over live coins.
    const expectedDrawdown = (0.05 + 0.1 + 0.05 + 0.25 + 0 + 0.05) / 6;
    expect(obs.drawdownPct).toBeCloseTo(expectedDrawdown, 10);
    // Weak (condition <= -0.3): coins 2, 4. Distressed (<= -0.6): coin 4.
    expect(obs.weakCount).toBe(2);
    expect(obs.distressedCount).toBe(1);
    expect(obs.recentDeathCount).toBe(0);
    expect(obs.recentDeaths).toEqual([]);
    // Meaningful movement: coin 1's +3.0% at BASE-12m and coin 3's -2.0%
    // at BASE-5m qualify; the latest wins.
    expect(obs.lastMeaningfulMovementAtMs).toBe(BASE_MS - 5 * MINUTE);
  });

  test('ticks outside the bounded lookback or before the world epoch contribute nothing', async () => {
    const world = await provisionedWorld();
    await openCoinState(world, 1);
    await setPrice(1, 1.0);
    // A huge move ENTIRELY before the lookback window: ignored.
    await tick(1, 10.00, BASE_MS - 90 * MINUTE);
    await tick(1, 1.00, BASE_MS - 20 * MINUTE);
    await tick(1, 1.01, BASE_MS - 5 * MINUTE);
    const obs = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });
    expect(obs.coins[0].movementPct).toBeCloseTo(0.01, 10);
    expect(obs.lastMeaningfulMovementAtMs).toBeNull();

    // Now evaluate at EPOCH + 10m: the lookback start is clipped at the
    // epoch, so a tick 5 minutes BEFORE the epoch is invisible.
    const youngNow = EPOCH_MS + 10 * MINUTE;
    await tick(2, 50.00, EPOCH_MS - 5 * MINUTE);
    await openCoinState(world, 2);
    await tick(2, 2.00, youngNow - 8 * MINUTE);
    await tick(2, 2.02, youngNow - 2 * MINUTE);
    const young = await buildAdaptiveDirectorObservation(db, { world, nowMs: youngNow, config: CONFIG });
    const coin2 = young.coins.find((c) => c.coinId === 2);
    expect(coin2.movementPct).toBeCloseTo(0.01, 10);
  });

  test('non-persistent ticks (COLLAPSE source) are excluded by the provenance filter', async () => {
    const world = await provisionedWorld();
    await openCoinState(world, 1);
    await setPrice(1, 1.0);
    await tick(1, 1.00, BASE_MS - 20 * MINUTE);
    await tick(1, 5.00, BASE_MS - 10 * MINUTE, 'COLLAPSE'); // ignored
    await tick(1, 1.01, BASE_MS - 5 * MINUTE);
    const obs = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });
    expect(obs.coins[0].movementPct).toBeCloseTo(0.01, 10);
    expect(obs.lastMeaningfulMovementAtMs).toBeNull();
  });

  test('deaths and replacements come from market_coin_state.died_at and market_coin_state.created_at inside their windows', async () => {
    const world = await provisionedWorld();
    await standardFixture(world);
    // Two deaths inside the death-cluster window; one outside.
    await coinStateModel.recordDeath(db, { coinId: 5, worldId: world.worldId, diedAt: new Date(BASE_MS - 10 * MINUTE).toISOString() });
    await coinStateModel.recordDeath(db, { coinId: 6, worldId: world.worldId, diedAt: new Date(BASE_MS - 20 * MINUTE).toISOString() });
    await db.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference, status, died_at)
       VALUES ($1, $2, 'ZIP', 0, 1, 1, 'DEAD', $3)`,
      [7, world.worldId, new Date(BASE_MS - 3 * 60 * MINUTE).toISOString()]
    );
    const obs = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });
    expect(obs.recentDeathCount).toBe(2);
    expect(obs.recentDeaths.map((d) => d.coinId).sort()).toEqual([5, 6]);
    // The dead coins leave the live set entirely.
    expect(obs.coins.map((c) => c.coinId)).toEqual([1, 2, 3, 4]);
    expect(obs.liveCoinCount).toBe(4);

    // A freshly created state row reads as a recent replacement (the
    // replacement runtime joins a coin to the world with a new
    // market_coin_state row).
    const { rows } = await db.query(
      `INSERT INTO coins (name, symbol, current_price, market_cap, circulating_supply, founder, cycle_baseline_price)
       VALUES ('Wave2 Replacement', 'W2R', 1.00, 1000, 1000, 'wave2-test', 1.00) RETURNING coin_id`,
      []
    );
    await db.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference, status, created_at, updated_at)
       VALUES ($1, $2, 'ZIP', 0, 1, 1, 'ALIVE', $3, $3)`,
      [rows[0].coin_id, world.worldId, new Date(BASE_MS - 5 * MINUTE).toISOString()]
    );
    const withReplacement = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });
    expect(withReplacement.recentReplacements).toEqual([
      { coinId: rows[0].coin_id, createdAtMs: BASE_MS - 5 * MINUTE }
    ]);
    // The seeded catalogue coins (created long before the window) are not
    // replacements.
    expect(withReplacement.recentReplacements.some((r) => r.coinId === 1)).toBe(false);
  });

  test('the macro regime resumes from the committed Director cursor, or the genesis walk when none exists', async () => {
    const world = await provisionedWorld();
    await standardFixture(world);

    // No committed cursor: the genesis walk from the world origin — must
    // match the deterministic chain's own position at BASE_MS exactly.
    const walker = marketDirector.createMarketDirectorProvider({
      seed: world.seed, originMs: world.epochStartedAtMs, config: CONFIG
    });
    const walked = walker.regimeAt(BASE_MS);
    const genesis = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });
    expect(MARKET_PHASE_IDS).toContain(genesis.macro.regime);
    expect(genesis.macro.regime).toBe(walked.regime);
    expect(genesis.macro.regimeIndex).toBe(walked.regimeIndex);
    expect(genesis.macro.intensity).toBe(walked.intensity);

    // Commit the chain position the deterministic walk reaches at BASE_MS;
    // the observation resumes from it and lands on the same regime.
    const provider = marketDirector.createMarketDirectorProvider({
      seed: world.seed, originMs: world.epochStartedAtMs, config: CONFIG
    });
    const located = provider.regimeAt(BASE_MS);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await directorStateModel.upsertDirectorState(client, {
        worldId: world.worldId,
        regime: located.regime,
        regimeStartedAt: new Date(located.startMs).toISOString(),
        intensity: located.intensity,
        regimeIndex: located.regimeIndex
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const resumed = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });
    expect(resumed.macro.regime).toBe(located.regime);
    expect(resumed.macro.regimeIndex).toBe(located.regimeIndex);
    expect(resumed.macro.intensity).toBe(located.intensity);
  });

  test('two builds at the same instant are identical, and building changes nothing', async () => {
    const world = await provisionedWorld();
    await standardFixture(world);
    const a = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });
    const b = await buildAdaptiveDirectorObservation(db, { world, nowMs: BASE_MS, config: CONFIG });
    expect(a).toEqual(b);
    // Read-only: no control state, no events, no price changes.
    expect((await db.query('SELECT count(*)::int AS n FROM director_control_state')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_coin_events')).rows[0].n).toBe(0);
    const prices = await db.query('SELECT coin_id, current_price FROM coins WHERE coin_id BETWEEN 1 AND 6 ORDER BY coin_id');
    expect(prices.rows.map((r) => Number(r.current_price))).toEqual([1.9, 1.8, 1.9, 1.5, 2.0, 1.9]);
  });
});
