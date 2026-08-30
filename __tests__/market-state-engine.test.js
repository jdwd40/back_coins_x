// SIM-06/07: pure, deterministic tests for the market index and the hidden
// lifecycle state machine (game/marketStateEngine.js). No database.
//
// Covered:
//   * computeMarketIndex: plain sum of surviving prices at 8dp, DB string
//     numerics, the empty edge, and hard rejection of NaN/Infinity/negative
//     prices;
//   * computeDrawdown / computeMomentum: exact fractions, boundary values
//     (new high, total loss, zero base), and contract violations;
//   * drawPlateauTarget: seeded determinism, seed variation, range bounds,
//     custom config;
//   * nextLifecycleState: legal-order-only single-step transitions
//     (GROWTH -> PLATEAU -> DECLINE -> COLLAPSE), value-driven plateau
//     entry, behaviour-confirmed decline entry, severe-drawdown/late-cycle
//     collapse entry, terminal collapse, and no backwards resets.

const {
  computeMarketIndex,
  computeDrawdown,
  computeMomentum,
  drawPlateauTarget,
  nextLifecycleState
} = require('../game/marketStateEngine');
const {
  LIFECYCLE_STATE_IDS,
  DEFAULT_SIMULATION_CONFIG,
  resolveSimulationConfig
} = require('../game/simulationConfig');

const LC = DEFAULT_SIMULATION_CONFIG.lifecycle;
const SEED = 'sim06-engine-seed';

describe('SIM-06: computeMarketIndex', () => {
  test('sums surviving coin prices at 8 decimal places', () => {
    const index = computeMarketIndex([
      { coin_id: 1, current_price: 100.12345 },
      { coin_id: 2, current_price: 0.0001 },
      { coin_id: 3, current_price: 2500 }
    ]);
    expect(index).toBe(2600.12355);
  });

  test('accepts numeric strings (the database shape) and matches numeric input', () => {
    const asStrings = computeMarketIndex([
      { coin_id: 1, current_price: '92.1000' },
      { coin_id: 2, current_price: '17.2500' }
    ]);
    const asNumbers = computeMarketIndex([
      { coin_id: 1, current_price: 92.1 },
      { coin_id: 2, current_price: 17.25 }
    ]);
    expect(asStrings).toBe(asNumbers);
    expect(asStrings).toBe(109.35);
  });

  test('the empty market (no surviving coins) is exactly 0', () => {
    expect(computeMarketIndex([])).toBe(0);
  });

  test('rejects non-arrays and NaN/Infinity/negative prices outright', () => {
    expect(() => computeMarketIndex('not-an-array')).toThrow(/array/);
    expect(() => computeMarketIndex([{ coin_id: 1, current_price: NaN }])).toThrow(/finite non-negative/);
    expect(() => computeMarketIndex([{ coin_id: 1, current_price: Infinity }])).toThrow(/finite non-negative/);
    expect(() => computeMarketIndex([{ coin_id: 1, current_price: -5 }])).toThrow(/finite non-negative/);
    expect(() => computeMarketIndex([{ coin_id: 1, current_price: 'not-a-price' }])).toThrow(/finite non-negative/);
  });
});

describe('SIM-06: computeDrawdown', () => {
  test('is 0 at a new high and exact fractions below the peak', () => {
    expect(computeDrawdown(200, 200)).toBe(0);
    expect(computeDrawdown(200, 190)).toBe(0.05);
    expect(computeDrawdown(200, 170)).toBe(0.15);
    expect(computeDrawdown(200, 140)).toBe(0.3);
  });

  test('is 1 when the market has fallen to zero', () => {
    expect(computeDrawdown(350.5, 0)).toBe(1);
  });

  test('a zero peak has no meaningful drawdown (0 by definition)', () => {
    expect(computeDrawdown(0, 0)).toBe(0);
  });

  test('rejects an inverted peak/current pair and invalid inputs', () => {
    expect(() => computeDrawdown(100, 150)).toThrow(/peakIndex >= currentIndex/);
    expect(() => computeDrawdown(-1, 0)).toThrow(/non-negative/);
    expect(() => computeDrawdown(100, NaN)).toThrow(/non-negative/);
    expect(() => computeDrawdown(Infinity, 1)).toThrow(/non-negative/);
  });
});

