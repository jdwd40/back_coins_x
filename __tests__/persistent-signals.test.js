// Persistent-market Stage 2: persistent public signals + bot fairness
// (master plan §10, Stage 2 scope: botService/allowlists,
// marketSignalsService, collapseRiskDomain for the persistent world).
//
// Pins: the exact persistent public-signal key contract, legal public
// vocabularies, determinism, human/bot parity (the SAME shared signal the
// bot observation adapter carries), price/signal parity with the traded
// price, the persistent collapse-risk signal's public-inputs-only
// behaviour, and the redaction contract — a persistent signal poisoned
// with hidden internals (seed, damage, regime rolls, structural
// reference) fails the exact-key allowlist enforced by
// botService.assertPublicBotState.

const botService = require('../game/botService');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const persistentPricing = require('../game/persistentPricing');
const persistentSignals = require('../game/persistentSignals');
const { NEUTRAL_ENVIRONMENT } = require('../game/marketEnvironment');

jest.setTimeout(120000);

const SEED = 'stage2-persistent-signals-test-seed';
const ORIGIN_MS = 0;
const HOUR_MS = 60 * 60 * 1000;

const COIN = { coinId: 9, symbol: 'MTC', archetypeId: 'DEGEN', reference: 0.10 };
const COIN_B = { coinId: 5, symbol: 'CYB', archetypeId: 'HODL', reference: 96.45 };

function signalFor({ coin = COIN, nowMs = 12 * HOUR_MS, condition = 0, environment = NEUTRAL_ENVIRONMENT }) {
  return persistentSignals.computePersistentCoinSignal({
    seed: SEED,
    coinId: coin.coinId,
    archetypeId: coin.archetypeId,
    originMs: ORIGIN_MS,
    nowMs,
    structuralReference: coin.reference,
    condition,
    environment
  });
}

// Assemble a persistent-shaped bot market state (the Stage 8 observation
// adapter's shape): persistent public signals + the bot's own economics,
// under the CURRENT top-level contract enforced by assertPublicBotState.
function persistentBotState({ coins, cash = 5000, apocalypsePercent = 0 }) {
  return {
    coins: coins.map((entry) => ({
      coinId: entry.signal.coinId,
      symbol: entry.symbol,
      currentPrice: entry.signal.currentPrice,
      collapsed: false,
      history: entry.history,
      phase: entry.signal.phase,
      momentum: entry.signal.momentum,
      archetype: entry.signal.archetype,
      collapseRisk: entry.signal.collapseRisk,
      recentChangePct: entry.signal.recentChangePct
    })),
    cash,
    holdings: [],
    apocalypsePercent,
    power: { current: 10, max: 10, regenMsPerPoint: 60000 },
    openPositions: { open: 0, max: 3 }
  };
}

describe('Stage 2 persistent public signals', () => {
  test('the signal carries exactly the public allowlist keys with legal vocabularies', () => {
    for (const condition of [-1, -0.4, 0, 0.6, 1]) {
      const signal = signalFor({ condition });
      expect(Object.keys(signal).sort()).toEqual([...persistentSignals.PERSISTENT_PUBLIC_SIGNAL_KEYS].sort());
      expect(['DIP', 'RISE', 'BOOM', 'FALL']).toContain(signal.phase);
      expect(['UP', 'DOWN', 'FLAT']).toContain(signal.momentum);
      expect(collapseRiskDomain.COLLAPSE_RISK_LEVELS).toContain(signal.collapseRisk);
      expect(persistentPricing.CONDITION_LABELS).toContain(signal.condition);
      expect(persistentPricing.conditionLabel(condition)).toBe(signal.condition);
      // The public payload never carries hidden internals.
      expect(signal).not.toHaveProperty('seed');
      expect(signal).not.toHaveProperty('structuralReference');
      expect(signal).not.toHaveProperty('damageFactor');
      expect(signal).not.toHaveProperty('apocalypsePercent');
      expect(signal).not.toHaveProperty('regime');
    }
  });

  test('determinism: identical inputs reproduce the identical signal (replay-safe)', () => {
    const a = signalFor({ nowMs: 26 * HOUR_MS, condition: -0.3 });
    const b = signalFor({ nowMs: 26 * HOUR_MS, condition: -0.3 });
    expect(a).toEqual(b);
    expect(Object.is(a.currentPrice, b.currentPrice)).toBe(true);
  });

  test('signal price parity: the published price is the traded persistent price (no divergence)', () => {
    const nowMs = 30 * HOUR_MS;
    const signal = signalFor({ coin: COIN_B, nowMs });
    const traded = persistentPricing.persistentPriceAt({
      seed: SEED,
      coinId: COIN_B.coinId,
      archetypeId: COIN_B.archetypeId,
      originMs: ORIGIN_MS,
      nowMs,
      structuralReference: COIN_B.reference
    });
    expect(Object.is(signal.currentPrice, traded)).toBe(true);
  });

  test('the dead marker exposes only death and archetype identity', () => {
    const dead = persistentSignals.deadPersistentSignal({ coinId: 3, archetypeId: 'RUG' });
    expect(dead.phase).toBe('DEAD');
    expect(dead.currentPrice).toBe(0);
    expect(dead.collapseRisk).toBe(collapseRiskDomain.DEAD_RISK_MARKER);
    expect(dead.condition).toBeNull();
    expect(dead.dead).toBe(true);
    expect(() => persistentSignals.deadPersistentSignal({ coinId: 3, archetypeId: 'MOON' })).not.toThrow();
    expect(() => persistentSignals.deadPersistentSignal({ coinId: 3, archetypeId: 'NOPE' })).toThrow(/explicit known archetype/);
  });
});

