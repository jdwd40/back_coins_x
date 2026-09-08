// Director Coin Events Wave 2: focused unit tests for the PURE event-count
// planning seam (game/adaptiveDirectorEventPlan.js).
//
// The seam maps an adaptive Director decision + macro environment +
// Golden/Demon role + the bounded per-coin observation to DESIRED active
// event counts per coin. It inserts nothing — it is a pure plan. Covered:
//   * normal healthy markets plan 1/1;
//   * BOOM/positive decisions bias positive, interpolated by intensity;
//   * BUST/negative decisions bias negative while retaining some positive;
//   * RESCUE favours broad positive without erasing negatives;
//   * Golden adds a positive bias, Demon a negative bias;
//   * the Wave 1 total/per-direction caps are never exceeded;
//   * determinism (same inputs, identical plan; no Math.random).
//
// Pure tests: no database rows.

const fs = require('fs');
const path = require('path');
const { planAdaptiveEventTargets } = require('../game/adaptiveDirectorEventPlan');
const { resolveSimulationConfig } = require('../game/simulationConfig');

const CONFIG = resolveSimulationConfig();
const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');
const MINUTE = 60 * 1000;

function makeCoins() {
  return [
    { coinId: 1, condition: 0.1, movementPct: 0.01 },
    { coinId: 2, condition: 0.2, movementPct: -0.01 },
    { coinId: 3, condition: 0.0, movementPct: 0.02 }
  ];
}

function makeObservation(overrides = {}) {
  return {
    coins: makeCoins(),
    macro: {
      regime: 'BULL',
      regimeIndex: 4,
      intensity: 0.6,
      environment: {
        structuralBias: 0.02, volatilityScale: 1, positiveEventBias: 0,
        negativeEventBias: 0, eventSeverityScale: 1,
        crashProbabilityModifier: 1, recoveryModifier: 1, collapseRiskModifier: 1
      }
    },
    ...overrides
  };
}

function makeDecision(overrides = {}) {
  return {
    mode: 'NORMAL',
    direction: 'POSITIVE',
    intensity: 0,
    startedAt: new Date(BASE_MS).toISOString(),
    endsAt: new Date(BASE_MS + 10 * MINUTE).toISOString(),
    decisionIndex: 3,
    reason: 'test decision',
    goldenCoinId: null,
    goldenExpiresAt: null,
    demonCoinId: null,
    demonExpiresAt: null,
    lastSwingDirection: null,
    lastMeaningfulMovementAt: null,
    ...overrides
  };
}

function planFor(coinId, plan) {
  return plan.find((entry) => entry.coinId === coinId);
}

describe('Wave 2 event plan: directional tendencies', () => {
  test('a normal healthy decision plans 1/1 for every live coin', () => {
    const plan = planAdaptiveEventTargets({ decision: makeDecision(), observation: makeObservation(), config: CONFIG });
    expect(plan).toHaveLength(3);
    for (const entry of plan) {
      expect(entry.targetPositive).toBe(1);
      expect(entry.targetNegative).toBe(1);
    }
    // Canonical ordering by coin id.
    expect(plan.map((e) => e.coinId)).toEqual([1, 2, 3]);
  });

  test('BOOM biases positive, interpolated by bounded intensity', () => {
    const calm = planAdaptiveEventTargets({
      decision: makeDecision({ mode: 'BOOM', intensity: 0 }),
      observation: makeObservation(),
      config: CONFIG
    });
    const full = planAdaptiveEventTargets({
      decision: makeDecision({ mode: 'BOOM', intensity: 1 }),
      observation: makeObservation(),
      config: CONFIG
    });
    expect(planFor(1, calm).targetPositive).toBe(1);
    expect(planFor(1, full).targetPositive).toBe(CONFIG.directorControl.maxTargetPositivePerCoin);
    // A mid intensity interpolates between the two, never exceeding caps.
    const mid = planAdaptiveEventTargets({
      decision: makeDecision({ mode: 'BOOM', intensity: 0.5 }),
      observation: makeObservation(),
      config: CONFIG
    });
    expect(planFor(1, mid).targetPositive).toBeGreaterThanOrEqual(1);
    expect(planFor(1, mid).targetPositive).toBeLessThanOrEqual(CONFIG.directorControl.maxTargetPositivePerCoin);
  });

  test('BUST biases negative but always retains some positive', () => {
    const plan = planAdaptiveEventTargets({
      decision: makeDecision({ mode: 'BUST', direction: 'NEGATIVE', intensity: 1 }),
      observation: makeObservation(),
      config: CONFIG
    });
    for (const entry of plan) {
      expect(entry.targetNegative).toBe(CONFIG.directorControl.maxTargetNegativePerCoin);
      expect(entry.targetPositive).toBeGreaterThanOrEqual(1);
    }
  });

  test('RESCUE favours broad positive without erasing negatives', () => {
    const plan = planAdaptiveEventTargets({
      decision: makeDecision({ mode: 'RESCUE', intensity: 1 }),
      observation: makeObservation(),
      config: CONFIG
    });
    for (const entry of plan) {
      expect(entry.targetPositive).toBe(CONFIG.directorControl.maxTargetPositivePerCoin);
      expect(entry.targetNegative).toBeGreaterThanOrEqual(1);
    }
  });

  test('the macro environment nudges the plan by at most one per direction', () => {
    const hotMacro = makeObservation({
      macro: {
        regime: 'BOOM', regimeIndex: 2, intensity: 0.8,
        environment: {
          structuralBias: 0.06, volatilityScale: 1.2, positiveEventBias: 0.3,
          negativeEventBias: -0.2, eventSeverityScale: 1.1,
          crashProbabilityModifier: 0.8, recoveryModifier: 1.2, collapseRiskModifier: 0.8
        }
      }
    });
    const neutral = planAdaptiveEventTargets({ decision: makeDecision(), observation: makeObservation(), config: CONFIG });
    const biased = planAdaptiveEventTargets({ decision: makeDecision(), observation: hotMacro, config: CONFIG });
    expect(planFor(1, biased).targetPositive).toBe(planFor(1, neutral).targetPositive + 1);
    expect(planFor(1, biased).targetNegative).toBe(Math.max(1, planFor(1, neutral).targetNegative - 1));
  });
});

