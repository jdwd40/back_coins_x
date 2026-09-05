// Persistent-market Stage 2: persistent-safe pricing (game/persistentPricing.js, master plan §21-27).
//
// Pins the hard invariants of the persistent pricing composition:
//   * determinism (same inputs -> identical price, Object.is);
//   * §22 log-neutral structural drift (mean log drift ~ 0 in the neutral
//     environment, over deterministic seeded draws);
//   * origin == sequential-checkpoint continuation BIT-FOR-BIT, including
//     chained checkpoints, the in-flight episode rule, and a time-varying
//     environment (committed historical semantics, §25);
//   * loud validation of corrupt/future/wrong-identity checkpoints;
//   * §24 decaying crash damage (old damage decays toward neutral);
//   * §23 restoring force (no runaway / no floor collapse over long
//     horizons);
//   * §27 living positive floor (floor touch never kills; recovery after);
//   * explicit archetype (§29 — never the silent MOON default);
//   * bidirectional condition / structural-reference / decaying-peak
//     transitions (§11/§23/§26).

const marketDomain = require('../game/marketDomain');
const persistentPricing = require('../game/persistentPricing');
const { NEUTRAL_ENVIRONMENT } = require('../game/marketEnvironment');

jest.setTimeout(180000);

const SEED = 'stage2-persistent-pricing-test-seed';
const ORIGIN_MS = 0;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// The canonical active catalogue (mirrors simulation/roundEnvironment.js).
const COINS = [
  { coinId: 1, symbol: 'FTR', archetypeId: 'ZIP', reference: 0.10 },
  { coinId: 2, symbol: 'NVC', archetypeId: 'MOON', reference: 1.37 },
  { coinId: 3, symbol: 'BYT', archetypeId: 'RUG', reference: 0.12 },
  { coinId: 4, symbol: 'DGV', archetypeId: 'ZIP', reference: 0.10 },
  { coinId: 5, symbol: 'CYB', archetypeId: 'HODL', reference: 96.45 },
  { coinId: 6, symbol: 'BLN', archetypeId: 'BULL', reference: 43.46 },
  { coinId: 7, symbol: 'STF', archetypeId: 'MOON', reference: 3.91 },
  { coinId: 8, symbol: 'JDC', archetypeId: 'BULL', reference: 33.48 },
  { coinId: 9, symbol: 'MTC', archetypeId: 'DEGEN', reference: 0.10 },
  { coinId: 10, symbol: 'CZN', archetypeId: 'HODL', reference: 32.00 }
];

function originPrice({ coin, nowMs, environment = NEUTRAL_ENVIRONMENT }) {
  return persistentPricing.persistentPriceAt({
    seed: SEED,
    coinId: coin.coinId,
    archetypeId: coin.archetypeId,
    originMs: ORIGIN_MS,
    nowMs,
    structuralReference: coin.reference,
    environment
  });
}

function resumedPrice({ coin, nowMs, stored, environment = NEUTRAL_ENVIRONMENT }) {
  return persistentPricing.persistentPriceAt({
    seed: SEED,
    coinId: coin.coinId,
    archetypeId: coin.archetypeId,
    originMs: ORIGIN_MS,
    nowMs,
    structuralReference: coin.reference,
    environment,
    checkpoint: stored
  });
}

function freeze({ coin, nowMs, stored = null, environment = NEUTRAL_ENVIRONMENT }) {
  return persistentPricing.extractPersistentCheckpoint({
    seed: SEED,
    coinId: coin.coinId,
    archetypeId: coin.archetypeId,
    originMs: ORIGIN_MS,
    nowMs,
    reference: coin.reference,
    environment,
    stored
  });
}

