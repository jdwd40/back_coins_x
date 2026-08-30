// SIM-02: focused unit tests for game/simulationConfig.js.
//
// Pure configuration tests: no database rows, no production or development
// data (the jest.setup reseed still guards the disposable test database,
// but nothing here touches it). Covered:
//   * defaults are valid and match the specification's shape;
//   * boundary validation (ranges, caps, signs, ordering);
//   * probability/weight normalisation validation;
//   * immutability (deep freeze) of the default and resolved configs;
//   * override resolution semantics (merge, unknown-key rejection, no
//     silent coercion).

const {
  COIN_EVENT_STRENGTH_IDS,
  MARKET_PHASE_IDS,
  LIFECYCLE_STATE_IDS,
  COLLAPSE_INPUT_IDS,
  DEFAULT_SIMULATION_CONFIG,
  validateSimulationConfig,
  resolveSimulationConfig
} = require('../game/simulationConfig');

// Deep structural clone so validation tests can corrupt one leaf without
// ever mutating the frozen defaults.
function freshConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_SIMULATION_CONFIG));
}

describe('simulation config defaults', () => {
  test('the default config validates', () => {
    expect(validateSimulationConfig(freshConfig())).toBeDefined();
  });

  test('resolve with no overrides returns the frozen defaults', () => {
    expect(resolveSimulationConfig()).toBe(DEFAULT_SIMULATION_CONFIG);
    expect(resolveSimulationConfig(null)).toBe(DEFAULT_SIMULATION_CONFIG);
  });

  test('top-level shape is exactly the six sections', () => {
    expect(Object.keys(DEFAULT_SIMULATION_CONFIG).sort()).toEqual([
      'coinEvents', 'crashRally', 'dynamicCollapse', 'lifecycle',
      'marketPhases', 'tradingPressure'
    ]);
  });

  test('coin event defaults match the specification starting values', () => {
    const { coinEvents } = DEFAULT_SIMULATION_CONFIG;
    expect(coinEvents.durationMs).toEqual({ min: 60 * 1000, max: 15 * 60 * 1000 });
    expect(coinEvents.maxActivePerCoin).toBe(5);
    expect(coinEvents.maxStackedModifier).toBe(0.06);
    expect(coinEvents.negativeBiasFactor).toBeGreaterThanOrEqual(1.2);
    expect(coinEvents.negativeBiasFactor).toBeLessThanOrEqual(1.3);
    expect(Object.keys(coinEvents.strengthRanges)).toEqual([...COIN_EVENT_STRENGTH_IDS]);
  });

  test('market phase modifier ranges straddle zero by design sign', () => {
    const { phases } = DEFAULT_SIMULATION_CONFIG.marketPhases;
    expect(Object.keys(phases).sort()).toEqual([...MARKET_PHASE_IDS].sort());
    for (const id of ['GOLDEN_AGE', 'BOOM', 'BULL']) {
      expect(phases[id].modifier.min).toBeGreaterThan(0);
    }
    for (const id of ['BEAR', 'BUST', 'RECESSION']) {
      expect(phases[id].modifier.max).toBeLessThan(0);
    }
  });

  test('lifecycle phase weights exist for every lifecycle state and are normalised', () => {
    const { lifecycleWeights } = DEFAULT_SIMULATION_CONFIG.marketPhases;
    expect(Object.keys(lifecycleWeights).sort()).toEqual([...LIFECYCLE_STATE_IDS].sort());
    for (const state of LIFECYCLE_STATE_IDS) {
      const sum = Object.values(lifecycleWeights[state]).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    }
  });

  test('dynamic collapse input weights use the exact input vocabulary and are normalised', () => {
    const { inputWeights } = DEFAULT_SIMULATION_CONFIG.dynamicCollapse;
    expect(Object.keys(inputWeights).sort()).toEqual([...COLLAPSE_INPUT_IDS].sort());
    const sum = Object.values(inputWeights).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });
});

