// Director Coin Events Wave 2: focused unit tests for the PURE adaptive
// Director decision domain (game/adaptiveDirector.js).
//
// The domain is pure: no database, no wall clock, no Math.random — the same
// (seed, state, observation, timestamp) inputs always produce the identical
// decision. Covered here:
//   * deterministic same-input decision equality and decision-index
//     variation (seeded stream keyed by the decision cursor);
//   * healthy markets keep NORMAL and are never forced into intervention
//     merely because a cadence elapsed;
//   * meaningful movement refreshes stagnation tracking; genuine prolonged
//     stagnation produces bounded BOOM/BUST swings inside the configured
//     duration/intensity bands;
//   * no pathological same-direction loop (anti-loop confirmation roll);
//   * severe drawdown / falling breadth / weak coins / death clusters /
//     prolonged depression favour RESCUE and suppress severe BUST;
//   * genesis safety: a first evaluation of an already dangerous/depressed
//     market opens bounded RESCUE (or the sustained-overheat correction)
//     immediately instead of waiting out the normal swing window; a healthy
//     first observation still opens NORMAL;
//   * overheating corrections only on sustained/extreme broad rises;
//   * RESCUE carries no per-coin immortality (the domain has no death or
//     replacement authority at all);
//   * Golden/Demon: zero-or-one, eligible-only, distinct, retained until
//     expiry, deterministic rotation, recent-death safety;
//   * expired interventions return naturally to NORMAL.
//
// Pure tests: no database rows (the jest.setup reseed still guards the
// disposable test database, but nothing here touches it).

const fs = require('fs');
const path = require('path');
const {
  evaluateAdaptiveDirectorDecision
} = require('../game/adaptiveDirector');
const { resolveSimulationConfig } = require('../game/simulationConfig');

const CONFIG = resolveSimulationConfig();
const WORLD_SEED = 'wave2-adaptive-director-test-seed';
const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');
const MINUTE = 60 * 1000;

function makeCoins(overrides = []) {
  const base = [
    { coinId: 1, archetype: 'ZIP', condition: 0.1, currentPrice: 1.0, peakReference: 1.1, structuralReference: 1.0, movementPct: 0.01 },
    { coinId: 2, archetype: 'MOON', condition: 0.2, currentPrice: 2.0, peakReference: 2.1, structuralReference: 2.0, movementPct: -0.01 },
    { coinId: 3, archetype: 'BULL', condition: 0.0, currentPrice: 1.5, peakReference: 1.6, structuralReference: 1.5, movementPct: 0.02 },
    { coinId: 4, archetype: 'HODL', condition: -0.1, currentPrice: 0.8, peakReference: 0.9, structuralReference: 0.85, movementPct: -0.02 },
    { coinId: 5, archetype: 'DEGEN', condition: 0.05, currentPrice: 3.0, peakReference: 3.1, structuralReference: 3.0, movementPct: 0.005 },
    { coinId: 6, archetype: 'RUG', condition: -0.05, currentPrice: 0.5, peakReference: 0.55, structuralReference: 0.5, movementPct: -0.005 }
  ];
  return base.map((coin, i) => ({ ...coin, ...(overrides[i] || {}) }));
}

function makeObservation(overrides = {}) {
  const coins = overrides.coins || makeCoins();
  return {
    liveCoinCount: coins.length,
    coins,
    breadth: { rising: 2, falling: 2, flat: 2 },
    medianMovementPct: 0.0025,
    broadMovementPct: 0.0008,
    drawdownPct: 0.07,
    weakCount: 0,
    distressedCount: 0,
    recentDeathCount: 0,
    recentDeaths: [],
    recentReplacements: [],
    lastMeaningfulMovementAtMs: BASE_MS - 5 * MINUTE,
    macro: {
      regime: 'BULL',
      regimeIndex: 4,
      intensity: 0.6,
      environment: {
        structuralBias: 0.02, volatilityScale: 1, positiveEventBias: 0.03,
        negativeEventBias: 0, eventSeverityScale: 1,
        crashProbabilityModifier: 0.95, recoveryModifier: 1.05, collapseRiskModifier: 0.95
      }
    },
    ...overrides
  };
}

function makeCommitted(overrides = {}) {
  return {
    mode: 'NORMAL',
    direction: 'POSITIVE',
    intensity: 0,
    startedAt: new Date(BASE_MS - 5 * MINUTE).toISOString(),
    endsAt: new Date(BASE_MS + 6 * MINUTE).toISOString(),
    decisionIndex: 3,
    reason: 'normal swing window',
    goldenCoinId: null,
    goldenExpiresAt: null,
    demonCoinId: null,
    demonExpiresAt: null,
    lastSwingDirection: 'NEGATIVE',
    lastMeaningfulMovementAt: new Date(BASE_MS - 5 * MINUTE).toISOString(),
    lastInterventionEndedAt: null,
    ...overrides
  };
}

function evaluate({ nowMs = BASE_MS, controlState = null, observation = makeObservation(), worldSeed = WORLD_SEED } = {}) {
  return evaluateAdaptiveDirectorDecision({
    worldSeed,
    nowMs,
    controlState,
    observation,
    config: CONFIG
  });
}