// A deterministic time-varying provider (committed-semantics exercise):
// hostile one bucket in three, benign otherwise, by time bucket alone.
const HOSTILE = { ...NEUTRAL_ENVIRONMENT, crashProbabilityModifier: 4, recoveryModifier: 0, structuralBias: -0.1, volatilityScale: 2 };
const BENIGN = { ...NEUTRAL_ENVIRONMENT, crashProbabilityModifier: 0.5, recoveryModifier: 1.5, structuralBias: 0.05 };
function alternatingProvider(bucketMs = 10 * 60 * 1000) {
  return {
    id: 'ALTERNATING',
    environmentAt(nowMs) {
      return Math.floor(nowMs / bucketMs) % 3 === 1 ? HOSTILE : BENIGN;
    }
  };
}

describe('Stage 2 persistent pricing: determinism and log-neutral drift', () => {
  test('same inputs produce bit-identical prices (pure function, no clocks/randomness)', () => {
    for (const coin of COINS) {
      for (const nowMs of [0, 37 * 1000, 61 * 60 * 1000, 2 * DAY_MS + 12345]) {
        const a = originPrice({ coin, nowMs });
        const b = originPrice({ coin, nowMs });
        expect(Object.is(a, b)).toBe(true);
      }
    }
  });

  test('§22: structural drift is symmetric in log space — mean log drift ~ 0 under the neutral environment', () => {
    // The deterministic seeded draws over many coins/cycles must average
    // to approximately zero in LOG space (the V2 arithmetic drift's
    // Jensen decay is deliberately absent).
    let sum = 0;
    let count = 0;
    for (const coin of COINS) {
      const scale = marketDomain.MARKET_ARCHETYPES[coin.archetypeId].drift;
      for (let cycleIndex = 0; cycleIndex < 2000; cycleIndex++) {
        sum += persistentPricing.drawPersistentLogDrift({
          seed: SEED, coinId: coin.coinId, cycleIndex, scale
        });
        count += 1;
      }
    }
    const mean = sum / count;
    // Uniform(-d, d) draws: mean 0. Generous deterministic bound (the
    // seeded sample mean is fixed; this asserts near-zero, not noise).
    expect(Math.abs(mean)).toBeLessThan(0.001);
    // And the drift stream is actually varied (not degenerate).
    let min = Infinity;
    let max = -Infinity;
    for (let cycleIndex = 0; cycleIndex < 500; cycleIndex++) {
      const d = persistentPricing.drawPersistentLogDrift({ seed: SEED, coinId: 9, cycleIndex, scale: 0.06 });
      if (d < min) min = d;
      if (d > max) max = d;
    }
    expect(min).toBeLessThan(-0.02);
    expect(max).toBeGreaterThan(0.02);
  });

  test('§29: archetype is explicit — unknown archetypes fail loudly, never the silent MOON default', () => {
    expect(() => originPrice({ coin: { ...COINS[0], archetypeId: 'MOONISH' }, nowMs: 1000 })).toThrow(/explicit known archetype/);
    expect(() => originPrice({ coin: { ...COINS[0], archetypeId: undefined }, nowMs: 1000 })).toThrow(/explicit known archetype/);
    expect(() => originPrice({ coin: { ...COINS[0], archetypeId: null }, nowMs: 1000 })).toThrow(/explicit known archetype/);
  });
});

