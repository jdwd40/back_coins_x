// SIM-11: bounded, decaying player/bot trading pressure — pure domain
// coverage (game/tradePressureDomain.js) plus its composition into the
// unified price path (game/priceEngine.js pressureModifier input).
//
// Pins: volume normalisation, the per-trade cap, exponential decay, the
// fixed evaluation window, per-side total bounds, anti transaction-spam
// bounds (one small trade -> only a small bounded influence; no burst of
// trades can exceed the configured bounds), exact determinism, and input
// validation. No database: these are pure functions of the ledger shape.

const tradePressureDomain = require('../game/tradePressureDomain');
const priceEngine = require('../game/priceEngine');
const { resolveSimulationConfig } = require('../game/simulationConfig');

const config = resolveSimulationConfig();
const TP = config.tradingPressure;
const NOW = 1_700_000_000_000;

function tx(type, notional, atMs) {
  return { type, notional, atMs };
}

describe('SIM-11: trade influence normalisation and per-trade cap', () => {
  test('a trade at exactly the normalisation amount yields exactly the per-trade cap', () => {
    expect(tradePressureDomain.tradeInfluence(TP.volumeNormalizationAmount, config)).toBe(TP.maxPerTradeInfluence);
  });

  test('a small trade has proportionally small influence (volume normalisation)', () => {
    const quarter = tradePressureDomain.tradeInfluence(TP.volumeNormalizationAmount / 4, config);
    expect(quarter).toBeCloseTo(TP.maxPerTradeInfluence / 4, 12);
  });

  test('a huge trade can never exceed the per-trade cap (saturation)', () => {
    expect(tradePressureDomain.tradeInfluence(TP.volumeNormalizationAmount * 1000, config)).toBe(TP.maxPerTradeInfluence);
  });

  test('zero and negative notional contribute nothing', () => {
    expect(tradePressureDomain.tradeInfluence(0, config)).toBe(0);
    expect(tradePressureDomain.tradeInfluence(-50, config)).toBe(0);
  });

  test('influence input must be a finite number', () => {
    expect(() => tradePressureDomain.tradeInfluence('100', config)).toThrow(/finite number/);
    expect(() => tradePressureDomain.tradeInfluence(NaN, config)).toThrow(/finite number/);
  });
});

describe('SIM-11: exponential decay and the fixed evaluation window', () => {
  test('contributions halve every decayHalfLifeMs', () => {
    expect(tradePressureDomain.decayWeight(0, config)).toBe(1);
    expect(tradePressureDomain.decayWeight(TP.decayHalfLifeMs, config)).toBeCloseTo(0.5, 12);
    expect(tradePressureDomain.decayWeight(2 * TP.decayHalfLifeMs, config)).toBeCloseTo(0.25, 12);
  });

  test('negative age is rejected (future trades never contribute)', () => {
    expect(() => tradePressureDomain.decayWeight(-1, config)).toThrow(/non-negative/);
  });

  test('the evaluation window is a fixed multiple of the half-life', () => {
    expect(tradePressureDomain.pressureWindowMs(config)).toBe(
      tradePressureDomain.PRESSURE_WINDOW_HALF_LIVES * TP.decayHalfLifeMs
    );
  });

  test('a trade older than the window contributes exactly nothing', () => {
    const windowMs = tradePressureDomain.pressureWindowMs(config);
    const result = tradePressureDomain.computeTradePressure({
      transactions: [tx('BUY', TP.volumeNormalizationAmount, NOW - windowMs - 1)],
      nowMs: NOW,
      config
    });
    expect(result.buyPressure).toBe(0);
    expect(result.pressureModifier).toBe(0);
  });

  test('a trade inside the window decays by its exact age', () => {
    const age = TP.decayHalfLifeMs; // one half-life old
    const result = tradePressureDomain.computeTradePressure({
      transactions: [tx('BUY', TP.volumeNormalizationAmount, NOW - age)],
      nowMs: NOW,
      config
    });
    expect(result.buyPressure).toBeCloseTo(TP.maxPerTradeInfluence * 0.5, 12);
  });

  test('a trade executed after the evaluated instant contributes nothing', () => {
    const result = tradePressureDomain.computeTradePressure({
      transactions: [tx('BUY', TP.volumeNormalizationAmount, NOW + 1000)],
      nowMs: NOW,
      config
    });
    expect(result.buyPressure).toBe(0);
  });
});

