// V2-1: deterministic cyclical market domain (game/marketDomain.js).
// Pure tests — no database, no clock, no timers.

const marketDomain = require('../game/marketDomain');

const SEED = 'v2-domain-test-seed';
const ROUND_START = Date.UTC(2026, 7, 25, 10, 0, 0);
const BASELINES = { 1: 0.10, 4: 0.10, 2: 1.37, 7: 3.91, 6: 43.46, 8: 33.48, 5: 96.45, 10: 32.00, 9: 0.10, 3: 0.12 };

function price(coinId, tMs, amplitude = 1) {
  return marketDomain.priceAt({
    seed: SEED,
    coinId,
    baselinePrice: BASELINES[coinId],
    roundStartMs: ROUND_START,
    nowMs: ROUND_START + tMs,
    amplitude
  });
}

describe('V2-1 market domain: roster and archetypes', () => {
  test('the canonical active catalogue maps to the documented gameplay roster', () => {
    expect(marketDomain.resolveArchetypeId(1)).toBe('ZIP');
    expect(marketDomain.resolveArchetypeId(4)).toBe('ZIP');
    expect(marketDomain.resolveArchetypeId(2)).toBe('MOON');
    expect(marketDomain.resolveArchetypeId(7)).toBe('MOON');
    expect(marketDomain.resolveArchetypeId(6)).toBe('BULL');
    expect(marketDomain.resolveArchetypeId(8)).toBe('BULL');
    expect(marketDomain.resolveArchetypeId(5)).toBe('HODL');
    expect(marketDomain.resolveArchetypeId(10)).toBe('HODL');
    expect(marketDomain.resolveArchetypeId(9)).toBe('DEGEN');
    expect(marketDomain.resolveArchetypeId(3)).toBe('RUG');
    expect(marketDomain.GAMEPLAY_ROSTER.size).toBe(10);
  });

  test('an unmapped coin id falls back to the default archetype instead of failing closed', () => {
    expect(marketDomain.resolveArchetypeId(999)).toBe(marketDomain.DEFAULT_ARCHETYPE_ID);
  });

  test('generated cycles stay inside archetype duration/swing bands with valid phase fractions', () => {
    for (const [archetypeId, archetype] of Object.entries(marketDomain.MARKET_ARCHETYPES)) {
      for (let index = 0; index < 60; index++) {
        const cycle = marketDomain.buildMarketCycle({ seed: SEED, coinId: 2, archetypeId, index });
        expect(cycle.durationMs).toBeGreaterThanOrEqual(archetype.cycleMs[0]);
        expect(cycle.durationMs).toBeLessThanOrEqual(archetype.cycleMs[1]);
        expect(cycle.swing).toBeGreaterThanOrEqual(archetype.swing[0]);
        expect(cycle.swing).toBeLessThanOrEqual(archetype.swing[1]);
        const fracSum = cycle.dipFrac + cycle.riseFrac + cycle.boomFrac + cycle.fallFrac;
        expect(fracSum).toBeCloseTo(1, 9);
        expect(cycle.fallFrac).toBeGreaterThan(0);
        expect(cycle.dipDepth).toBeGreaterThan(0);
        expect(cycle.boomHeight).toBeGreaterThan(0);
      }
    }
  });
});

