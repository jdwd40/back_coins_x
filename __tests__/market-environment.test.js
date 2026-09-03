// Persistent-market Stage 2: the Market Environment seam
// (game/marketEnvironment.js, master plan §8-10).
//
// Pins: the exact environment key set and validation bounds, the neutral
// provider's determinism (the same frozen neutral environment at every
// instant), and loud failure on corrupt environments/providers — the seam
// the Stage 3 Market Director will plug into without any pricing rewrite.

const {
  ENVIRONMENT_KEYS,
  NEUTRAL_ENVIRONMENT,
  assertMarketEnvironment,
  assertEnvironmentProvider,
  resolveEnvironment,
  createNeutralEnvironmentProvider
} = require('../game/marketEnvironment');

describe('Market Environment seam', () => {
  test('the neutral environment carries exactly the plan §9 fields with neutral values', () => {
    expect(ENVIRONMENT_KEYS.slice().sort()).toEqual([
      'collapseRiskModifier',
      'crashProbabilityModifier',
      'eventSeverityScale',
      'negativeEventBias',
      'positiveEventBias',
      'recoveryModifier',
      'structuralBias',
      'volatilityScale'
    ]);
    expect(NEUTRAL_ENVIRONMENT).toEqual({
      structuralBias: 0,
      volatilityScale: 1,
      positiveEventBias: 0,
      negativeEventBias: 0,
      eventSeverityScale: 1,
      crashProbabilityModifier: 1,
      recoveryModifier: 1,
      collapseRiskModifier: 1
    });
    expect(Object.isFrozen(NEUTRAL_ENVIRONMENT)).toBe(true);
  });

  test('the neutral provider is deterministic: the identical frozen environment at every instant', () => {
    const provider = createNeutralEnvironmentProvider();
    expect(provider.id).toBe('NEUTRAL');
    for (const nowMs of [0, 1, 60 * 1000, 365 * 24 * 60 * 60 * 1000]) {
      expect(provider.environmentAt(nowMs)).toBe(NEUTRAL_ENVIRONMENT);
    }
    expect(() => provider.environmentAt(NaN)).toThrow(/nowMs/);
  });

  test('resolveEnvironment accepts a literal environment or any provider behind the seam', () => {
    expect(resolveEnvironment(NEUTRAL_ENVIRONMENT, 1234)).toBe(NEUTRAL_ENVIRONMENT);
    const provider = createNeutralEnvironmentProvider();
    expect(resolveEnvironment(provider, 1234)).toBe(NEUTRAL_ENVIRONMENT);
    const custom = { ...NEUTRAL_ENVIRONMENT, structuralBias: 0.02 };
    expect(resolveEnvironment({ environmentAt: () => custom }, 99)).toBe(custom);
  });

  test('corrupt environments fail loudly (exact keys, finite values, safety bounds)', () => {
    expect(() => assertMarketEnvironment(null)).toThrow(/must be an object/);
    expect(() => assertMarketEnvironment({ ...NEUTRAL_ENVIRONMENT, extra: 1 })).toThrow(/exactly the keys/);
    const missing = { ...NEUTRAL_ENVIRONMENT };
    delete missing.structuralBias;
    expect(() => assertMarketEnvironment(missing)).toThrow(/exactly the keys/);
    expect(() => assertMarketEnvironment({ ...NEUTRAL_ENVIRONMENT, structuralBias: NaN })).toThrow(/finite number/);
    expect(() => assertMarketEnvironment({ ...NEUTRAL_ENVIRONMENT, structuralBias: 1 })).toThrow(/within \[/);
    expect(() => assertMarketEnvironment({ ...NEUTRAL_ENVIRONMENT, volatilityScale: 0 })).toThrow(/within \[/);
    expect(() => assertMarketEnvironment({ ...NEUTRAL_ENVIRONMENT, crashProbabilityModifier: -0.1 })).toThrow(/within \[/);
  });

  test('corrupt providers fail loudly', () => {
    expect(() => assertEnvironmentProvider(null)).toThrow(/must be an object/);
    expect(() => assertEnvironmentProvider({})).toThrow(/environmentAt/);
    // A provider returning a corrupt environment fails at resolution time.
    expect(() => resolveEnvironment({ environmentAt: () => ({ bad: true }) }, 0)).toThrow(/exactly the keys/);
    expect(() => resolveEnvironment(NEUTRAL_ENVIRONMENT, Infinity)).toThrow(/nowMs/);
  });
});