describe('simulation config boundary validation', () => {
  test('rejects an inverted range (min >= max)', () => {
    const config = freshConfig();
    config.coinEvents.durationMs = { min: 900000, max: 60000 };
    expect(() => validateSimulationConfig(config)).toThrow(/min < max/);
  });

  test('rejects non-integer or non-positive durations', () => {
    const fractional = freshConfig();
    fractional.coinEvents.durationMs.min = 1.5;
    expect(() => validateSimulationConfig(fractional)).toThrow(/positive integer/);

    const zero = freshConfig();
    zero.marketPhases.phases.BULL.durationMs = { min: 0, max: 60000 };
    expect(() => validateSimulationConfig(zero)).toThrow(/positive integer/);
  });

  test('rejects a positive range on a negative market phase and vice versa', () => {
    const config = freshConfig();
    config.marketPhases.phases.BEAR.modifier = { min: 0.005, max: 0.015 };
    expect(() => validateSimulationConfig(config)).toThrow(/strictly negative/);

    const config2 = freshConfig();
    config2.marketPhases.phases.BOOM.modifier = { min: -0.03, max: -0.015 };
    expect(() => validateSimulationConfig(config2)).toThrow(/strictly positive/);
  });

  test('rejects a stack cap below the EXTREME strength maximum', () => {
    const config = freshConfig();
    config.coinEvents.maxStackedModifier = 0.04;
    expect(() => validateSimulationConfig(config)).toThrow(/maxStackedModifier/);
  });

  test('rejects a negative bias factor below 1', () => {
    const config = freshConfig();
    config.coinEvents.negativeBiasFactor = 0.9;
    expect(() => validateSimulationConfig(config)).toThrow(/negative expectation/);
  });

  test('rejects a negative bias factor of exactly 1 (regression: no net negative expectation)', () => {
    // The spec requires negative events to outweigh positive events over
    // time; 1 means zero net bias and must be rejected, strictly.
    const config = freshConfig();
    config.coinEvents.negativeBiasFactor = 1;
    expect(() => validateSimulationConfig(config)).toThrow(/strictly greater than 1/);
    // Same rejection through the override resolution path.
    expect(() => resolveSimulationConfig({
      coinEvents: { negativeBiasFactor: 1 }
    })).toThrow(/strictly greater than 1/);
  });

  test('rejects non-ascending strength ranges', () => {
    const config = freshConfig();
    config.coinEvents.strengthRanges.MODERATE = { min: 0.006, max: 0.015 };
    expect(() => validateSimulationConfig(config)).toThrow(/overlaps or precedes/);
  });

  test('rejects a decline pressure that is not below growth support', () => {
    const config = freshConfig();
    config.lifecycle.declinePressureModifier = 0.02;
    expect(() => validateSimulationConfig(config)).toThrow(/below growthSupportModifier/);
  });

  test('rejects non-ascending drawdown thresholds', () => {
    const config = freshConfig();
    config.lifecycle.drawdownThresholds = { struggle: 0.20, panic: 0.15, collapseRisk: 0.30 };
    expect(() => validateSimulationConfig(config)).toThrow(/strictly ascending/);
  });

  test('rejects a plateau target below the starting index and a tolerance outside (0, 1)', () => {
    const lowTarget = freshConfig();
    lowTarget.lifecycle.plateauTargetMultiplier = { min: 0.8, max: 1.5 };
    expect(() => validateSimulationConfig(lowTarget)).toThrow(/>= 1/);

    const badTolerance = freshConfig();
    badTolerance.lifecycle.plateauTolerance = 1.5;
    expect(() => validateSimulationConfig(badTolerance)).toThrow(/\(0, 1\)/);
  });

  test('rejects a per-trade influence above the total pressure bound', () => {
    const config = freshConfig();
    config.tradingPressure.maxPerTradeInfluence = 0.01;
    expect(() => validateSimulationConfig(config)).toThrow(/exceeds the pressure bound/);
  });

  test('rejects a pre-decline collapse risk cap above the absolute cap', () => {
    const config = freshConfig();
    config.dynamicCollapse.preDeclineRiskCap = 0.5;
    expect(() => validateSimulationConfig(config)).toThrow(/preDeclineRiskCap/);
  });

  test('rejects a late recovery stronger than the early recovery', () => {
    const config = freshConfig();
    config.crashRally.recoveryStrength.late = { min: 0.5, max: 1.2 };
    expect(() => validateSimulationConfig(config)).toThrow(/late rallies are weaker/);
  });

  test('rejects an early recovery ceiling below 1 (new highs impossible)', () => {
    const config = freshConfig();
    config.crashRally.recoveryStrength.early = { min: 0.7, max: 0.95 };
    expect(() => validateSimulationConfig(config)).toThrow(/new high/);
  });
});