describe('V2-1 market domain: determinism', () => {
  test('identical inputs produce identical prices, repeatedly', () => {
    for (const t of [0, 60_000, 750_000, 1_800_000]) {
      expect(price(2, t)).toBe(price(2, t));
      expect(price(9, t)).toBe(price(9, t));
    }
  });

  test('different seeds produce different paths; different coins on one seed differ', () => {
    const a = marketDomain.priceAt({ seed: 'seed-a', coinId: 2, baselinePrice: 1.37, roundStartMs: ROUND_START, nowMs: ROUND_START + 500_000 });
    const b = marketDomain.priceAt({ seed: 'seed-b', coinId: 2, baselinePrice: 1.37, roundStartMs: ROUND_START, nowMs: ROUND_START + 500_000 });
    expect(a).not.toBe(b);
    expect(price(2, 500_000)).not.toBe(price(7, 500_000));
  });

  test('an invalid amplitude safely falls back to 1 (Core 2 contract)', () => {
    for (const amplitude of [NaN, Infinity, 0, -2, undefined]) {
      const guarded = marketDomain.evaluateMarketPoint({
        seed: SEED, coinId: 2, baselinePrice: 1.37, roundStartMs: ROUND_START, nowMs: ROUND_START + 500_000, amplitude
      });
      const normal = marketDomain.evaluateMarketPoint({
        seed: SEED, coinId: 2, baselinePrice: 1.37, roundStartMs: ROUND_START, nowMs: ROUND_START + 500_000, amplitude: 1
      });
      expect(guarded.price).toBe(normal.price);
    }
  });

  test('a non-positive baseline is rejected; prices are always finite and strictly positive', () => {
    expect(() => marketDomain.priceAt({ seed: SEED, coinId: 2, baselinePrice: 0, roundStartMs: ROUND_START, nowMs: ROUND_START })).toThrow(/baselinePrice/);
    for (const coinId of Object.keys(BASELINES).map(Number)) {
      for (let t = 0; t <= 30 * 60 * 1000; t += 7000) {
        const p = price(coinId, t, 3); // max Core 2 amplitude
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThan(0);
      }
    }
  });

  test('prices are continuous: no teleportation between adjacent seconds, none at cycle boundaries', () => {
    // Coarse slope sanity bound (DEGEN/RUG falls are deliberately steep at
    // maximum late-apocalypse amplitude — up to ~10%/s — but never a
    // teleport). The precise discontinuity invariant is the boundary test
    // below; this only rules out gross jumps.
    for (const coinId of [1, 2, 5, 9, 3]) {
      for (let t = 0; t <= 30 * 60 * 1000; t += 13_000) {
        const before = price(coinId, t, 2);
        const after = price(coinId, t + 1000, 2);
        expect(Math.abs(after - before) / before).toBeLessThan(0.25);
      }
    }
    // Cycle boundaries are the only candidate discontinuity: the FALL of
    // cycle k and the DIP of cycle k+1 share the seeded boundary level, so
    // 1ms across a boundary must move the price by a negligible amount.
    for (const coinId of [1, 2, 9, 3]) {
      let location = marketDomain.locateMarketCycle({
        seed: SEED, coinId, archetypeId: marketDomain.resolveArchetypeId(coinId), roundStartMs: ROUND_START, nowMs: ROUND_START
      });
      for (let i = 0; i < 4; i++) {
        const boundary = location.endMs;
        const before = marketDomain.priceAt({ seed: SEED, coinId, baselinePrice: BASELINES[coinId], roundStartMs: ROUND_START, nowMs: boundary - 1 });
        const after = marketDomain.priceAt({ seed: SEED, coinId, baselinePrice: BASELINES[coinId], roundStartMs: ROUND_START, nowMs: boundary + 1 });
        expect(Math.abs(after - before) / before).toBeLessThan(0.01);
        location = marketDomain.locateMarketCycle({
          seed: SEED, coinId, archetypeId: marketDomain.resolveArchetypeId(coinId), roundStartMs: ROUND_START, nowMs: boundary + 1
        });
      }
    }
  });
});