describe('SIM-06: computeMomentum', () => {
  test('is the fractional change since the previous evaluation', () => {
    expect(computeMomentum(100, 110)).toBe(0.1);
    expect(computeMomentum(100, 90)).toBe(-0.1);
    expect(computeMomentum(100, 100)).toBe(0);
  });

  test('is exactly -1 when the market falls to zero (never below)', () => {
    expect(computeMomentum(250.75, 0)).toBe(-1);
  });

  test('a zero previous evaluation carries no signal (0)', () => {
    expect(computeMomentum(0, 0)).toBe(0);
    expect(computeMomentum(0, 100)).toBe(0);
  });

  test('rejects invalid inputs', () => {
    expect(() => computeMomentum(-1, 5)).toThrow(/non-negative/);
    expect(() => computeMomentum(1, Infinity)).toThrow(/non-negative/);
    expect(() => computeMomentum(NaN, 1)).toThrow(/non-negative/);
  });
});

describe('SIM-07: drawPlateauTarget', () => {
  test('is deterministic for a seed and starting index', () => {
    const first = drawPlateauTarget({ seed: SEED, startingIndex: 1000 });
    const second = drawPlateauTarget({ seed: SEED, startingIndex: 1000 });
    expect(first).toBe(second);
  });

  test('lies inside the configured multiplier range of the starting index', () => {
    for (const seed of ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e']) {
      const target = drawPlateauTarget({ seed, startingIndex: 1000 });
      expect(target).toBeGreaterThanOrEqual(1000 * LC.plateauTargetMultiplier.min);
      expect(target).toBeLessThanOrEqual(1000 * LC.plateauTargetMultiplier.max + 1e-8);
    }
  });

  test('varies the generated target across cycle seeds', () => {
    const targets = new Set(
      ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e', 'seed-f', 'seed-g', 'seed-h']
        .map((seed) => drawPlateauTarget({ seed, startingIndex: 1000 }))
    );
    expect(targets.size).toBeGreaterThan(1);
  });

  test('scales with the starting index and respects custom config ranges', () => {
    const small = drawPlateauTarget({ seed: SEED, startingIndex: 500 });
    const large = drawPlateauTarget({ seed: SEED, startingIndex: 2000 });
    // Same multiplier draw, scaled (8dp rounding allows sub-1e-6 drift).
    expect(large / small).toBeCloseTo(4, 6);

    const config = resolveSimulationConfig({ lifecycle: { plateauTargetMultiplier: { min: 1.5, max: 1.75 } } });
    const target = drawPlateauTarget({ seed: SEED, startingIndex: 800, config });
    expect(target).toBeGreaterThanOrEqual(800 * 1.5);
    expect(target).toBeLessThanOrEqual(800 * 1.75 + 1e-8);
  });

  test('a zero starting index generates a zero target', () => {
    expect(drawPlateauTarget({ seed: SEED, startingIndex: 0 })).toBe(0);
  });

  test('rejects a negative or non-finite starting index', () => {
    expect(() => drawPlateauTarget({ seed: SEED, startingIndex: -1 })).toThrow(/non-negative/);
    expect(() => drawPlateauTarget({ seed: SEED, startingIndex: NaN })).toThrow(/non-negative/);
  });
});