describe('Stage 2 persistent pricing: checkpoint bit-identity', () => {
  test('origin == single-checkpoint resume, bit-for-bit, for every coin', () => {
    const checkpointAtMs = 26 * HOUR_MS + 41 * 60 * 1000 + 7331;
    for (const coin of COINS) {
      const stored = freeze({ coin, nowMs: checkpointAtMs });
      expect(stored.activationContext).toBe('PERSISTENT');
      for (const deltaMs of [0, 1, 5000, 90 * 1000, 7 * 60 * 1000, 23 * HOUR_MS]) {
        const tMs = checkpointAtMs + deltaMs;
        const origin = originPrice({ coin, nowMs: tMs });
        const resumed = resumedPrice({ coin, nowMs: tMs, stored });
        expect(Object.is(origin, resumed)).toBe(true);
      }
    }
  });

  test('origin == chained-checkpoint continuation, bit-for-bit, through many sequential freezes', () => {
    const stepMs = 30 * 60 * 1000; // the live writer cadence
    const steps = 48; // 24 hours of chained checkpoints
    for (const coin of COINS) {
      let stored = null;
      for (let s = 1; s <= steps; s++) {
        const tMs = s * stepMs;
        const origin = originPrice({ coin, nowMs: tMs });
        const resumed = resumedPrice({ coin, nowMs: tMs, stored });
        expect(Object.is(origin, resumed)).toBe(true);
        stored = freeze({ coin, nowMs: tMs, stored });
      }
      // The chained accumulator genuinely advanced (episodes + cycles).
      expect(stored.crashEpisodeIndex).toBeGreaterThan(100);
      expect(stored.domainCycleIndex).toBeGreaterThan(50);
    }
  });

  test('bit-identity holds under a time-varying environment (committed historical semantics, §25)', () => {
    const provider = alternatingProvider();
    const stepMs = 30 * 60 * 1000;
    for (const coin of COINS) {
      let stored = null;
      for (let s = 1; s <= 36; s++) {
        const tMs = s * stepMs;
        const origin = originPrice({ coin, nowMs: tMs, environment: provider });
        const resumed = resumedPrice({ coin, nowMs: tMs, stored, environment: provider });
        expect(Object.is(origin, resumed)).toBe(true);
        stored = freeze({ coin, nowMs: tMs, stored, environment: provider });
      }
    }
  });

  test('the in-flight episode rule: a checkpoint taken mid-crash/mid-rally resumes bit-identically', () => {
    // Find the first activated episode window for a coin under the
    // neutral environment, then freeze INSIDE it (crash and rally).
    const coin = COINS[8]; // DEGEN — lively
    const engine = require('../game/priceEngine');
    let window_ = null;
    let cursor = ORIGIN_MS;
    for (let index = 1; index < 500 && !window_; index++) {
      const episode = engine.drawCrashEpisode({ seed: SEED, coinId: coin.coinId, episodeIndex: index });
      const start = cursor + episode.gapMs;
      const end = start + episode.crashDurationMs + episode.rallyDurationMs;
      const resolved = persistentPricing.resolvePersistentEpisode(
        episode, NEUTRAL_ENVIRONMENT, require('../game/simulationConfig').resolveSimulationConfig()
      );
      if (resolved.activated) {
        window_ = { start, crashEnd: start + episode.crashDurationMs, end };
      }
      cursor = end;
    }
    expect(window_).not.toBeNull();
    for (const tMs of [
      window_.start + Math.floor((window_.crashEnd - window_.start) / 2), // mid-crash
      window_.crashEnd + Math.floor((window_.end - window_.crashEnd) / 2) // mid-rally
    ]) {
      const stored = freeze({ coin, nowMs: tMs });
      // The in-flight episode was NOT frozen past its predecessor.
      expect(stored.crashCursorMs).toBeLessThanOrEqual(window_.start);
      const origin = originPrice({ coin, nowMs: tMs });
      const resumed = resumedPrice({ coin, nowMs: tMs, stored });
      expect(Object.is(origin, resumed)).toBe(true);
      // And just after the episode completes, still identical.
      const after = window_.end + 1000;
      const originAfter = originPrice({ coin, nowMs: after });
      const resumedAfter = resumedPrice({ coin, nowMs: after, stored });
      expect(Object.is(originAfter, resumedAfter)).toBe(true);
    }
  });

  test('corrupt, future or wrong-identity checkpoints fail loudly (§18)', () => {
    const coin = COINS[0];
    const stored = freeze({ coin, nowMs: HOUR_MS });
    const tMs = 2 * HOUR_MS;
    expect(() => resumedPrice({ coin, nowMs: tMs, stored: { ...stored, seed: 'other-seed' } })).toThrow(/identity mismatch/);
    expect(() => resumedPrice({ coin, nowMs: tMs, stored: { ...stored, coinId: 99 } })).toThrow(/identity mismatch/);
    expect(() => resumedPrice({ coin, nowMs: stored.checkpointMs - 1, stored })).toThrow(/from the future/);
    expect(() => resumedPrice({ coin, nowMs: tMs, stored: { ...stored, crashFactor: 0 } })).toThrow(/damageFactor/);
    expect(() => resumedPrice({ coin, nowMs: tMs, stored: { ...stored, crashFactor: -2 } })).toThrow(/damageFactor/);
    expect(() => resumedPrice({ coin, nowMs: tMs, stored: { ...stored, domainAnchor: 0 } })).toThrow(/anchor/);
    expect(() => resumedPrice({ coin, nowMs: tMs, stored: { ...stored, crashEpisodeIndex: 0 } })).toThrow(/episodeIndex/);
    expect(() => resumedPrice({ coin, nowMs: tMs, stored: { ...stored, crashCursorMs: tMs + 1 } })).toThrow(/future/);
    // A V2 lifecycle-gated accumulator is a foreign format in the
    // persistent path — loud refusal, never a silent resume.
    expect(() => resumedPrice({ coin, nowMs: tMs, stored: { ...stored, activationContext: 'GROWTH' } })).toThrow(/PERSISTENT/);
  });
});