describe('Stage 2 persistent collapse-risk signal (public inputs only)', () => {
  test('condition drives danger: worse public condition means higher risk', () => {
    const levels = new Map();
    for (const condition of [0.8, 0, -0.5, -1]) {
      levels.set(condition, collapseRiskDomain.getPersistentCollapseRisk({
        seed: SEED, coinId: COIN.coinId, archetypeId: COIN.archetypeId,
        condition, phase: 'FALL', momentum: 'DOWN', recentChangePct: -12, nowMs: 12 * HOUR_MS
      }));
    }
    const ord = collapseRiskDomain.COLLAPSE_RISK_ORDINAL;
    expect(ord[levels.get(-1)]).toBeGreaterThan(ord[levels.get(0.8)]);
    expect(ord[levels.get(-1)]).toBeGreaterThanOrEqual(ord[levels.get(-0.5)]);
    expect(ord[levels.get(0.8)]).toBeLessThanOrEqual(ord[levels.get(0)]);
  });

  test('loud validation: condition range, seed and archetype', () => {
    expect(() => collapseRiskDomain.conditionDanger(-2)).toThrow(/\[-1, 1\]/);
    expect(() => collapseRiskDomain.getPersistentCollapseRisk({
      seed: SEED, coinId: 1, condition: 0.5, phase: 'DIP', momentum: 'UP', recentChangePct: 1, nowMs: 0
    })).not.toThrow();
    expect(() => collapseRiskDomain.getPersistentCollapseRisk({
      seed: SEED, coinId: 1, archetypeId: 'NOPE', condition: 0, phase: 'DIP', momentum: 'UP', recentChangePct: 1, nowMs: 0
    })).toThrow(/known archetype/);
  });

  test('deterministic replay: same inputs, same level; noise streams vary by coin', () => {
    const options = {
      seed: SEED, coinId: 1, archetypeId: 'ZIP', condition: -0.6,
      phase: 'FALL', momentum: 'DOWN', recentChangePct: -8, nowMs: 50 * HOUR_MS
    };
    expect(collapseRiskDomain.getPersistentCollapseRisk(options))
      .toBe(collapseRiskDomain.getPersistentCollapseRisk(options));
    // The seeded personality noise differs across coins (the deliberate
    // imperfection: risk is not a classifier for death order).
    const levels = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((coinId) => collapseRiskDomain.getPersistentCollapseRiskScore({
      ...options, coinId, archetypeId: null
    })));
    expect(levels.size).toBeGreaterThan(3);
  });
});

describe('Stage 2 bot fairness (assertPublicBotState over persistent-shaped observations)', () => {
  test('a persistent-shaped bot market state passes the exact allowlist', () => {
    const state = persistentBotState({
      coins: [
        { signal: signalFor({ coin: COIN }), symbol: COIN.symbol, history: [0.09, 0.1, 0.11] },
        { signal: signalFor({ coin: COIN_B }), symbol: COIN_B.symbol, history: [95, 96, 96.45] }
      ]
    });
    expect(() => botService.assertPublicBotState(state)).not.toThrow();
  });

  test('humans and bots share one signal: the adapter passes the same fields through unchanged', () => {
    const signal = signalFor({ coin: COIN, nowMs: 40 * HOUR_MS, condition: 0.2 });
    const state = persistentBotState({ coins: [{ signal, symbol: COIN.symbol, history: [0.1] }] });
    const coin = state.coins[0];
    expect(coin.currentPrice).toBe(signal.currentPrice);
    expect(coin.phase).toBe(signal.phase);
    expect(coin.momentum).toBe(signal.momentum);
    expect(coin.collapseRisk).toBe(signal.collapseRisk);
    expect(coin.recentChangePct).toBe(signal.recentChangePct);
    expect(coin.archetype).toBe(signal.archetype);
  });

  test('poisoned persistent observations fail closed (no hidden rolls/probabilities reach a bot)', () => {
    const base = persistentBotState({
      coins: [{ signal: signalFor({ coin: COIN }), symbol: COIN.symbol, history: [0.1] }]
    });
    // A coin poisoned with hidden pricing internals.
    expect(() => botService.assertPublicBotState({
      ...base,
      coins: [{ ...base.coins[0], seed: SEED }]
    })).toThrow(/forbidden:seed/);
    expect(() => botService.assertPublicBotState({
      ...base,
      coins: [{ ...base.coins[0], damageFactor: 0.5 }]
    })).toThrow(/forbidden:damageFactor/);
    expect(() => botService.assertPublicBotState({
      ...base,
      coins: [{ ...base.coins[0], nextRegimeRoll: 0.42 }]
    })).toThrow(/forbidden:nextRegimeRoll/);
    expect(() => botService.assertPublicBotState({
      ...base,
      coins: [{ ...base.coins[0], structuralReference: 0.1 }]
    })).toThrow(/forbidden:structuralReference/);
    // A poisoned top-level (Director internals leaking to the roster).
    expect(() => botService.assertPublicBotState({
      ...base, directorRolls: [0.1, 0.2]
    })).toThrow(/forbidden:directorRolls/);
  });
});