describe('SIM-07: nextLifecycleState', () => {
  const base = {
    currentIndex: 1000,
    peakIndex: 1000,
    drawdown: 0,
    momentum: 0,
    plateauTarget: 2500,
    cycleProgress: 0.2
  };

  test('stays in GROWTH below the peak region and before the safety guard', () => {
    expect(nextLifecycleState({ ...base, lifecycleState: 'GROWTH' })).toBe('GROWTH');
    // Just below the region low (2500 x 0.9 = 2250).
    expect(nextLifecycleState({ ...base, lifecycleState: 'GROWTH', currentIndex: 2249.9999 })).toBe('GROWTH');
  });

  test('enters PLATEAU when the actual market value reaches the generated peak region', () => {
    expect(nextLifecycleState({ ...base, lifecycleState: 'GROWTH', currentIndex: 2250, peakIndex: 2250 }))
      .toBe('PLATEAU');
    expect(nextLifecycleState({ ...base, lifecycleState: 'GROWTH', currentIndex: 2600, peakIndex: 2600 }))
      .toBe('PLATEAU');
  });

  test('the late-cycle guard forces PLATEAU even without the value trigger (safety only)', () => {
    expect(nextLifecycleState({
      ...base, lifecycleState: 'GROWTH', cycleProgress: LC.plateauEntryProgressGuard
    })).toBe('PLATEAU');
    expect(nextLifecycleState({
      ...base, lifecycleState: 'GROWTH', cycleProgress: LC.plateauEntryProgressGuard - 0.01
    })).toBe('GROWTH');
  });

  test('a zero plateau target can never trigger the value path (degenerate market)', () => {
    expect(nextLifecycleState({
      ...base, lifecycleState: 'GROWTH', currentIndex: 0, peakIndex: 0, plateauTarget: 0, cycleProgress: 0.1
    })).toBe('GROWTH');
    // The time guard still advances the degenerate market.
    expect(nextLifecycleState({
      ...base, lifecycleState: 'GROWTH', currentIndex: 0, peakIndex: 0, plateauTarget: 0, cycleProgress: 0.9
    })).toBe('PLATEAU');
  });

  test('PLATEAU oscillates: new highs and shallow dips do not leave the plateau', () => {
    // New high during plateau (still making highs is legal plateau behaviour).
    expect(nextLifecycleState({
      ...base, lifecycleState: 'PLATEAU', currentIndex: 2600, peakIndex: 2600, momentum: 0.02
    })).toBe('PLATEAU');
    // Shallow dip below the struggle threshold with negative momentum: not yet weakening.
    expect(nextLifecycleState({
      ...base, lifecycleState: 'PLATEAU', drawdown: LC.drawdownThresholds.struggle - 0.001, momentum: -0.01
    })).toBe('PLATEAU');
  });

  test('PLATEAU -> DECLINE requires confirmed weakening: drawdown AND negative momentum', () => {
    // Both signals present.
    expect(nextLifecycleState({
      ...base, lifecycleState: 'PLATEAU', drawdown: LC.drawdownThresholds.struggle, momentum: -0.001
    })).toBe('DECLINE');
    // Drawdown alone (a dip being bought back up) is not enough.
    expect(nextLifecycleState({
      ...base, lifecycleState: 'PLATEAU', drawdown: LC.drawdownThresholds.panic, momentum: 0.01
    })).toBe('PLATEAU');
    // Negative momentum alone at the peak is not enough.
    expect(nextLifecycleState({
      ...base, lifecycleState: 'PLATEAU', drawdown: LC.drawdownThresholds.struggle - 0.001, momentum: -0.2
    })).toBe('PLATEAU');
  });

  test('PLATEAU -> DECLINE via the bounded late-cycle safety guard', () => {
    expect(nextLifecycleState({
      ...base, lifecycleState: 'PLATEAU', cycleProgress: LC.declineEntryProgressGuard
    })).toBe('DECLINE');
    expect(nextLifecycleState({
      ...base, lifecycleState: 'PLATEAU', cycleProgress: LC.declineEntryProgressGuard - 0.01
    })).toBe('PLATEAU');
  });

  test('DECLINE -> COLLAPSE under severe drawdown, or via the late-cycle guard', () => {
    expect(nextLifecycleState({
      ...base, lifecycleState: 'DECLINE', drawdown: LC.drawdownThresholds.collapseRisk, momentum: -0.1
    })).toBe('COLLAPSE');
    expect(nextLifecycleState({
      ...base, lifecycleState: 'DECLINE', drawdown: LC.drawdownThresholds.collapseRisk - 0.001, momentum: -0.1
    })).toBe('DECLINE');
    expect(nextLifecycleState({
      ...base, lifecycleState: 'DECLINE', cycleProgress: LC.collapseEntryProgressGuard
    })).toBe('COLLAPSE');
  });

  test('DECLINE is never reset backwards: a strong rally stays in DECLINE', () => {
    // Rule: decline is interrupted but never permanently defeated — no
    // accidental permanent Growth after Decline.
    expect(nextLifecycleState({
      ...base,
      lifecycleState: 'DECLINE',
      currentIndex: 2400,
      peakIndex: 2500,
      drawdown: LC.drawdownThresholds.struggle,
      momentum: 0.5,
      cycleProgress: 0.6
    })).toBe('DECLINE');
  });

  test('COLLAPSE is structurally terminal regardless of measurements', () => {
    expect(nextLifecycleState({
      ...base, lifecycleState: 'COLLAPSE', currentIndex: 5000, peakIndex: 5000, drawdown: 0, momentum: 1, cycleProgress: 0.3
    })).toBe('COLLAPSE');
  });

  test('transitions advance at most ONE step per evaluation, in legal order', () => {
    // Extreme late-cycle inputs from GROWTH can only reach PLATEAU.
    expect(nextLifecycleState({
      ...base, lifecycleState: 'GROWTH', cycleProgress: 0.99, drawdown: 0.9, momentum: -0.9
    })).toBe('PLATEAU');
    // And from PLATEAU only DECLINE, even past the collapse guard.
    expect(nextLifecycleState({
      ...base, lifecycleState: 'PLATEAU', cycleProgress: 0.99, drawdown: 0.9, momentum: -0.9
    })).toBe('DECLINE');
  });

  test('the legal order is exactly GROWTH -> PLATEAU -> DECLINE -> COLLAPSE', () => {
    expect(LIFECYCLE_STATE_IDS).toEqual(['GROWTH', 'PLATEAU', 'DECLINE', 'COLLAPSE']);
  });

  test('rejects unknown states and out-of-range measurements', () => {
    expect(() => nextLifecycleState({ ...base, lifecycleState: 'EUPHORIA' })).toThrow(/unknown lifecycle state/);
    expect(() => nextLifecycleState({ ...base, lifecycleState: 'GROWTH', drawdown: 1.5 })).toThrow(/drawdown/);
    expect(() => nextLifecycleState({ ...base, lifecycleState: 'GROWTH', drawdown: -0.1 })).toThrow(/drawdown/);
    expect(() => nextLifecycleState({ ...base, lifecycleState: 'GROWTH', momentum: NaN })).toThrow(/momentum/);
    expect(() => nextLifecycleState({ ...base, lifecycleState: 'GROWTH', cycleProgress: 1.1 })).toThrow(/cycleProgress/);
    expect(() => nextLifecycleState({ ...base, lifecycleState: 'GROWTH', currentIndex: -1 })).toThrow(/non-negative/);
  });

  test('custom config moves the thresholds', () => {
    const config = resolveSimulationConfig({ lifecycle: { plateauTolerance: 0.5 } });
    // Region low is now 2500 x 0.5 = 1250.
    expect(nextLifecycleState({ ...base, lifecycleState: 'GROWTH', currentIndex: 1249, config })).toBe('GROWTH');
    expect(nextLifecycleState({ ...base, lifecycleState: 'GROWTH', currentIndex: 1250, config })).toBe('PLATEAU');
  });
});