describe('Stage 2 persistent pricing: §24 decaying crash damage', () => {
  test('committed damage decays toward neutral with the configured half-life', () => {
    const coin = COINS[9]; // HODL — slower cycles, long episode walk
    const hostile = { ...NEUTRAL_ENVIRONMENT, crashProbabilityModifier: 4, recoveryModifier: 0 };
    const quiescent = { ...NEUTRAL_ENVIRONMENT, crashProbabilityModifier: 0 };
    const config = require('../game/simulationConfig').resolveSimulationConfig();
    const hl = config.persistent.crashDamageHalfLifeMs;

    // Accumulate damage under the hostile environment for 6 hours, then
    // COMMIT it via a checkpoint (the production pattern: history commits
    // through the accumulator, §25).
    const t0 = 6 * HOUR_MS;
    const stored = freeze({ coin, nowMs: t0, environment: hostile });
    expect(stored.crashFactor).toBeLessThan(0.95); // damage genuinely committed

    // Resume under quiescent conditions (no new crashes can activate):
    // the committed damage simply decays with the configured half-life.
    const halfLives = 3;
    const t1 = t0 + halfLives * hl;
    const resumed = persistentPricing.evaluatePersistentDamage({
      seed: SEED, coinId: coin.coinId, originMs: ORIGIN_MS, nowMs: t1,
      environment: quiescent,
      checkpoint: persistentPricing.resolvePersistentCheckpoint({ stored, seed: SEED, coinId: coin.coinId, nowMs: t1 }).crashCheckpoint
    }).committedDamageFactor;
    const expected = Math.pow(stored.crashFactor, Math.pow(2, -(t1 - stored.crashCursorMs) / hl));
    expect(resumed).toBeGreaterThan(stored.crashFactor); // genuinely recovering
    expect(Math.abs(resumed - expected) / expected).toBeLessThan(1e-9);
    // And after MANY half-lives the old damage is effectively neutralised
    // (ordinary old crashes never multiply forever, §24).
    const t2 = t0 + 12 * hl;
    const longResumed = persistentPricing.evaluatePersistentDamage({
      seed: SEED, coinId: coin.coinId, originMs: ORIGIN_MS, nowMs: t2,
      environment: quiescent,
      checkpoint: persistentPricing.resolvePersistentCheckpoint({ stored, seed: SEED, coinId: coin.coinId, nowMs: t2 }).crashCheckpoint
    }).committedDamageFactor;
    expect(longResumed).toBeGreaterThan(Math.pow(stored.crashFactor, 0.01)); // ~neutralised
    expect(longResumed).toBeLessThanOrEqual(1.0000001);
  });

  test('ordinary old crashes never multiply forever: long-run committed damage stays bounded', () => {
    // Under the neutral environment over 60 days the committed damage
    // factor neither collapses toward zero nor explodes — the Stage 1
    // V2 floor-collapse behaviour is structurally absent.
    const coin = COINS[2]; // MOON
    const factor = persistentPricing.evaluatePersistentDamage({
      seed: SEED, coinId: coin.coinId, originMs: ORIGIN_MS, nowMs: 60 * DAY_MS, environment: NEUTRAL_ENVIRONMENT
    }).committedDamageFactor;
    expect(factor).toBeGreaterThan(0.05);
    expect(factor).toBeLessThan(20);
  });
});

