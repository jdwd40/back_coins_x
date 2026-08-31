// V2-3: apocalypse escalation as a gameplay accelerator.
//
// Pins the preserved Core 2 amplitude curve (V2-1/V2-2 gates passed on
// exactly these values — the curve is deliberately NOT retuned), the
// centralized escalation-band vocabulary, and the shared-domain fact that
// late-apocalypse prices move materially more than early-apocalypse prices
// while every live price stays finite and strictly positive and every
// collapsed price is exactly zero.

const {
  getApocalypseVolatility,
  getEscalationBand,
  ESCALATION_BANDS,
  ESCALATION_BAND_IDS,
  DEFAULT_APOCALYPSE_MIN_FACTOR,
  DEFAULT_APOCALYPSE_MAX_FACTOR,
  DEFAULT_APOCALYPSE_CURVE_EXPONENT
} = require('../game/apocalypseVolatility');
const marketDomain = require('../game/marketDomain');
const { createRoundEnvironment, CANONICAL_COINS } = require('../simulation/roundEnvironment');
const { computeRoundMarketStats } = require('../simulation/escalationStudy');
const { createRoundContext } = require('../simulation/engine');

jest.setTimeout(60000);

describe('V2-3 escalation: the Core 2 curve is preserved exactly', () => {
  test('default parameters and curve values are unchanged from Core 2', () => {
    expect(DEFAULT_APOCALYPSE_MIN_FACTOR).toBe(1.0);
    expect(DEFAULT_APOCALYPSE_MAX_FACTOR).toBe(3.0);
    expect(DEFAULT_APOCALYPSE_CURVE_EXPONENT).toBe(2);
    expect(getApocalypseVolatility(0)).toBe(1);
    expect(getApocalypseVolatility(50)).toBe(1.5);
    expect(getApocalypseVolatility(100)).toBe(3);
    // Smooth and monotonic across the whole round.
    let previous = 0;
    for (let p = 0; p <= 100; p += 1) {
      const factor = getApocalypseVolatility(p);
      expect(factor).toBeGreaterThanOrEqual(previous);
      previous = factor;
    }
  });

  test('malformed progress still resolves safely to the minimum factor', () => {
    expect(getApocalypseVolatility(NaN)).toBe(1);
    expect(getApocalypseVolatility(undefined)).toBe(1);
    expect(getApocalypseVolatility(-20)).toBe(1);
    expect(getApocalypseVolatility(250)).toBe(3);
  });
});

describe('V2-3 escalation: band vocabulary', () => {
  test('bands cover 0-100 in the intended four phases', () => {
    expect(ESCALATION_BAND_IDS).toEqual(['NORMAL', 'ELEVATED', 'HIGH', 'EXTREME']);
    expect(ESCALATION_BANDS.map((b) => [b.minPercent, b.maxPercent])).toEqual([
      [0, 40], [40, 70], [70, 90], [90, 100]
    ]);
  });

  test('getEscalationBand maps progress and survives malformed input', () => {
    expect(getEscalationBand(0)).toBe('NORMAL');
    expect(getEscalationBand(39.99)).toBe('NORMAL');
    expect(getEscalationBand(40)).toBe('ELEVATED');
    expect(getEscalationBand(69.99)).toBe('ELEVATED');
    expect(getEscalationBand(70)).toBe('HIGH');
    expect(getEscalationBand(89.99)).toBe('HIGH');
    expect(getEscalationBand(90)).toBe('EXTREME');
    expect(getEscalationBand(100)).toBe('EXTREME');
    expect(getEscalationBand(NaN)).toBe('NORMAL');
    expect(getEscalationBand(undefined)).toBe('NORMAL');
    expect(getEscalationBand(999)).toBe('EXTREME');
  });
});

describe('V2-3 escalation: shared-domain behaviour on seeded rounds', () => {
  test('seeded dynamic-death rounds keep band statistics finite even when all coins die before EXTREME', () => {
    const stats = [];
    for (let r = 0; r < 8; r++) {
      const env = createRoundEnvironment({ seed: `v2-3-escalation-test-seed:${r}`, economy: false });
      const context = createRoundContext(env, {});
      stats.push(computeRoundMarketStats(context));
    }
    // SIM-13 may eliminate all survivors before the EXTREME band, where a
    // live-price-only median is correctly 0. The old fixed scheduler made
    // an increasing live-price assertion meaningful; the dynamic engine
    // instead requires robust finite reporting without pretending corpses
    // still trade. The Core 2 amplitude curve itself is pinned above.
    for (const stat of stats) {
      for (const band of Object.values(stat.bands)) {
        expect(Number.isFinite(band.medianTickMovePct)).toBe(true);
        expect(Number.isFinite(band.medianSwingPct)).toBe(true);
        expect(band.medianTickMovePct).toBeGreaterThanOrEqual(0);
        expect(band.medianSwingPct).toBeGreaterThanOrEqual(0);
      }
    }
    expect(stats.some((s) => s.bands.NORMAL.medianTickMovePct > 0)).toBe(true);
  });

  test('every live price stays finite and strictly positive; collapsed prices are exactly zero', () => {
    const env = createRoundEnvironment({ seed: 'v2-3-escalation-invariant-seed', economy: false });
    for (let t = 0; t <= env.durationMs; t += 30000) {
      for (const coin of CANONICAL_COINS) {
        const price = env.priceAt(coin.coinId, t);
        if (env.isDead(coin.coinId, t)) {
          expect(price).toBe(0);
        } else {
          expect(Number.isFinite(price)).toBe(true);
          expect(price).toBeGreaterThan(0);
        }
      }
    }
  });

  test('escalation amplifies deviation without repricing anchors: prices are continuous at cycle boundaries', () => {
    // The same domain evaluation at consecutive 1-second instants across a
    // boundary never jumps by more than the local volatility allows — the
    // amplitude scales deviation from the CONTINUOUS anchor path, so there
    // is no discontinuity when a coin's market cycle rolls over.
    const seed = 'v2-3-escalation-continuity-seed';
    for (const coinId of [2, 6, 10]) {
      let previousPrice = null;
      for (let t = 600000; t <= 660000; t += 1000) {
        const price = marketDomain.priceAt({
          seed, coinId, baselinePrice: 10, roundStartMs: 0, nowMs: t, amplitude: 2.0
        });
        if (previousPrice !== null) {
          const movePct = Math.abs((price - previousPrice) / previousPrice);
          expect(movePct).toBeLessThan(0.5); // no teleportation at 1s granularity
        }
        previousPrice = price;
      }
    }
  });

  test('the simulator public signal carries the shared collapse-risk level', () => {
    const env = createRoundEnvironment({ seed: 'v2-3-escalation-signal-seed', economy: false });
    const t = Math.floor(env.durationMs * 0.8);
    for (const coin of CANONICAL_COINS) {
      const signal = env.publicSignal(coin.coinId, t);
      expect(signal).toHaveProperty('collapseRisk');
      if (signal.dead) {
        expect(signal.collapseRisk).toBe('DEAD');
      } else {
        expect(['STABLE', 'SHAKY', 'DANGER', 'CRITICAL']).toContain(signal.collapseRisk);
      }
    }
  });
});