describe('simulation config probability and weight validation', () => {
  test('rejects probabilities outside [0, 1]', () => {
    const over = freshConfig();
    over.crashRally.crashProbability.GROWTH = 1.5;
    expect(() => validateSimulationConfig(over)).toThrow(/probability in \[0, 1\]/);

    const under = freshConfig();
    under.crashRally.lowerHighBias = -0.1;
    expect(() => validateSimulationConfig(under)).toThrow(/probability in \[0, 1\]/);
  });

  test('rejects direction weights that do not sum to 1', () => {
    const config = freshConfig();
    config.coinEvents.directionWeights = { positive: 0.6, negative: 0.6 };
    expect(() => validateSimulationConfig(config)).toThrow(/sum to 1/);
  });

  test('rejects strength probabilities that do not sum to 1', () => {
    const config = freshConfig();
    config.coinEvents.strengthProbabilities.MINOR = 0.9;
    expect(() => validateSimulationConfig(config)).toThrow(/sum to 1/);
  });

  test('rejects strength probabilities where a stronger category is more likely', () => {
    const config = freshConfig();
    // Keep the sum at 1 but make EXTREME more likely than MAJOR.
    config.coinEvents.strengthProbabilities = { MINOR: 0.45, MODERATE: 0.3, MAJOR: 0.05, EXTREME: 0.2 };
    expect(() => validateSimulationConfig(config)).toThrow(/stronger events must be rarer/);
  });

  test('rejects lifecycle phase weights that do not sum to 1', () => {
    const config = freshConfig();
    config.marketPhases.lifecycleWeights.DECLINE.BEAR = 0.9;
    expect(() => validateSimulationConfig(config)).toThrow(/sum to 1/);
  });

  test('rejects crash probabilities that decrease after the plateau (regression)', () => {
    // Design: crash danger is non-decreasing GROWTH <= PLATEAU <= DECLINE
    // <= COLLAPSE; a drop after PLATEAU contradicts the downward-bias arc.
    const decreasing = freshConfig();
    decreasing.crashRally.crashProbability.DECLINE = 0.03;
    expect(() => validateSimulationConfig(decreasing)).toThrow(/non-decreasing/);

    const earlyDrop = freshConfig();
    earlyDrop.crashRally.crashProbability.PLATEAU = 0.01;
    expect(() => validateSimulationConfig(earlyDrop)).toThrow(/non-decreasing/);

    // Equal probabilities are legal (non-decreasing, not strictly rising).
    const flat = freshConfig();
    flat.crashRally.crashProbability = { GROWTH: 0.05, PLATEAU: 0.05, DECLINE: 0.05, COLLAPSE: 0.05 };
    expect(validateSimulationConfig(flat)).toBeDefined();

    // Same rejection through the override resolution path: overriding
    // GROWTH above the default PLATEAU (0.04) breaks the ordering.
    expect(() => resolveSimulationConfig({
      crashRally: { crashProbability: { GROWTH: 0.05 } }
    })).toThrow(/non-decreasing/);
  });

  test('rejects lifecycle weight sets with no positive or no negative phases (regression)', () => {
    // Normalised but with every positive phase zeroed: no believable hope
    // during Collapse, which the design forbids.
    const noPositive = freshConfig();
    noPositive.marketPhases.lifecycleWeights.COLLAPSE = {
      GOLDEN_AGE: 0, BOOM: 0, BULL: 0, BEAR: 0.4, BUST: 0.35, RECESSION: 0.25
    };
    expect(() => validateSimulationConfig(noPositive)).toThrow(/positive phases must remain possible/);

    // Normalised but with every negative phase zeroed: Growth with no
    // possible bear phase contradicts the design.
    const noNegative = freshConfig();
    noNegative.marketPhases.lifecycleWeights.GROWTH = {
      GOLDEN_AGE: 0.2, BOOM: 0.35, BULL: 0.45, BEAR: 0, BUST: 0, RECESSION: 0
    };
    expect(() => validateSimulationConfig(noNegative)).toThrow(/negative phases must remain possible/);

    // Same rejections through the override resolution path.
    expect(() => resolveSimulationConfig({
      marketPhases: {
        lifecycleWeights: {
          DECLINE: { GOLDEN_AGE: 0, BOOM: 0, BULL: 0, BEAR: 0.4, BUST: 0.35, RECESSION: 0.25 }
        }
      }
    })).toThrow(/positive phases must remain possible/);
    expect(() => resolveSimulationConfig({
      marketPhases: {
        lifecycleWeights: {
          GROWTH: { GOLDEN_AGE: 0.2, BOOM: 0.35, BULL: 0.45, BEAR: 0, BUST: 0, RECESSION: 0 }
        }
      }
    })).toThrow(/negative phases must remain possible/);
  });

  test('rejects collapse input weights that do not sum to 1', () => {
    const config = freshConfig();
    config.dynamicCollapse.inputWeights.marketDrawdown = 0.9;
    expect(() => validateSimulationConfig(config)).toThrow(/sum to 1/);
  });
});

