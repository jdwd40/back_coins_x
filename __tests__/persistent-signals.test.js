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
const marketDomain = require('../game/marketDomain');
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

describe('Wave 3 correction: the past leg keeps the full public lookback and never sees current/future state', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // A real committed checkpoint at the given instant (row-shaped, exactly
  // what models/pricingCheckpoint.model.js persists and hands back).
  function realCheckpointAt({ coin = COIN, checkpointMs }) {
    return persistentPricing.extractPersistentCheckpoint({
      seed: SEED,
      coinId: coin.coinId,
      archetypeId: coin.archetypeId,
      originMs: ORIGIN_MS,
      nowMs: checkpointMs,
      reference: coin.reference,
      environment: NEUTRAL_ENVIRONMENT,
      stored: null
    });
  }

  test('a fresh checkpoint (~30s old) does not collapse the configured 60s lookback; the past leg receives the intended instant and no future checkpoint', () => {
    const nowMs = 12 * HOUR_MS;
    const lookbackMs = marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS; // 60s
    const checkpoint = realCheckpointAt({ checkpointMs: nowMs - 30 * 1000 });
    expect(checkpoint.checkpointMs).toBe(nowMs - 30 * 1000);

    // Expected values are computed BEFORE spying so the direct engine
    // calls below are not recorded as signal legs.
    const current = persistentPricing.computePersistentPrice({
      seed: SEED, coinId: COIN.coinId, archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS, nowMs, structuralReference: COIN.reference, checkpoint
    });
    const expectedCurrentPrice = marketDomain.roundGamePrice(current.price);
    const pastPrice = persistentPricing.persistentPriceAt({
      seed: SEED, coinId: COIN.coinId, archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS, nowMs: nowMs - lookbackMs, structuralReference: COIN.reference
    });
    const expectedChangePct = Math.round(((expectedCurrentPrice - pastPrice) / pastPrice) * 10000) / 100;

    const currentLegSpy = jest.spyOn(persistentPricing, 'computePersistentPrice');
    const pastLegSpy = jest.spyOn(persistentPricing, 'persistentPriceAt');
    const signal = persistentSignals.computePersistentCoinSignal({
      seed: SEED,
      coinId: COIN.coinId,
      archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS,
      nowMs,
      structuralReference: COIN.reference,
      checkpoint,
      lookbackMs
    });

    // The current leg prices the now instant with the committed checkpoint.
    expect(currentLegSpy).toHaveBeenCalledTimes(1);
    expect(currentLegSpy.mock.calls[0][0].nowMs).toBe(nowMs);
    expect(currentLegSpy.mock.calls[0][0].checkpoint).toBe(checkpoint);
    // The past leg opens the FULL configured lookback behind now — never
    // clamped forward to the fresh (30s-old) checkpoint — and is handed no
    // checkpoint from its future.
    expect(pastLegSpy).toHaveBeenCalledTimes(1);
    expect(pastLegSpy.mock.calls[0][0].nowMs).toBe(nowMs - lookbackMs);
    expect(pastLegSpy.mock.calls[0][0].checkpoint).toBeNull();
    // Behavioural parity: the published recent change is exactly the
    // engine's committed movement over the full 60s window.
    expect(Object.is(signal.currentPrice, expectedCurrentPrice)).toBe(true);
    expect(Object.is(signal.recentChangePct, expectedChangePct)).toBe(true);
    // The collapsed Wave 3 window (checkpoint instant) would have priced a
    // different open; the corrected window genuinely spans 60s.
    const collapsedOpen = persistentPricing.persistentPriceAt({
      seed: SEED, coinId: COIN.coinId, archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS, nowMs: nowMs - 30 * 1000, structuralReference: COIN.reference,
      checkpoint
    });
    const collapsedPct = Math.round(((expectedCurrentPrice - collapsedOpen) / collapsedOpen) * 10000) / 100;
    expect(signal.recentChangePct).not.toBe(collapsedPct);
  });

  test('the current event modifier affects the current leg only — the past leg stays neutral', () => {
    const nowMs = 20 * HOUR_MS;
    const lookbackMs = marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS;
    const pastPrice = persistentPricing.persistentPriceAt({
      seed: SEED, coinId: COIN.coinId, archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS, nowMs: nowMs - lookbackMs, structuralReference: COIN.reference
    });
    const modifiedCurrent = persistentPricing.persistentPriceAt({
      seed: SEED, coinId: COIN.coinId, archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS, nowMs, structuralReference: COIN.reference, eventModifier: 0.2
    });

    const pastLegSpy = jest.spyOn(persistentPricing, 'persistentPriceAt');
    const base = signalFor({ nowMs }); // zero current events: modifier 0
    const modified = persistentSignals.computePersistentCoinSignal({
      seed: SEED,
      coinId: COIN.coinId,
      archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS,
      nowMs,
      structuralReference: COIN.reference,
      eventModifier: 0.2
    });

    // Every past-leg evaluation — with and without a current event — ran
    // with a NEUTRAL modifier; the current modifier never leaks backward.
    for (const call of pastLegSpy.mock.calls) {
      expect(call[0].eventModifier).toBe(0);
    }
    // The current leg carries the modifier (parity with the engine).
    expect(Object.is(modified.currentPrice, modifiedCurrent)).toBe(true);
    expect(modified.currentPrice).not.toBe(base.currentPrice);
    // The past leg is untouched: both signals divide by the identical
    // committed historical price, so the modifier shows up exactly once —
    // in the recent-change ratio.
    const expectedBasePct = Math.round(((base.currentPrice - pastPrice) / pastPrice) * 10000) / 100;
    const expectedModifiedPct = Math.round(((modified.currentPrice - pastPrice) / pastPrice) * 10000) / 100;
    expect(Object.is(base.recentChangePct, expectedBasePct)).toBe(true);
    expect(Object.is(modified.recentChangePct, expectedModifiedPct)).toBe(true);
    expect(modified.recentChangePct).toBeGreaterThan(base.recentChangePct);
  });

  test('genuine movement across the full lookback yields non-FLAT momentum/recentChangePct', () => {
    // Pinned engine fact for this seed/coin: the 60s window opening at
    // 2h - 60s moves +35.31% — far beyond the public momentum threshold.
    const nowMs = 2 * HOUR_MS;
    const checkpoint = realCheckpointAt({ checkpointMs: nowMs - 30 * 1000 });
    const signal = persistentSignals.computePersistentCoinSignal({
      seed: SEED,
      coinId: COIN.coinId,
      archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS,
      nowMs,
      structuralReference: COIN.reference,
      checkpoint
    });
    expect(signal.recentChangePct).not.toBeNull();
    expect(signal.recentChangePct).toBeGreaterThan(marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT);
    expect(signal.momentum).toBe('UP');
  });

  test('zero current events preserve the baseline: a checkpoint older than the lookback is used and is bit-identical to the origin walk', () => {
    const nowMs = 26 * HOUR_MS;
    const lookbackMs = marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS;
    // Committed HISTORICAL state for the lookback-open instant: usable.
    const checkpoint = realCheckpointAt({ checkpointMs: nowMs - 2 * HOUR_MS });
    expect(checkpoint.checkpointMs).toBeLessThanOrEqual(nowMs - lookbackMs);

    const pastLegSpy = jest.spyOn(persistentPricing, 'persistentPriceAt');
    const withCheckpoint = persistentSignals.computePersistentCoinSignal({
      seed: SEED,
      coinId: COIN.coinId,
      archetypeId: COIN.archetypeId,
      originMs: ORIGIN_MS,
      nowMs,
      structuralReference: COIN.reference,
      eventModifier: 0, // zero current events, explicitly
      checkpoint
    });
    expect(pastLegSpy).toHaveBeenCalledTimes(1);
    expect(pastLegSpy.mock.calls[0][0].nowMs).toBe(nowMs - lookbackMs);
    expect(pastLegSpy.mock.calls[0][0].checkpoint).toBe(checkpoint); // history, not future
    expect(pastLegSpy.mock.calls[0][0].eventModifier).toBe(0);

    // Baseline: no events, no checkpoint (the pre-Wave-3 origin walk).
    const baseline = signalFor({ nowMs });
    expect(withCheckpoint).toEqual(baseline);
    expect(Object.is(withCheckpoint.currentPrice, baseline.currentPrice)).toBe(true);
    expect(Object.is(withCheckpoint.recentChangePct, baseline.recentChangePct)).toBe(true);
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