describe('Wave 2 event plan: roles and caps', () => {
  test('Golden adds a positive bias and Demon adds a negative bias, carrying role metadata', () => {
    const plan = planAdaptiveEventTargets({
      decision: makeDecision({ goldenCoinId: 2, demonCoinId: 3 }),
      observation: makeObservation(),
      config: CONFIG
    });
    expect(planFor(2, plan).targetPositive).toBe(2);
    expect(planFor(2, plan).role).toBe('GOLDEN');
    expect(planFor(3, plan).targetNegative).toBe(2);
    expect(planFor(3, plan).role).toBe('DEMON');
    expect(planFor(1, plan).role).toBeNull();
    expect(planFor(1, plan).targetPositive).toBe(1);
  });

  test('combined BOOM + Golden + positive macro never exceeds the per-direction caps', () => {
    const plan = planAdaptiveEventTargets({
      decision: makeDecision({ mode: 'BOOM', intensity: 1, goldenCoinId: 1 }),
      observation: makeObservation({
        macro: {
          regime: 'GOLDEN_AGE', regimeIndex: 1, intensity: 0.9,
          environment: {
            structuralBias: 0.1, volatilityScale: 0.9, positiveEventBias: 0.4,
            negativeEventBias: -0.1, eventSeverityScale: 0.9,
            crashProbabilityModifier: 0.4, recoveryModifier: 1.4, collapseRiskModifier: 0.5
          }
        }
      }),
      config: CONFIG
    });
    for (const entry of plan) {
      expect(entry.targetPositive).toBeLessThanOrEqual(CONFIG.directorControl.maxTargetPositivePerCoin);
      expect(entry.targetPositive).toBeLessThanOrEqual(CONFIG.persistentEvents.maxActivePositivePerCoin);
      expect(entry.targetNegative).toBeLessThanOrEqual(CONFIG.directorControl.maxTargetNegativePerCoin);
      expect(entry.targetNegative).toBeLessThanOrEqual(CONFIG.persistentEvents.maxActiveNegativePerCoin);
      expect(entry.targetPositive + entry.targetNegative).toBeLessThanOrEqual(CONFIG.persistentEvents.maxActivePerCoin);
    }
  });

  test('the Wave 1 TOTAL cap trims the less-favoured direction first, never below one each', () => {
    const tight = resolveSimulationConfig({
      persistentEvents: { maxActivePerCoin: 3, maxActivePositivePerCoin: 3, maxActiveNegativePerCoin: 3 },
      directorControl: { maxTargetPositivePerCoin: 3, maxTargetNegativePerCoin: 3 }
    });
    const plan = planAdaptiveEventTargets({
      decision: makeDecision({ mode: 'BUST', direction: 'NEGATIVE', intensity: 1 }),
      observation: makeObservation(),
      config: tight
    });
    for (const entry of plan) {
      expect(entry.targetPositive + entry.targetNegative).toBeLessThanOrEqual(3);
      expect(entry.targetPositive).toBeGreaterThanOrEqual(1);
      // BUST favours negative: the negative side survives the trim.
      expect(entry.targetNegative).toBe(2);
      expect(entry.targetPositive).toBe(1);
    }
  });

  test('planning is deterministic and uses no Math.random', () => {
    const decision = makeDecision({ mode: 'BOOM', intensity: 0.5, goldenCoinId: 2 });
    const a = planAdaptiveEventTargets({ decision, observation: makeObservation(), config: CONFIG });
    const b = planAdaptiveEventTargets({ decision, observation: makeObservation(), config: CONFIG });
    expect(a).toEqual(b);
    for (const entry of a) {
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    const source = fs.readFileSync(path.join(__dirname, '../game/adaptiveDirectorEventPlan.js'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(executable).not.toMatch(/Math\.random|require\(['"]\.\.\/db|Date\.now|new Date\(\)/);
  });

  test('rejects a malformed decision or observation loudly', () => {
    expect(() => planAdaptiveEventTargets({
      decision: makeDecision({ mode: 'SIDEWAYS' }),
      observation: makeObservation(),
      config: CONFIG
    })).toThrow(/mode/);
    expect(() => planAdaptiveEventTargets({
      decision: makeDecision({ intensity: 2 }),
      observation: makeObservation(),
      config: CONFIG
    })).toThrow(/intensity/);
    expect(() => planAdaptiveEventTargets({
      decision: makeDecision(),
      observation: makeObservation({ coins: 'not-an-array' }),
      config: CONFIG
    })).toThrow(/coins/);
  });
});