describe('Stage 2 persistent pricing: long-horizon stability (§23/§27)', () => {
  test('30 days of checkpointed neutral pricing: finite, positive, no runaway, no floor collapse', () => {
    const stepMs = 30 * 60 * 1000;
    const steps = (30 * DAY_MS) / stepMs;
    for (const coin of COINS) {
      let stored = null;
      let minPrice = Infinity;
      let maxPrice = 0;
      let floorTouches = 0;
      for (let s = 1; s <= steps; s++) {
        const tMs = s * stepMs;
        const price = resumedPrice({ coin, nowMs: tMs, stored });
        expect(Number.isFinite(price)).toBe(true);
        expect(price).toBeGreaterThan(0);
        if (price < minPrice) minPrice = price;
        if (price > maxPrice) maxPrice = price;
        if (price === marketDomain.MIN_POSITIVE_PRICE) floorTouches += 1;
        stored = freeze({ coin, nowMs: tMs, stored });
      }
      // §23/§27: the restoring force keeps the neutral market in a sane
      // band around the reference — no runaway, and the living floor is
      // never pinned (the Stage 1 V2 floor collapse is replaced).
      expect(minPrice).toBeGreaterThan(coin.reference * 0.02);
      expect(maxPrice).toBeLessThan(coin.reference * 50);
      expect(floorTouches).toBe(0);
      // Behavioural variety: the coin actually moved.
      expect(maxPrice / minPrice).toBeGreaterThan(1.05);
    }
  });

  test('the un-checkpointed origin walk provably fails the horizon the checkpoints survive', () => {
    // 30 days at 30-minute cadence exceeds the fastest coin's bounded-walk
    // guard from the origin — the checkpoint path is load-bearing.
    const coin = COINS[0]; // ZIP — fastest cycles
    expect(() => originPrice({ coin, nowMs: 30 * DAY_MS })).toThrow(/bounded-walk guard|timeline walk/);
  });

  test('§27: the floor is a living guard, never a death sentence', () => {
    // Drive savage damage under a maximally hostile environment: the
    // price may touch the floor but stays finite/positive, and the coin
    // prices again under recovery conditions (no implicit death).
    const coin = COINS[3];
    const savage = { ...NEUTRAL_ENVIRONMENT, crashProbabilityModifier: 4, recoveryModifier: 0, structuralBias: -0.5, volatilityScale: 4 };
    const t1 = 12 * HOUR_MS;
    const p1 = originPrice({ coin, nowMs: t1, environment: savage });
    expect(Number.isFinite(p1)).toBe(true);
    expect(p1).toBeGreaterThanOrEqual(marketDomain.MIN_POSITIVE_PRICE);
    const p2 = originPrice({ coin, nowMs: t1 + 48 * HOUR_MS, environment: NEUTRAL_ENVIRONMENT });
    expect(Number.isFinite(p2)).toBe(true);
    expect(p2).toBeGreaterThan(0);
  });
});