describe('simulation config shape validation (no silent coercion)', () => {
  test('rejects a missing section and an unknown top-level section', () => {
    const missing = freshConfig();
    delete missing.lifecycle;
    expect(() => validateSimulationConfig(missing)).toThrow(/exactly the keys/);

    const extra = freshConfig();
    extra.telemetry = { enabled: true };
    expect(() => validateSimulationConfig(extra)).toThrow(/exactly the keys/);
  });

  test('rejects a missing leaf and an unknown nested key', () => {
    const missingLeaf = freshConfig();
    delete missingLeaf.coinEvents.maxActivePerCoin;
    expect(() => validateSimulationConfig(missingLeaf)).toThrow(/exactly the keys/);

    const extraLeaf = freshConfig();
    extraLeaf.coinEvents.rigged = true;
    expect(() => validateSimulationConfig(extraLeaf)).toThrow(/exactly the keys/);
  });

  test('rejects string numbers instead of coercing them', () => {
    const config = freshConfig();
    config.coinEvents.maxActivePerCoin = '5';
    expect(() => validateSimulationConfig(config)).toThrow(/finite number/);
  });

  test('rejects arrays where objects are required', () => {
    const config = freshConfig();
    config.marketPhases.phases = ['GOLDEN_AGE'];
    expect(() => validateSimulationConfig(config)).toThrow(/must be an object/);
  });
});

describe('simulation config immutability', () => {
  test('the default config is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_SIMULATION_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SIMULATION_CONFIG.coinEvents)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SIMULATION_CONFIG.coinEvents.durationMs)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SIMULATION_CONFIG.marketPhases.phases.BULL)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SIMULATION_CONFIG.dynamicCollapse.inputWeights)).toBe(true);
  });

  test('attempted mutation of the frozen defaults does not take effect', () => {
    const before = DEFAULT_SIMULATION_CONFIG.coinEvents.maxActivePerCoin;
    try {
      DEFAULT_SIMULATION_CONFIG.coinEvents.maxActivePerCoin = 99;
    } catch (_) {
      // Strict-mode TypeError is also acceptable proof of immutability.
    }
    expect(DEFAULT_SIMULATION_CONFIG.coinEvents.maxActivePerCoin).toBe(before);
  });

  test('a resolved override config is deeply frozen and complete', () => {
    const resolved = resolveSimulationConfig({
      coinEvents: { maxActivePerCoin: 3 },
      crashRally: { crashProbability: { GROWTH: 0.01 } }
    });
    expect(resolved.coinEvents.maxActivePerCoin).toBe(3);
    expect(resolved.crashRally.crashProbability.GROWTH).toBe(0.01);
    // Untouched leaves keep the defaults.
    expect(resolved.coinEvents.maxStackedModifier).toBe(0.06);
    expect(resolved.crashRally.crashProbability.DECLINE).toBe(0.08);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.crashRally.crashProbability)).toBe(true);
    // Resolving does not mutate the defaults.
    expect(DEFAULT_SIMULATION_CONFIG.coinEvents.maxActivePerCoin).toBe(5);
  });

  test('resolve rejects unknown override keys at any depth', () => {
    expect(() => resolveSimulationConfig({ coinEvents: { rigged: 1 } })).toThrow(/unknown key/);
    expect(() => resolveSimulationConfig({ nope: {} })).toThrow(/unknown key/);
  });

  test('resolve validates the merged result rather than coercing it', () => {
    expect(() => resolveSimulationConfig({ coinEvents: { maxActivePerCoin: 0 } })).toThrow(/positive integer/);
    expect(() => resolveSimulationConfig({ coinEvents: { maxActivePerCoin: '3' } })).toThrow(/finite number/);
    expect(() => resolveSimulationConfig({
      dynamicCollapse: { preDeclineRiskCap: 0.5 }
    })).toThrow(/preDeclineRiskCap/);
  });
});
