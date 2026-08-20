const {
  getApocalypseVolatility,
  DEFAULT_APOCALYPSE_MIN_FACTOR,
  DEFAULT_APOCALYPSE_MAX_FACTOR,
  ABSOLUTE_MAX_APOCALYPSE_FACTOR
} = require('../game/apocalypseVolatility');

// Pure Core 2 curve: translate authoritative Core 1 cycle progress (0..100)
// into a bounded volatility multiplier. No database involved here — the
// simulator resolves progress once per batch and passes the factor down.
describe('Core 2: apocalypse volatility curve', () => {
  describe('default curve shape', () => {
    test('start of cycle has the lowest factor (exactly the minimum)', () => {
      expect(getApocalypseVolatility(0)).toBe(DEFAULT_APOCALYPSE_MIN_FACTOR);
    });

    test('end of cycle reaches exactly the maximum factor', () => {
      expect(getApocalypseVolatility(100)).toBe(DEFAULT_APOCALYPSE_MAX_FACTOR);
    });

    test('factor monotonically increases with progress', () => {
      let previous = -Infinity;
      for (let p = 0; p <= 100; p += 1) {
        const factor = getApocalypseVolatility(p);
        expect(factor).toBeGreaterThan(previous);
        previous = factor;
      }
    });

    test('late cycle is materially greater than early cycle', () => {
      const early = getApocalypseVolatility(10);
      const late = getApocalypseVolatility(90);
      expect(late).toBeGreaterThan(early * 2);
    });

    test('default early-cycle factor is 1.0 so early market behavior is unchanged', () => {
      expect(DEFAULT_APOCALYPSE_MIN_FACTOR).toBe(1);
      expect(getApocalypseVolatility(0)).toBe(1);
    });

    test('curve is smooth across band boundaries (no abrupt threshold jumps)', () => {
      // Sampling at fine granularity, consecutive factors never jump by more
      // than a small epsilon — the 25/50/75 boundaries are continuous.
      let previous = getApocalypseVolatility(0);
      for (let p = 0.5; p <= 100; p += 0.5) {
        const factor = getApocalypseVolatility(p);
        expect(factor - previous).toBeLessThan(0.05);
        previous = factor;
      }
    });
  });

  describe('bounds', () => {
    test('every factor respects the configured min/max bounds', () => {
      const config = { minFactor: 1.5, maxFactor: 4 };
      for (let p = 0; p <= 100; p += 7) {
        const factor = getApocalypseVolatility(p, config);
        expect(factor).toBeGreaterThanOrEqual(config.minFactor);
        expect(factor).toBeLessThanOrEqual(config.maxFactor);
      }
    });

    test('custom exponent still respects bounds and monotonicity', () => {
      const config = { minFactor: 1, maxFactor: 2.5, exponent: 3 };
      let previous = -Infinity;
      for (let p = 0; p <= 100; p += 5) {
        const factor = getApocalypseVolatility(p, config);
        expect(factor).toBeGreaterThan(previous);
        expect(factor).toBeGreaterThanOrEqual(1);
        expect(factor).toBeLessThanOrEqual(2.5);
        previous = factor;
      }
    });

    test('factor is always a finite positive number for any in-range progress', () => {
      for (let p = 0; p <= 100; p += 3) {
        const factor = getApocalypseVolatility(p);
        expect(Number.isFinite(factor)).toBe(true);
        expect(factor).toBeGreaterThan(0);
      }
    });
  });

  describe('progress clamping and malformed progress', () => {
    test('progress below 0 clamps to the minimum factor', () => {
      expect(getApocalypseVolatility(-1)).toBe(DEFAULT_APOCALYPSE_MIN_FACTOR);
      expect(getApocalypseVolatility(-1000000)).toBe(DEFAULT_APOCALYPSE_MIN_FACTOR);
    });

    test('progress above 100 clamps to the maximum factor', () => {
      expect(getApocalypseVolatility(101)).toBe(DEFAULT_APOCALYPSE_MAX_FACTOR);
      expect(getApocalypseVolatility(1000000)).toBe(DEFAULT_APOCALYPSE_MAX_FACTOR);
    });

    // Safe-default policy: malformed progress can never produce NaN/Infinity;
    // it resolves to the minimum factor (normal early-cycle behavior).
    test.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['undefined', undefined],
      ['null', null],
      ['numeric string', '50'],
      ['non-numeric string', 'halfway'],
      ['object', {}],
      ['array', [50]],
      ['boolean', true]
    ])('malformed progress (%s) safely resolves to the minimum factor', (_label, value) => {
      const factor = getApocalypseVolatility(value);
      expect(factor).toBe(DEFAULT_APOCALYPSE_MIN_FACTOR);
      expect(Number.isFinite(factor)).toBe(true);
    });
  });

  describe('configuration validation', () => {
    test('absent config uses the documented defaults', () => {
      expect(getApocalypseVolatility(50)).toBe(getApocalypseVolatility(50, undefined));
      expect(getApocalypseVolatility(50, {})).toBe(getApocalypseVolatility(50));
    });

    test.each([
      ['non-object config', 'aggressive'],
      ['NaN minFactor', { minFactor: NaN }],
      ['Infinite maxFactor', { maxFactor: Infinity }],
      ['zero minFactor', { minFactor: 0 }],
      ['negative minFactor', { minFactor: -1 }],
      ['maxFactor below minFactor', { minFactor: 2, maxFactor: 1.5 }],
      ['maxFactor above the absolute safety cap', { maxFactor: ABSOLUTE_MAX_APOCALYPSE_FACTOR + 1 }],
      ['zero exponent', { exponent: 0 }],
      ['negative exponent', { exponent: -2 }],
      ['NaN exponent', { exponent: NaN }],
      ['non-numeric minFactor', { minFactor: '1' }]
    ])('invalid config (%s) throws a clear error', (_label, config) => {
      expect(() => getApocalypseVolatility(50, config)).toThrow(/apocalypse volatility/i);
    });

    test('config errors are thrown before any factor is produced', () => {
      expect(() => getApocalypseVolatility(50, { minFactor: -5, maxFactor: -1 }))
        .toThrow(/apocalypse volatility/i);
    });
  });
});