describe('Stage 2 persistent pricing: coin-state transitions (§11/§23/§26)', () => {
  test('§23 advanceStructuralReference: slow, bounded, condition-driven, sign-correct', () => {
    const ref = 10;
    // Zero elapsed: unchanged.
    expect(persistentPricing.advanceStructuralReference({ structuralReference: ref, condition: 0.8, elapsedMs: 0 })).toBe(ref);
    // Positive condition lifts; negative lowers; neutral condition holds.
    const up = persistentPricing.advanceStructuralReference({ structuralReference: ref, condition: 1, elapsedMs: DAY_MS });
    const down = persistentPricing.advanceStructuralReference({ structuralReference: ref, condition: -1, elapsedMs: DAY_MS });
    const flat = persistentPricing.advanceStructuralReference({ structuralReference: ref, condition: 0, elapsedMs: DAY_MS });
    expect(up).toBeGreaterThan(ref);
    expect(down).toBeLessThan(ref);
    expect(flat).toBe(ref);
    // Slow: a full day at max condition moves less than the configured cap.
    expect(Math.log(up / ref)).toBeLessThanOrEqual(0.2 + 1e-12);
    expect(Math.log(up / ref)).toBeCloseTo(0.05, 6);
    // Environment bias shifts directly.
    const biased = persistentPricing.advanceStructuralReference({
      structuralReference: ref, condition: 0, elapsedMs: DAY_MS,
      environment: { ...NEUTRAL_ENVIRONMENT, structuralBias: 0.1 }
    });
    expect(Math.log(biased / ref)).toBeCloseTo(0.1, 6);
    // Loud validation.
    expect(() => persistentPricing.advanceStructuralReference({ structuralReference: 0, condition: 0, elapsedMs: 1 })).toThrow(/strictly positive/);
    expect(() => persistentPricing.advanceStructuralReference({ structuralReference: ref, condition: 2, elapsedMs: 1 })).toThrow(/\[-1, 1\]/);
    expect(() => persistentPricing.advanceStructuralReference({ structuralReference: ref, condition: 0, elapsedMs: -1 })).toThrow(/non-negative/);
  });

  test('§26 advancePeakReference: decays toward the living price, never below it, lifts on new highs', () => {
    // Decay: an old peak halves per configured half-life while price sits still.
    const config = require('../game/simulationConfig').resolveSimulationConfig();
    const hl = config.persistent.peakReferenceHalfLifeMs;
    const decayed = persistentPricing.advancePeakReference({ peakReference: 100, price: 10, elapsedMs: hl });
    expect(decayed).toBeCloseTo(50, 6);
    // Never below the current price.
    const floored = persistentPricing.advancePeakReference({ peakReference: 12, price: 10, elapsedMs: 10 * hl });
    expect(floored).toBe(10);
    // Lifts on new highs.
    expect(persistentPricing.advancePeakReference({ peakReference: 10, price: 42, elapsedMs: 1000 })).toBe(42);
    // Loud validation.
    expect(() => persistentPricing.advancePeakReference({ peakReference: 0, price: 1, elapsedMs: 1 })).toThrow(/strictly positive/);
    expect(() => persistentPricing.advancePeakReference({ peakReference: 1, price: 1, elapsedMs: -1 })).toThrow(/non-negative/);
    // Drawdown helper.
    expect(persistentPricing.computePeakDrawdown(100, 75)).toBeCloseTo(0.25, 12);
    expect(persistentPricing.computePeakDrawdown(100, 150)).toBe(0);
  });

  test('§11 advanceCondition: bidirectional, rate-bounded, mean-reverting, loud', () => {
    // Rises on good behaviour (positive return, below-typical drawdown,
    // above-typical damage recovery).
    const rising = persistentPricing.advanceCondition({
      condition: 0, archetypeId: 'DEGEN', elapsedMs: DAY_MS,
      recentLogReturn: 0.2, drawdownFromPeak: 0.1, logCommittedDamage: 0.3
    });
    expect(rising).toBeGreaterThan(0);
    // Falls on crashes/drawdown far above the archetype's typical level.
    const falling = persistentPricing.advanceCondition({
      condition: 0, archetypeId: 'DEGEN', elapsedMs: DAY_MS,
      recentLogReturn: -0.2, drawdownFromPeak: 0.95, logCommittedDamage: -0.8
    });
    expect(falling).toBeLessThan(0);
    // Rate-bounded: one day never moves more than maxChangePerDay.
    expect(Math.abs(rising)).toBeLessThanOrEqual(0.3 + 1e-12);
    expect(Math.abs(falling)).toBeLessThanOrEqual(0.3 + 1e-12);
    // Bounded range always.
    const extreme = persistentPricing.advanceCondition({
      condition: 0.99, archetypeId: 'ZIP', elapsedMs: 30 * DAY_MS, recentLogReturn: 5, netEventModifier: 0.06
    });
    expect(extreme).toBeLessThanOrEqual(1);
    expect(extreme).toBeGreaterThanOrEqual(-1);
    // Mean reversion: with archetype-TYPICAL inputs (zero excess), the
    // target is neutral and condition drifts toward 0.
    const reverted = persistentPricing.advanceCondition({
      condition: 0.5, archetypeId: 'ZIP', elapsedMs: DAY_MS,
      drawdownFromPeak: 0.35, logCommittedDamage: -0.12
    });
    expect(reverted).toBeLessThan(0.5);
    expect(reverted).toBeGreaterThan(0);
    // Centering: a HEALTHIER-than-typical coin (low drawdown, recovered
    // damage) sees its condition improve even with zero recent return.
    const healthier = persistentPricing.advanceCondition({
      condition: 0, archetypeId: 'ZIP', elapsedMs: DAY_MS,
      recentLogReturn: 0, drawdownFromPeak: 0.05, logCommittedDamage: 0.2
    });
    expect(healthier).toBeGreaterThan(0);
    // Environment bias moves condition (negative regime drags), isolated
    // at archetype-typical inputs (zero excess).
    const dragged = persistentPricing.advanceCondition({
      condition: 0, archetypeId: 'ZIP', elapsedMs: DAY_MS,
      drawdownFromPeak: 0.35, logCommittedDamage: -0.12,
      environment: { ...NEUTRAL_ENVIRONMENT, structuralBias: -0.2 }
    });
    expect(dragged).toBeLessThan(0);
    // Loud validation (archetype explicit — never defaulted).
    expect(() => persistentPricing.advanceCondition({ condition: -2, archetypeId: 'ZIP', elapsedMs: 1 })).toThrow(/\[-1, 1\]/);
    expect(() => persistentPricing.advanceCondition({ condition: 0, archetypeId: 'ZIP', elapsedMs: -1 })).toThrow(/non-negative/);
    expect(() => persistentPricing.advanceCondition({ condition: 0, archetypeId: 'ZIP', elapsedMs: 1, archetypeId: undefined })).toThrow(/explicit known archetype/);
    expect(() => persistentPricing.advanceCondition({ condition: 0, archetypeId: undefined, elapsedMs: 1 })).toThrow(/explicit known archetype/);
  });

  test('§11 condition labels are derived UI vocabulary over the scalar', () => {
    expect(persistentPricing.conditionLabel(0.9)).toBe('THRIVING');
    expect(persistentPricing.conditionLabel(0.3)).toBe('HEALTHY');
    expect(persistentPricing.conditionLabel(0)).toBe('UNSTABLE');
    expect(persistentPricing.conditionLabel(-0.5)).toBe('STRUGGLING');
    expect(persistentPricing.conditionLabel(-0.9)).toBe('CRITICAL');
    expect(persistentPricing.CONDITION_LABELS).toEqual(['THRIVING', 'HEALTHY', 'UNSTABLE', 'STRUGGLING', 'CRITICAL']);
  });
});