describe('Wave 2 adaptive Director: determinism contract', () => {
  test('identical inputs produce an identical decision, in full', () => {
    const a = evaluate();
    const b = evaluate();
    expect(a).toEqual(b);
  });

  test('the decision output carries every required field', () => {
    const { state } = evaluate();
    for (const field of [
      'mode', 'direction', 'intensity', 'startedAt', 'endsAt', 'decisionIndex',
      'reason', 'goldenCoinId', 'goldenExpiresAt', 'demonCoinId', 'demonExpiresAt',
      'lastSwingDirection', 'lastMeaningfulMovementAt', 'lastInterventionEndedAt'
    ]) {
      expect(state).toHaveProperty(field);
    }
    expect(['NORMAL', 'BOOM', 'BUST', 'RESCUE']).toContain(state.mode);
    expect(['POSITIVE', 'NEGATIVE']).toContain(state.direction);
    expect(state.intensity).toBeGreaterThanOrEqual(0);
    expect(state.intensity).toBeLessThanOrEqual(1);
    expect(new Date(state.endsAt).getTime()).toBeGreaterThan(new Date(state.startedAt).getTime());
  });

  test('the seeded stream varies by decision index but never uses Math.random', () => {
    // Force stagnation decisions at several consecutive decision indices:
    // the chained swings must not all be identical (seeded variation by
    // index), and the module source must not touch Math.random.
    const source = fs.readFileSync(path.join(__dirname, '../game/adaptiveDirector.js'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(executable).not.toMatch(/Math\.random/);

    let committed = null;
    const seen = new Set();
    const stagnantObservation = makeObservation({
      lastMeaningfulMovementAtMs: BASE_MS - 10 * 60 * MINUTE,
      broadMovementPct: 0,
      medianMovementPct: 0,
      breadth: { rising: 0, falling: 0, flat: 6 },
      coins: makeCoins().map((c) => ({ ...c, movementPct: 0 }))
    });
    let nowMs = BASE_MS;
    for (let i = 0; i < 8; i++) {
      const { state, changed } = evaluate({
        nowMs,
        controlState: committed,
        observation: stagnantObservation
      });
      expect(changed).toBe(true);
      seen.add(`${state.mode}:${state.direction}:${state.intensity}:${state.endsAt}`);
      committed = state;
      nowMs = new Date(state.endsAt).getTime() + MINUTE;
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('Wave 2 adaptive Director: NORMAL discipline and stagnation', () => {
  test('a healthy market mid-window keeps the committed NORMAL state unchanged (no cadence-forced intervention)', () => {
    const committed = makeCommitted();
    const { state, changed } = evaluate({ controlState: committed });
    expect(changed).toBe(false);
    expect(state).toEqual(committed);
    expect(state.mode).toBe('NORMAL');
  });

  test('an expired healthy NORMAL window recommits NORMAL inside the 8-14 minute swing target', () => {
    const committed = makeCommitted({ endsAt: new Date(BASE_MS - MINUTE).toISOString() });
    const { state, changed } = evaluate({ controlState: committed });
    expect(changed).toBe(true);
    expect(state.mode).toBe('NORMAL');
    expect(state.decisionIndex).toBe(4);
    const duration = new Date(state.endsAt).getTime() - new Date(state.startedAt).getTime();
    expect(duration).toBeGreaterThanOrEqual(CONFIG.directorControl.normalSwingTargetMs.min);
    expect(duration).toBeLessThanOrEqual(CONFIG.directorControl.normalSwingTargetMs.max);
    expect(state.intensity).toBe(0);
  });

  test('meaningful movement refreshes stagnation tracking even when the committed cursor is stale', () => {
    // The committed cursor claims the last movement was 90 minutes ago,
    // but the bounded observation saw meaningful movement 2 minutes ago:
    // the market is NOT stagnant, and the next committed decision carries
    // the refreshed timestamp forward.
    const committed = makeCommitted({
      endsAt: new Date(BASE_MS - MINUTE).toISOString(),
      lastMeaningfulMovementAt: new Date(BASE_MS - 90 * MINUTE).toISOString()
    });
    const observation = makeObservation({ lastMeaningfulMovementAtMs: BASE_MS - 2 * MINUTE });
    const { state } = evaluate({ controlState: committed, observation });
    expect(state.mode).toBe('NORMAL');
    expect(new Date(state.lastMeaningfulMovementAt).getTime()).toBe(BASE_MS - 2 * MINUTE);
  });

  test('genuine prolonged stagnation produces a bounded BOOM/BUST intervention', () => {
    const committed = makeCommitted({
      endsAt: new Date(BASE_MS - MINUTE).toISOString(),
      lastMeaningfulMovementAt: new Date(BASE_MS - 2 * 60 * MINUTE).toISOString()
    });
    const observation = makeObservation({
      lastMeaningfulMovementAtMs: BASE_MS - 2 * 60 * MINUTE,
      broadMovementPct: 0,
      medianMovementPct: 0,
      breadth: { rising: 0, falling: 0, flat: 6 },
      coins: makeCoins().map((c) => ({ ...c, movementPct: 0 }))
    });
    const { state, changed } = evaluate({ controlState: committed, observation });
    expect(changed).toBe(true);
    expect(['BOOM', 'BUST']).toContain(state.mode);
    const duration = new Date(state.endsAt).getTime() - new Date(state.startedAt).getTime();
    expect(duration).toBeGreaterThanOrEqual(CONFIG.directorControl.interventionDurationMs.min);
    expect(duration).toBeLessThanOrEqual(CONFIG.directorControl.interventionDurationMs.max);
    expect(state.intensity).toBeGreaterThan(0);
    expect(state.intensity).toBeLessThanOrEqual(1);
    expect(state.lastSwingDirection).toBe(state.mode === 'BOOM' ? 'POSITIVE' : 'NEGATIVE');
  });

  test('stagnation swings never loop pathologically in one direction', () => {
    // Chain stagnation evaluations (each carrying the last swing direction
    // forward), stepping one minute past every committed window. Under the
    // PR #36 refractory the swings are separated by bounded NORMAL windows;
    // across the refractory-separated swings the anti-loop confirmation
    // roll must still flip direction at least once. Deterministic for this
    // fixed seed set.
    let committed = null;
    const directions = [];
    let nowMs = BASE_MS;
    const stagnantObservation = makeObservation({
      lastMeaningfulMovementAtMs: BASE_MS - 10 * 60 * MINUTE,
      broadMovementPct: 0,
      medianMovementPct: 0,
      breadth: { rising: 0, falling: 0, flat: 6 },
      coins: makeCoins().map((c) => ({ ...c, movementPct: 0 }))
    });
    for (let i = 0; i < 120; i++) {
      const { state } = evaluate({
        nowMs,
        controlState: committed,
        observation: stagnantObservation,
        worldSeed: 'wave2-anti-loop-seed'
      });
      if (state.mode === 'BOOM' || state.mode === 'BUST') {
        directions.push(state.direction);
      }
      committed = state;
      nowMs = new Date(state.endsAt).getTime() + MINUTE;
    }
    expect(directions.length).toBeGreaterThan(10);
    expect(directions).toContain('POSITIVE');
    expect(directions).toContain('NEGATIVE');
  });
});

describe('Wave 2 adaptive Director: RESCUE and overheating', () => {
  function rescueObservation(overrides = {}) {
    const coins = makeCoins([
      { condition: -0.7, currentPrice: 0.6, peakReference: 1.2, movementPct: -0.05 },
      { condition: -0.65, currentPrice: 1.1, peakReference: 2.4, movementPct: -0.06 },
      { condition: -0.5, currentPrice: 0.9, peakReference: 1.7, movementPct: -0.04 },
      { condition: -0.4, currentPrice: 0.5, peakReference: 1.0, movementPct: -0.05 },
      { movementPct: -0.03 },
      { movementPct: -0.04 }
    ]);
    return makeObservation({
      coins,
      breadth: { rising: 0, falling: 6, flat: 0 },
      medianMovementPct: -0.045,
      broadMovementPct: -0.045,
      drawdownPct: 0.45,
      weakCount: 4,
      distressedCount: 2,
      ...overrides
    });
  }

  test('severe broad drawdown favours RESCUE (POSITIVE) and suppresses BUST even under stagnation', () => {
    const committed = makeCommitted({
      endsAt: new Date(BASE_MS - MINUTE).toISOString(),
      lastMeaningfulMovementAt: new Date(BASE_MS - 3 * 60 * MINUTE).toISOString(),
      lastSwingDirection: 'POSITIVE'
    });
    const { state } = evaluate({ controlState: committed, observation: rescueObservation() });
    expect(state.mode).toBe('RESCUE');
    expect(state.direction).toBe('POSITIVE');
    expect(state.intensity).toBeGreaterThan(0);
    expect(state.intensity).toBeLessThanOrEqual(1);
  });

  test('a death cluster favours RESCUE even without a broad drawdown', () => {
    const observation = makeObservation({
      recentDeathCount: CONFIG.directorControl.deathClusterCount,
      recentDeaths: [
        { coinId: 40, diedAtMs: BASE_MS - 10 * MINUTE },
        { coinId: 41, diedAtMs: BASE_MS - 20 * MINUTE }
      ]
    });
    const committed = makeCommitted({ endsAt: new Date(BASE_MS - MINUTE).toISOString() });
    const { state } = evaluate({ controlState: committed, observation });
    expect(state.mode).toBe('RESCUE');
  });

  test('prolonged depression (clustered critically weak condition) favours RESCUE', () => {
    const observation = makeObservation({
      distressedCount: 2,
      weakCount: 2,
      drawdownPct: 0.1,
      broadMovementPct: -0.01,
      medianMovementPct: -0.01,
      breadth: { rising: 1, falling: 3, flat: 2 }
    });
    const committed = makeCommitted({ endsAt: new Date(BASE_MS - MINUTE).toISOString() });
    const { state } = evaluate({ controlState: committed, observation });
    expect(state.mode).toBe('RESCUE');
  });

  test('RESCUE interrupts an active BUST intervention early', () => {
    const committed = makeCommitted({
      mode: 'BUST',
      direction: 'NEGATIVE',
      intensity: 0.5,
      endsAt: new Date(BASE_MS + 5 * MINUTE).toISOString()
    });
    const { state, changed } = evaluate({ controlState: committed, observation: rescueObservation() });
    expect(changed).toBe(true);
    expect(state.mode).toBe('RESCUE');
    expect(state.decisionIndex).toBe(committed.decisionIndex + 1);
  });

  test('an active intervention is retained when no override condition holds', () => {
    const committed = makeCommitted({
      mode: 'BOOM',
      direction: 'POSITIVE',
      intensity: 0.5,
      endsAt: new Date(BASE_MS + 5 * MINUTE).toISOString()
    });
    const { state, changed } = evaluate({ controlState: committed });
    expect(changed).toBe(false);
    expect(state).toEqual(committed);
  });

  test('an expired intervention returns naturally to NORMAL under healthy conditions', () => {
    const committed = makeCommitted({
      mode: 'BUST',
      direction: 'NEGATIVE',
      intensity: 0.5,
      endsAt: new Date(BASE_MS - MINUTE).toISOString(),
      lastSwingDirection: 'NEGATIVE'
    });
    const { state, changed } = evaluate({ controlState: committed });
    expect(changed).toBe(true);
    expect(state.mode).toBe('NORMAL');
    expect(state.lastSwingDirection).toBe('NEGATIVE');
  });

  test('only sustained extreme broad rises trigger a bounded negative correction; ordinary healthy rises do not', () => {
    const committed = makeCommitted({ endsAt: new Date(BASE_MS - MINUTE).toISOString() });
    // Ordinary healthy rise: +1.5% broad movement — no correction.
    const healthy = evaluate({
      controlState: committed,
      observation: makeObservation({
        broadMovementPct: 0.015,
        medianMovementPct: 0.015,
        breadth: { rising: 4, falling: 1, flat: 1 }
      })
    });
    expect(healthy.state.mode).toBe('NORMAL');

    // Sustained overheating: +12% broad rise with 5/6 coins rising.
    const hot = evaluate({
      controlState: committed,
      observation: makeObservation({
        broadMovementPct: 0.12,
        medianMovementPct: 0.11,
        breadth: { rising: 5, falling: 0, flat: 1 },
        drawdownPct: 0.0
      })
    });
    expect(hot.state.mode).toBe('BUST');
    expect(hot.state.direction).toBe('NEGATIVE');
    expect(hot.state.intensity).toBeGreaterThan(0);
    expect(hot.state.intensity).toBeLessThanOrEqual(1);
    const duration = new Date(hot.state.endsAt).getTime() - new Date(hot.state.startedAt).getTime();
    expect(duration).toBeLessThanOrEqual(CONFIG.directorControl.interventionDurationMs.max);
  });

  test('RESCUE carries no per-coin immortality: no protection fields, no death/replacement authority', () => {
    const { state } = evaluate({
      controlState: makeCommitted({ endsAt: new Date(BASE_MS - MINUTE).toISOString() }),
      observation: makeObservation({
        drawdownPct: 0.5,
        weakCount: 4,
        breadth: { rising: 0, falling: 5, flat: 1 },
        broadMovementPct: -0.06,
        medianMovementPct: -0.06
      })
    });
    expect(state.mode).toBe('RESCUE');
    // The decision shape carries no per-coin safety/immortality flags at
    // all — rescue is a market-wide intervention only.
    for (const key of Object.keys(state)) {
      expect(key).not.toMatch(/immortal|protected|safe/i);
    }
    const source = fs.readFileSync(path.join(__dirname, '../game/adaptiveDirector.js'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(executable).not.toMatch(/persistentCoinDeath|persistentReplacement|marketCoinState|require\(['"]\.\.\/db/);
    expect(executable).not.toMatch(/Date\.now|new Date\(\)/);
  });
});

describe('Wave 2 adaptive Director: Golden and Demon', () => {
  test('genesis assigns at most one Golden and one Demon, both live and distinct', () => {
    const { state } = evaluate();
    expect(state.goldenCoinId).not.toBeNull();
    expect(state.demonCoinId).not.toBeNull();
    expect(state.goldenCoinId).not.toBe(state.demonCoinId);
    const ids = makeCoins().map((c) => c.coinId);
    expect(ids).toContain(state.goldenCoinId);
    expect(ids).toContain(state.demonCoinId);
    expect(new Date(state.goldenExpiresAt).getTime()).toBeGreaterThan(BASE_MS);
    expect(new Date(state.demonExpiresAt).getTime()).toBeGreaterThan(BASE_MS);
  });

  test('valid committed roles are retained exactly (no reroll on restart or on later decisions)', () => {
    const genesis = evaluate();
    // Pin the role expiries far beyond the windows used below so the test
    // never depends on a particular seeded duration draw.
    const committed = {
      ...genesis.state,
      goldenExpiresAt: new Date(BASE_MS + 60 * MINUTE).toISOString(),
      demonExpiresAt: new Date(BASE_MS + 60 * MINUTE).toISOString()
    };
    // A later evaluation mid-window keeps the identical assignments.
    const later = evaluate({
      nowMs: BASE_MS + 2 * MINUTE,
      controlState: committed,
      observation: makeObservation({ lastMeaningfulMovementAtMs: BASE_MS + MINUTE })
    });
    expect(later.changed).toBe(false);
    expect(later.state.goldenCoinId).toBe(committed.goldenCoinId);
    expect(later.state.goldenExpiresAt).toBe(committed.goldenExpiresAt);
    // Even when a NEW decision is committed (window elapsed), unexpired
    // roles survive unchanged.
    const afterWindow = evaluate({
      nowMs: new Date(committed.endsAt).getTime() + MINUTE,
      controlState: committed,
      observation: makeObservation({ lastMeaningfulMovementAtMs: new Date(committed.endsAt).getTime() })
    });
    expect(afterWindow.changed).toBe(true);
    expect(afterWindow.state.goldenCoinId).toBe(committed.goldenCoinId);
    expect(afterWindow.state.goldenExpiresAt).toBe(committed.goldenExpiresAt);
    expect(afterWindow.state.demonCoinId).toBe(committed.demonCoinId);
  });

  test('expired roles rotate deterministically', () => {
    const genesis = evaluate();
    const expired = {
      ...genesis.state,
      goldenExpiresAt: new Date(BASE_MS - MINUTE).toISOString(),
      demonExpiresAt: new Date(BASE_MS - MINUTE).toISOString()
    };
    const nowMs = new Date(genesis.state.endsAt).getTime() + MINUTE;
    const observation = makeObservation({ lastMeaningfulMovementAtMs: nowMs - MINUTE });
    const a = evaluate({ nowMs, controlState: expired, observation });
    const b = evaluate({ nowMs, controlState: expired, observation });
    expect(a).toEqual(b);
    expect(a.state.goldenCoinId).not.toBeNull();
    expect(a.state.demonCoinId).not.toBeNull();
    expect(a.state.goldenCoinId).not.toBe(a.state.demonCoinId);
    expect(new Date(a.state.goldenExpiresAt).getTime()).toBeGreaterThan(nowMs);
  });

  test('a dead/retired (ineligible) role holder rotates out', () => {
    const genesis = evaluate();
    const coins = makeCoins().filter((c) => c.coinId !== genesis.state.goldenCoinId);
    const nowMs = new Date(genesis.state.endsAt).getTime() + MINUTE;
    const { state } = evaluate({
      nowMs,
      controlState: genesis.state,
      observation: makeObservation({ coins, liveCoinCount: coins.length, lastMeaningfulMovementAtMs: nowMs - MINUTE })
    });
    expect(state.goldenCoinId).not.toBe(genesis.state.goldenCoinId);
    expect(coins.map((c) => c.coinId)).toContain(state.goldenCoinId);
  });

  test('recent-death safety excludes freshly replaced coins and critically weak coins from Demon while active', () => {
    const weakId = 6;
    const replacementId = 5;
    const coins = makeCoins([
      { movementPct: 0.03 },
      { movementPct: 0.02 },
      { movementPct: 0.01 },
      { movementPct: -0.01 },
      { movementPct: 0.04 }, // the freshly replaced coin
      { condition: -0.8, movementPct: 0.05 } // critically weak
    ]);
    const observation = makeObservation({
      coins,
      recentDeathCount: 1,
      recentDeaths: [{ coinId: 44, diedAtMs: BASE_MS - 5 * MINUTE }],
      recentReplacements: [{ coinId: replacementId, createdAtMs: BASE_MS - 4 * MINUTE }]
    });
    // Sweep several decision indices: while safety is active the Demon must
    // never land on the freshly replaced or the critically weak coin.
    for (let index = 0; index < 12; index++) {
      const { state } = evaluate({ controlState: null, observation, worldSeed: `${WORLD_SEED}:safety:${index}` });
      expect(state.demonCoinId).not.toBe(replacementId);
      expect(state.demonCoinId).not.toBe(weakId);
    }
  });

  test('golden preference is underperforming-but-viable, never always the weakest', () => {
    // Coin 4 is the weakest mover; across seeds the Golden draw must vary
    // among the lower-half candidates instead of always picking coin 4.
    const picks = new Set();
    for (let i = 0; i < 16; i++) {
      const { state } = evaluate({ worldSeed: `${WORLD_SEED}:golden:${i}` });
      picks.add(state.goldenCoinId);
    }
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('Wave 2 adaptive Director: genesis safety policy', () => {
  test('genesis opens bounded RESCUE immediately when severe drawdown, a death cluster and weak-market signals are already present', () => {
    // No committed state at all: the very first evaluation of a currently
    // dangerous/depressed market must not wait out the normal swing window.
    const observation = makeObservation({
      coins: makeCoins([
        { condition: -0.7, currentPrice: 0.6, peakReference: 1.2, movementPct: -0.05 },
        { condition: -0.65, currentPrice: 1.1, peakReference: 2.4, movementPct: -0.06 },
        { condition: -0.5, currentPrice: 0.9, peakReference: 1.7, movementPct: -0.04 },
        { condition: -0.4, currentPrice: 0.5, peakReference: 1.0, movementPct: -0.05 },
        { movementPct: -0.03 },
        { movementPct: -0.04 }
      ]),
      breadth: { rising: 0, falling: 6, flat: 0 },
      medianMovementPct: -0.045,
      broadMovementPct: -0.045,
      drawdownPct: 0.45,
      weakCount: 4,
      recentDeathCount: CONFIG.directorControl.deathClusterCount,
      recentDeaths: [
        { coinId: 40, diedAtMs: BASE_MS - 10 * MINUTE },
        { coinId: 41, diedAtMs: BASE_MS - 20 * MINUTE }
      ]
    });
    const { state, changed } = evaluate({ controlState: null, observation });
    expect(changed).toBe(true);
    expect(state.mode).toBe('RESCUE');
    expect(state.direction).toBe('POSITIVE');
    expect(state.decisionIndex).toBe(0);
    // Bounded severity: [0.4, 1], bounded duration, market-wide only.
    expect(state.intensity).toBeGreaterThanOrEqual(0.4);
    expect(state.intensity).toBeLessThanOrEqual(1);
    const duration = new Date(state.endsAt).getTime() - new Date(state.startedAt).getTime();
    expect(duration).toBeGreaterThanOrEqual(CONFIG.directorControl.interventionDurationMs.min);
    expect(duration).toBeLessThanOrEqual(CONFIG.directorControl.interventionDurationMs.max);
    expect(state.reason).toMatch(/^rescue: /);
    expect(state.lastSwingDirection).toBe('POSITIVE');
    // Deterministic genesis roles still apply (and RESCUE protects no coin).
    expect(state.goldenCoinId).not.toBeNull();
    for (const key of Object.keys(state)) {
      expect(key).not.toMatch(/immortal|protected|safe/i);
    }
    // Determinism at cursor 0: identical replay.
    expect(evaluate({ controlState: null, observation })).toEqual({ state, changed });
  });

  test('genesis opens RESCUE on a death cluster alone (no drawdown, no weakness)', () => {
    const observation = makeObservation({
      recentDeathCount: CONFIG.directorControl.deathClusterCount,
      recentDeaths: [
        { coinId: 40, diedAtMs: BASE_MS - 10 * MINUTE },
        { coinId: 41, diedAtMs: BASE_MS - 20 * MINUTE }
      ]
    });
    const { state } = evaluate({ controlState: null, observation });
    expect(state.mode).toBe('RESCUE');
    expect(state.decisionIndex).toBe(0);
  });

  test('genesis allows the sustained overheat correction when its explicit condition is already present', () => {
    const observation = makeObservation({
      broadMovementPct: 0.12,
      medianMovementPct: 0.11,
      breadth: { rising: 5, falling: 0, flat: 1 },
      drawdownPct: 0.0
    });
    const { state } = evaluate({ controlState: null, observation });
    expect(state.mode).toBe('BUST');
    expect(state.direction).toBe('NEGATIVE');
    expect(state.decisionIndex).toBe(0);
    expect(state.intensity).toBeGreaterThan(0);
    expect(state.intensity).toBeLessThanOrEqual(0.6);
  });

  test('a healthy first observation still opens NORMAL (no forced genesis intervention)', () => {
    const { state, changed } = evaluate({ controlState: null });
    expect(changed).toBe(true);
    expect(state.mode).toBe('NORMAL');
    expect(state.intensity).toBe(0);
    expect(state.decisionIndex).toBe(0);
  });
});

describe('Wave 2 adaptive Director: idempotent re-evaluation', () => {
  test('re-evaluating with the just-committed state is a no-op (same index, identical payload)', () => {
    const first = evaluate();
    expect(first.changed).toBe(true);
    const second = evaluate({ controlState: first.state });
    expect(second.changed).toBe(false);
    expect(second.state).toEqual(first.state);
  });

  test('the genesis decision is NORMAL with decisionIndex 0', () => {
    const { state, changed } = evaluate();
    expect(changed).toBe(true);
    expect(state.decisionIndex).toBe(0);
    expect(state.mode).toBe('NORMAL');
    expect(state.lastSwingDirection).toBeNull();
    });
    });

    describe('Wave 2 adaptive Director: RESCUE trigger tightening (PR #36 correction)', () => {
    const expiredNormal = () => makeCommitted({ endsAt: new Date(BASE_MS - MINUTE).toISOString() });

    // A mild-decline roster: fallingCount coins at -0.6% (below the 2%
    // corroboration level), the rest flat; shallow drawdown; no weak,
    // distressed or death evidence.
    function mildDeclineObservation(liveCount, fallingCount) {
    const coins = [];
    for (let i = 1; i <= liveCount; i++) {
    coins.push({
      coinId: i, archetype: 'ZIP', condition: -0.05, currentPrice: 1, peakReference: 1.04,
      structuralReference: 1, movementPct: i <= fallingCount ? -0.006 : 0.001
    });
    }
    return makeObservation({
    coins,
    liveCoinCount: liveCount,
    breadth: { rising: 0, falling: fallingCount, flat: liveCount - fallingCount },
    medianMovementPct: -0.006,
    broadMovementPct: (fallingCount * -0.006 + (liveCount - fallingCount) * 0.001) / liveCount,
    drawdownPct: 0.04
    });
    }

    // A substantial-decline roster: fallingCount coins at -3%.
    function substantialDeclineObservation(liveCount, fallingCount) {
    const coins = [];
    for (let i = 1; i <= liveCount; i++) {
    coins.push({
      coinId: i, archetype: 'ZIP', condition: -0.1, currentPrice: 1, peakReference: 1.06,
      structuralReference: 1, movementPct: i <= fallingCount ? -0.03 : 0.001
    });
    }
    return makeObservation({
    coins,
    liveCoinCount: liveCount,
    breadth: { rising: 0, falling: fallingCount, flat: liveCount - fallingCount },
    medianMovementPct: -0.03,
    broadMovementPct: (fallingCount * -0.03 + (liveCount - fallingCount) * 0.001) / liveCount,
    drawdownPct: 0.06
    });
    }

    test('falling breadth alone does not rescue: 2/2 mildly down stays NORMAL', () => {
    const { state } = evaluate({ controlState: expiredNormal(), observation: mildDeclineObservation(2, 2) });
    expect(state.mode).toBe('NORMAL');
    });

    test('a 3-coin mild decline does not rescue', () => {
    const { state } = evaluate({ controlState: expiredNormal(), observation: mildDeclineObservation(3, 3) });
    expect(state.mode).toBe('NORMAL');
    });

    test('7/10 mild decline without corroboration stays NORMAL', () => {
    const { state } = evaluate({ controlState: expiredNormal(), observation: mildDeclineObservation(10, 7) });
    expect(state.mode).toBe('NORMAL');
    });

    test('7/10 substantial decline corroborates the falling breadth: RESCUE allowed', () => {
    const { state } = evaluate({ controlState: expiredNormal(), observation: substantialDeclineObservation(10, 7) });
    expect(state.mode).toBe('RESCUE');
    expect(state.direction).toBe('POSITIVE');
    expect(state.intensity).toBeGreaterThanOrEqual(0.4);
    expect(state.intensity).toBeLessThanOrEqual(1);
    expect(state.reason).toMatch(/^rescue: /);
    });

    test('severe drawdown remains independently capable of rescue', () => {
    const { state } = evaluate({
    controlState: expiredNormal(),
    observation: makeObservation({ drawdownPct: 0.3 })
    });
    expect(state.mode).toBe('RESCUE');
    });

    test('a weak/distressed cluster remains independently capable of rescue', () => {
    const { state } = evaluate({
    controlState: expiredNormal(),
    observation: makeObservation({
      weakCount: CONFIG.directorControl.rescueWeakCount,
      distressedCount: 1,
      drawdownPct: 0.08
    })
    });
    expect(state.mode).toBe('RESCUE');
    });

    test('a recent-death cluster remains independently capable of rescue over a mild market', () => {
    const { state } = evaluate({
    controlState: expiredNormal(),
    observation: mildDeclineObservation(6, 1)
      && makeObservation({
        recentDeathCount: CONFIG.directorControl.deathClusterCount,
        recentDeaths: [
          { coinId: 40, diedAtMs: BASE_MS - 10 * MINUTE },
          { coinId: 41, diedAtMs: BASE_MS - 20 * MINUTE }
        ]
      })
    });
    expect(state.mode).toBe('RESCUE');
    });

    test('small rosters cannot reach maximum severity from breadth alone', () => {
    // 2/2 substantially down: corroborated by magnitude, so RESCUE fires —
    // but the breadth component is roster-scaled (2 < 4), so severity stays
    // below the maximum the same evidence produces on a full roster.
    const small = evaluate({ controlState: expiredNormal(), observation: substantialDeclineObservation(2, 2) });
    expect(small.state.mode).toBe('RESCUE');
    expect(small.state.intensity).toBeLessThan(1);
    const full = evaluate({ controlState: expiredNormal(), observation: substantialDeclineObservation(10, 10) });
    expect(full.state.mode).toBe('RESCUE');
    expect(full.state.intensity).toBeGreaterThan(small.state.intensity);
    });
    });

    describe('Wave 2 adaptive Director: intervention hysteresis/refractory (PR #36 correction)', () => {
    const REFRACTORY_MS = CONFIG.directorControl.interventionRefractoryMs;
    const ENDED_MS = BASE_MS - MINUTE; // the prior intervention ended 1m ago

    function expiredIntervention(overrides = {}) {
      return makeCommitted({
        mode: 'BOOM',
        direction: 'POSITIVE',
        intensity: 0.5,
        startedAt: new Date(BASE_MS - 11 * MINUTE).toISOString(),
        endsAt: new Date(ENDED_MS).toISOString(),
        lastSwingDirection: 'POSITIVE',
        // The stagnation clock is stale: no market-wide meaningful movement
        // for hours, so the stagnation trigger is live at the expiry.
        lastMeaningfulMovementAt: new Date(BASE_MS - 10 * 60 * MINUTE).toISOString(),
        ...overrides
      });
    }

    function stagnantObservation() {
    return makeObservation({
    lastMeaningfulMovementAtMs: BASE_MS - 10 * 60 * MINUTE,
    broadMovementPct: 0,
    medianMovementPct: 0,
    breadth: { rising: 0, falling: 0, flat: 6 },
    coins: makeCoins().map((c) => ({ ...c, movementPct: 0 }))
    });
    }

    // Falling breadth corroborated by meaningful negative magnitude and a
    // corroborating drawdown — but NOT an emergency: no death cluster, no
    // severe drawdown.
    function ordinaryRescueObservation() {
    return makeObservation({
    breadth: { rising: 0, falling: 5, flat: 1 },
    medianMovementPct: -0.035,
    broadMovementPct: -0.03,
    drawdownPct: 0.12,
    coins: makeCoins().map((c) => ({ ...c, movementPct: -0.03 }))
    });
    }

    function overheatObservation() {
    return makeObservation({
    broadMovementPct: 0.12,
    medianMovementPct: 0.11,
    breadth: { rising: 5, falling: 0, flat: 1 },
    drawdownPct: 0
    });
    }

    test('an expired stagnation swing does not recommit immediately: a bounded NORMAL refractory window opens', () => {
    const { state, changed } = evaluate({ controlState: expiredIntervention(), observation: stagnantObservation() });
    expect(changed).toBe(true);
    expect(state.mode).toBe('NORMAL');
    expect(state.reason).toMatch(/refractory/i);
    expect(new Date(state.lastInterventionEndedAt).getTime()).toBe(ENDED_MS);
    const duration = new Date(state.endsAt).getTime() - new Date(state.startedAt).getTime();
    expect(duration).toBeGreaterThanOrEqual(CONFIG.directorControl.normalSwingTargetMs.min);
    expect(duration).toBeLessThanOrEqual(CONFIG.directorControl.normalSwingTargetMs.max);
    });

    test('continued stagnation triggers a swing again only after the refractory elapses', () => {
    const first = evaluate({ controlState: expiredIntervention(), observation: stagnantObservation() });
    expect(first.state.mode).toBe('NORMAL');
    // Still inside the refractory: another NORMAL window, not a swing.
    const midRefractory = evaluate({
    nowMs: ENDED_MS + REFRACTORY_MS - MINUTE,
    controlState: first.state,
    observation: stagnantObservation()
    });
    expect(midRefractory.state.mode).toBe('NORMAL');
    // Continued conditions MAY eventually trigger again (once both the
    // refractory and the current NORMAL window have elapsed).
    const afterRefractory = evaluate({
      nowMs: Math.max(
        new Date(midRefractory.state.endsAt).getTime(),
        ENDED_MS + REFRACTORY_MS
      ) + MINUTE,
      controlState: midRefractory.state,
      observation: stagnantObservation()
    });
    expect(['BOOM', 'BUST']).toContain(afterRefractory.state.mode);
    });

    test('an unchanged ordinary RESCUE does not recommit at expiry, but may return after the refractory', () => {
    const rescue = expiredIntervention({ mode: 'RESCUE', direction: 'POSITIVE' });
    const first = evaluate({ controlState: rescue, observation: ordinaryRescueObservation() });
    expect(first.state.mode).toBe('NORMAL');
    expect(first.state.reason).toMatch(/refractory/i);
    const after = evaluate({
    nowMs: ENDED_MS + REFRACTORY_MS + MINUTE,
    controlState: first.state,
    observation: ordinaryRescueObservation()
    });
    expect(after.state.mode).toBe('RESCUE');
    expect(after.state.direction).toBe('POSITIVE');
    });

    test('sustained overheat does not recommit BUST at every expiry', () => {
    const bust = expiredIntervention({ mode: 'BUST', direction: 'NEGATIVE', lastSwingDirection: 'NEGATIVE' });
    const first = evaluate({ controlState: bust, observation: overheatObservation() });
    expect(first.state.mode).toBe('NORMAL');
    const after = evaluate({
    nowMs: ENDED_MS + REFRACTORY_MS + MINUTE,
    controlState: first.state,
    observation: overheatObservation()
    });
    expect(after.state.mode).toBe('BUST');
    expect(after.state.intensity).toBeLessThanOrEqual(0.6);
    });

    test('a death-cluster emergency overrides the refractory, boundedly', () => {
    const rescue = expiredIntervention({ mode: 'RESCUE', direction: 'POSITIVE' });
    const emergency = makeObservation({
    recentDeathCount: CONFIG.directorControl.deathClusterCount,
    recentDeaths: [
      { coinId: 40, diedAtMs: BASE_MS - 5 * MINUTE },
      { coinId: 41, diedAtMs: BASE_MS - 8 * MINUTE }
    ]
    });
    const { state } = evaluate({ controlState: rescue, observation: emergency });
    expect(state.mode).toBe('RESCUE');
    // Bounded: one bounded window, never an unbounded chain commitment.
    const duration = new Date(state.endsAt).getTime() - new Date(state.startedAt).getTime();
    expect(duration).toBeGreaterThanOrEqual(CONFIG.directorControl.interventionDurationMs.min);
    expect(duration).toBeLessThanOrEqual(CONFIG.directorControl.interventionDurationMs.max);
    });

    test('an ordinary rescue cannot interrupt the refractory NORMAL window mid-window', () => {
    const rescue = expiredIntervention({ mode: 'RESCUE', direction: 'POSITIVE' });
    const first = evaluate({ controlState: rescue, observation: ordinaryRescueObservation() });
    expect(first.state.mode).toBe('NORMAL');
    const mid = evaluate({
    nowMs: BASE_MS + 2 * MINUTE,
    controlState: first.state,
    observation: ordinaryRescueObservation()
    });
    expect(mid.changed).toBe(false);
    expect(mid.state.mode).toBe('NORMAL');
    });

    test('a death-cluster emergency still interrupts an active intervention even inside the refractory', () => {
    const bust = makeCommitted({
    mode: 'BUST',
    direction: 'NEGATIVE',
    intensity: 0.5,
    endsAt: new Date(BASE_MS + 5 * MINUTE).toISOString(),
    lastInterventionEndedAt: new Date(BASE_MS - 10 * MINUTE).toISOString()
    });
    const emergency = makeObservation({
    recentDeathCount: CONFIG.directorControl.deathClusterCount,
    recentDeaths: [
      { coinId: 40, diedAtMs: BASE_MS - 5 * MINUTE },
      { coinId: 41, diedAtMs: BASE_MS - 8 * MINUTE }
    ]
    });
    const { state, changed } = evaluate({ controlState: bust, observation: emergency });
    expect(changed).toBe(true);
    expect(state.mode).toBe('RESCUE');
    // The interrupted BUST ended NOW.
    expect(new Date(state.lastInterventionEndedAt).getTime()).toBe(BASE_MS);
    });

    test('long-horizon duty cycle: persistent flat/rescue/overheat conditions cannot chain interventions without NORMAL opportunities', () => {
    const HOURS = 12;
    const scenarios = [
    ['stagnation', stagnantObservation()],
    ['ordinary rescue', ordinaryRescueObservation()],
    ['overheat', overheatObservation()]
    ];
    for (const [label, observation] of scenarios) {
      let committed = null;
      let nowMs = BASE_MS;
      const modes = [];
      const decisions = [];
      for (let i = 0; i < HOURS * 60; i++) {
        const { state, changed } = evaluate({
          nowMs,
          controlState: committed,
          observation,
          worldSeed: `wave2-duty-${label}`
        });
        modes.push(state.mode);
        if (changed) decisions.push({ mode: state.mode, startedAt: state.startedAt });
        committed = state;
        nowMs += MINUTE;
      }
      const interventionTicks = modes.filter((mode) => mode !== 'NORMAL').length;
      const duty = interventionTicks / modes.length;
      // Bounded duty cycle: interventions never dominate the horizon...
      expect(duty).toBeLessThanOrEqual(0.5);
      // ...but continued conditions DO eventually retrigger.
      expect(duty).toBeGreaterThan(0);
      // No direct intervention->intervention transition without a NORMAL
      // opportunity. Collapse same-window recommits (role rotations share
      // the window's startedAt) before comparing adjacent decisions.
      const windows = decisions.filter((d, i) => i === 0 || d.startedAt !== decisions[i - 1].startedAt);
      for (let i = 1; i < windows.length; i++) {
        if (windows[i].mode !== 'NORMAL' && windows[i - 1].mode !== 'NORMAL') {
          throw new Error(`${label}: direct ${windows[i - 1].mode} -> ${windows[i].mode} transition at decision ${i}`);
        }
      }
    }
    });
    });

    describe('Wave 2 adaptive Director: Demon retention revalidation under recent-death safety (PR #36 correction)', () => {
    function committedWithRoles() {
    const genesis = evaluate();
    expect(genesis.state.demonCoinId).not.toBeNull();
    return {
    ...genesis.state,
    goldenExpiresAt: new Date(BASE_MS + 60 * MINUTE).toISOString(),
    demonExpiresAt: new Date(BASE_MS + 60 * MINUTE).toISOString()
    };
    }

    const safetyDeaths = () => ({ recentDeathCount: 1, recentDeaths: [{ coinId: 44, diedAtMs: BASE_MS + MINUTE }] });

    test('a retained Demon that became critically weak rotates out while safety is active', () => {
    const committed = committedWithRoles();
    const demonId = committed.demonCoinId;
    const coins = makeCoins().map((c) => (c.coinId === demonId ? { ...c, condition: -0.8 } : c));
    const { state, changed } = evaluate({
    nowMs: BASE_MS + 2 * MINUTE,
    controlState: committed,
    observation: makeObservation({ coins, ...safetyDeaths() })
    });
    expect(changed).toBe(true);
    expect(state.demonCoinId).not.toBe(demonId);
    // Safe candidates exist, so the rotated Demon is a safe target.
    expect(state.demonCoinId).not.toBeNull();
    const holder = coins.find((c) => c.coinId === state.demonCoinId);
    expect(holder.condition).toBeGreaterThan(CONFIG.directorControl.distressedConditionThreshold);
    // Golden retention is untouched.
    expect(state.goldenCoinId).toBe(committed.goldenCoinId);
    // Same window, next decision cursor.
    expect(state.endsAt).toBe(committed.endsAt);
    expect(state.decisionIndex).toBe(committed.decisionIndex + 1);
    });

    test('a retained Demon that was freshly replaced rotates out while safety is active', () => {
    const committed = committedWithRoles();
    const demonId = committed.demonCoinId;
    const { state } = evaluate({
    nowMs: BASE_MS + 2 * MINUTE,
    controlState: committed,
    observation: makeObservation({
      ...safetyDeaths(),
      recentReplacements: [{ coinId: demonId, createdAtMs: BASE_MS + MINUTE }]
    })
    });
    expect(state.demonCoinId).not.toBe(demonId);
    });

    test('a retained Demon that is merely LOSING is kept: the role stays dangerous', () => {
    const committed = committedWithRoles();
    const demonId = committed.demonCoinId;
    // Deeply negative movement but a HEALTHY condition: not unsafe.
    const coins = makeCoins().map((c) => (c.coinId === demonId ? { ...c, movementPct: -0.09 } : c));
    const { state, changed } = evaluate({
    nowMs: BASE_MS + 2 * MINUTE,
    controlState: committed,
    observation: makeObservation({ coins, ...safetyDeaths() })
    });
    expect(changed).toBe(false);
    expect(state.demonCoinId).toBe(demonId);
    });

    test('outside the safety window a critically weak Demon is still retained (role identity preserved)', () => {
    const committed = committedWithRoles();
    const demonId = committed.demonCoinId;
    const coins = makeCoins().map((c) => (c.coinId === demonId ? { ...c, condition: -0.8 } : c));
    const { state, changed } = evaluate({
    nowMs: BASE_MS + 2 * MINUTE,
    controlState: committed,
    observation: makeObservation({ coins })
    });
    expect(changed).toBe(false);
    expect(state.demonCoinId).toBe(demonId);
    });
    });