describe('SIM-11: bounded totals and anti transaction-spam', () => {
  test('buy and sell sides are clamped to their configured bounds independently', () => {
    const many = [];
    for (let i = 0; i < 500; i++) {
      many.push(tx('BUY', TP.volumeNormalizationAmount * 10, NOW - i * 100));
      many.push(tx('SELL', TP.volumeNormalizationAmount * 10, NOW - i * 100));
    }
    const result = tradePressureDomain.computeTradePressure({ transactions: many, nowMs: NOW, config });
    expect(result.buyPressure).toBe(TP.maxBuyPressureModifier);
    expect(result.sellPressure).toBe(TP.maxSellPressureModifier);
  });

  test('pressureModifier is buy minus sell and can be negative', () => {
    const result = tradePressureDomain.computeTradePressure({
      transactions: [
        tx('BUY', TP.volumeNormalizationAmount, NOW),
        tx('SELL', TP.volumeNormalizationAmount * 100, NOW),
        tx('SELL', TP.volumeNormalizationAmount * 100, NOW)
      ],
      nowMs: NOW,
      config
    });
    expect(result.pressureModifier).toBeCloseTo(TP.maxPerTradeInfluence - 2 * TP.maxPerTradeInfluence, 12);
    expect(result.pressureModifier).toBeLessThan(0);
  });

  test('one small trade has only a small bounded influence (spam proof)', () => {
    const result = tradePressureDomain.computeTradePressure({
      transactions: [tx('BUY', 1, NOW)],
      nowMs: NOW,
      config
    });
    expect(result.pressureModifier).toBeCloseTo((1 / TP.volumeNormalizationAmount) * TP.maxPerTradeInfluence, 12);
    expect(Math.abs(result.pressureModifier)).toBeLessThanOrEqual(TP.maxPerTradeInfluence);
  });

  test('a spam burst of capped trades can never move the market past the side bounds', () => {
    const spam = Array.from({ length: 10000 }, (_, i) => tx('SELL', TP.volumeNormalizationAmount, NOW - i * 10));
    const result = tradePressureDomain.computeTradePressure({ transactions: spam, nowMs: NOW, config });
    expect(result.sellPressure).toBe(TP.maxSellPressureModifier);
    expect(result.pressureModifier).toBe(-TP.maxSellPressureModifier);
  });

  test('mixed sides net out within the composed modifier', () => {
    const result = tradePressureDomain.computeTradePressure({
      transactions: [
        tx('BUY', TP.volumeNormalizationAmount, NOW),
        tx('SELL', TP.volumeNormalizationAmount / 2, NOW)
      ],
      nowMs: NOW,
      config
    });
    expect(result.pressureModifier).toBeCloseTo(
      TP.maxPerTradeInfluence - 0.5 * TP.maxPerTradeInfluence, 12
    );
  });
});

describe('SIM-11: determinism and validation', () => {
  const sample = [
    tx('BUY', 250, NOW - 30_000),
    tx('SELL', 900, NOW - 90_000),
    tx('BUY', 5000, NOW - 300_000),
    tx('SELL', 25, NOW - 1_000_000)
  ];

  test('same inputs -> identical pressure in every evaluation', () => {
    const a = tradePressureDomain.computeTradePressure({ transactions: sample, nowMs: NOW, config });
    const b = tradePressureDomain.computeTradePressure({ transactions: sample, nowMs: NOW, config });
    expect(b).toEqual(a);
  });

  test('input order does not change the result', () => {
    const a = tradePressureDomain.computeTradePressure({ transactions: sample, nowMs: NOW, config });
    const b = tradePressureDomain.computeTradePressure({ transactions: sample.slice().reverse(), nowMs: NOW, config });
    expect(b).toEqual(a);
  });

  test('malformed transactions are rejected, never silently skipped', () => {
    expect(() => tradePressureDomain.computeTradePressure({ transactions: 'nope', nowMs: NOW, config })).toThrow(/array/);
    expect(() => tradePressureDomain.computeTradePressure({ transactions: [tx('HOLD', 1, NOW)], nowMs: NOW, config })).toThrow(/BUY or SELL/);
    expect(() => tradePressureDomain.computeTradePressure({ transactions: [{ type: 'BUY', notional: 'x', atMs: NOW }], nowMs: NOW, config })).toThrow(/finite number/);
    expect(() => tradePressureDomain.computeTradePressure({ transactions: [null], nowMs: NOW, config })).toThrow(/objects/);
  });

  test('the resolved default config keeps the anti-spam ordering (per-trade cap within the side bounds)', () => {
    expect(TP.maxPerTradeInfluence).toBeLessThanOrEqual(Math.min(TP.maxBuyPressureModifier, TP.maxSellPressureModifier));
  });
});

describe('SIM-11: pressure composes into the single unified price path', () => {
  const BASE = {
    seed: 'pressure-parity-seed',
    coinId: 2,
    baselinePrice: 1.37,
    roundStartMs: NOW - 10 * 60 * 1000,
    nowMs: NOW,
    amplitude: 1,
    lifecycleState: 'GROWTH',
    cycleProgress: 0.3
  };

  test('buy pressure lifts the unified price and sell pressure lowers it, bounded', () => {
    const flat = priceEngine.unifiedPriceAt({ ...BASE, pressureModifier: 0 });
    const bought = priceEngine.unifiedPriceAt({ ...BASE, pressureModifier: TP.maxBuyPressureModifier });
    const sold = priceEngine.unifiedPriceAt({ ...BASE, pressureModifier: -TP.maxSellPressureModifier });
    expect(bought).toBeGreaterThan(flat);
    expect(sold).toBeLessThan(flat);
    // The applied shift is exactly the bounded modifier, no more.
    expect(bought / flat).toBeLessThanOrEqual(1 + TP.maxBuyPressureModifier + 1e-9);
    expect(flat / sold).toBeLessThanOrEqual(1 + TP.maxSellPressureModifier + 1e-9);
  });

  test('an out-of-range pressure value is clamped by the normal-modifier limit, never runaway', () => {
    const extreme = priceEngine.unifiedPriceAt({ ...BASE, pressureModifier: 5 });
    const atClamp = priceEngine.unifiedPriceAt({ ...BASE, pressureModifier: priceEngine.NORMAL_MODIFIER_LIMIT });
    expect(extreme).toBe(atClamp);
    expect(Number.isFinite(extreme)).toBe(true);
    expect(extreme).toBeGreaterThan(0);
  });

  test('pressure defaults to zero: existing callers are unaffected', () => {
    const without = priceEngine.computeUnifiedPrice({ ...BASE });
    const explicitZero = priceEngine.computeUnifiedPrice({ ...BASE, pressureModifier: 0 });
    expect(explicitZero.price).toBe(without.price);
  });
});