describe('V2-1 market domain: cyclical structure', () => {
  test('every market cycle walks DIP -> RISE -> BOOM -> FALL in order', () => {
    const ORDER = ['DIP', 'RISE', 'BOOM', 'FALL'];
    for (const coinId of [2, 5, 9]) {
      for (let cycleIndex = 0; cycleIndex < 3; cycleIndex++) {
        // Locate the cycle directly and sample across its whole span.
        let location = marketDomain.locateMarketCycle({
          seed: SEED, coinId, archetypeId: marketDomain.resolveArchetypeId(coinId), roundStartMs: ROUND_START, nowMs: ROUND_START
        });
        for (let i = 0; i < cycleIndex; i++) {
          location = marketDomain.locateMarketCycle({
            seed: SEED, coinId, archetypeId: marketDomain.resolveArchetypeId(coinId), roundStartMs: ROUND_START, nowMs: location.endMs + 1
          });
        }
        const seen = [];
        for (let t = location.startMs; t < location.endMs; t += Math.max(1000, Math.floor(location.cycle.durationMs / 200))) {
          const point = marketDomain.evaluateMarketPoint({
            seed: SEED, coinId, baselinePrice: BASELINES[coinId], roundStartMs: ROUND_START, nowMs: t
          });
          if (seen[seen.length - 1] !== point.phase) seen.push(point.phase);
        }
        // The observed phase sequence must be a subsequence of the canonical
        // order, starting at or after the cycle's first phase and never
        // revisiting an earlier phase.
        let cursor = 0;
        for (const phase of seen) {
          const at = ORDER.indexOf(phase, cursor);
          expect(at).toBeGreaterThanOrEqual(cursor);
          cursor = at;
        }
        expect(seen).toContain('FALL');
      }
    }
  });

  test('a missed peak is not automatically rescued: adjacent-cycle peaks sometimes descend', () => {
    let descents = 0;
    let pairs = 0;
    for (const coinId of [1, 2, 3, 5, 9]) {
      let location = marketDomain.locateMarketCycle({
        seed: SEED, coinId, archetypeId: marketDomain.resolveArchetypeId(coinId), roundStartMs: ROUND_START, nowMs: ROUND_START
      });
      let previousPeak = location.anchor * (1 + location.cycle.boomHeight);
      for (let i = 0; i < 12; i++) {
        location = marketDomain.locateMarketCycle({
          seed: SEED, coinId, archetypeId: marketDomain.resolveArchetypeId(coinId), roundStartMs: ROUND_START, nowMs: location.endMs + 1
        });
        const peak = location.anchor * (1 + location.cycle.boomHeight);
        pairs += 1;
        if (peak < previousPeak) descents += 1;
        previousPeak = peak;
      }
    }
    // The anchor drifts, so a meaningful share of consecutive cycles peak
    // LOWER than their predecessor — waiting for "the next boom" is a real
    // risk, not a guaranteed rescue.
    expect(descents / pairs).toBeGreaterThan(0.15);
  });

  test('coins are staggered: the market never has every coin in one phase', () => {
    for (const offsetMinutes of [0, 3, 7, 12, 19, 25]) {
      const phases = new Set();
      for (const coinId of Object.keys(BASELINES).map(Number)) {
        const point = marketDomain.evaluateMarketPoint({
          seed: SEED, coinId, baselinePrice: BASELINES[coinId], roundStartMs: ROUND_START, nowMs: ROUND_START + offsetMinutes * 60_000
        });
        phases.add(point.phase);
      }
      expect(phases.size).toBeGreaterThanOrEqual(2);
    }
  });

  test('per-coin start offsets are deterministic and within the first cycle', () => {
    const offsets = new Set();
    for (const coinId of Object.keys(BASELINES).map(Number)) {
      const fraction = marketDomain.getCoinStartOffsetFraction(SEED, coinId);
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThan(1);
      expect(marketDomain.getCoinStartOffsetFraction(SEED, coinId)).toBe(fraction);
      offsets.add(fraction);
    }
    expect(offsets.size).toBeGreaterThan(5); // genuinely spread, not clustered
  });
});

describe('V2-1 market domain: price precision', () => {
  test('roundGamePrice rounds to gameplay precision and never reaches zero', () => {
    expect(marketDomain.roundGamePrice(1.234567)).toBe(1.2346);
    expect(marketDomain.roundGamePrice(0.00001)).toBe(marketDomain.MIN_POSITIVE_PRICE);
    expect(marketDomain.roundGamePrice(100)).toBe(100);
    expect(() => marketDomain.roundGamePrice(NaN)).toThrow();
    expect(() => marketDomain.roundGamePrice(Infinity)).toThrow();
  });

  test('persisted prices are exact multiples of the 4dp gameplay precision', () => {
    for (const coinId of Object.keys(BASELINES).map(Number)) {
      for (let t = 0; t <= 5 * 60 * 1000; t += 31_000) {
        const p = price(coinId, t);
        expect(Math.round(p * 10000) / 10000).toBe(p);
      }
    }
  });
});
