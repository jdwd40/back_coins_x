// Persistent-market Stage 1: resumable pricing checkpoints (pure engine).
//
// The stateless engine walks each coin's deterministic market timeline from
// the origin on every evaluation, behind bounded-walk guards
// (marketDomain.MAX_TIMELINE_CYCLES / priceEngine.MAX_CRASH_EPISODES). The
// Stage 1 checkpoints freeze per-coin accumulators so a continuation never
// walks from the origin. This suite pins the hard invariant:
//
//   ORIGIN == SEQUENTIAL-CHECKPOINT CONTINUATION, bit-for-bit (Object.is),
//   at origin, at the checkpoint instant, and through chained checkpoints.
//
// plus the in-flight episode rule (a checkpoint taken mid-crash/mid-rally
// resumes identically), the lifecycle-transition invalidation rule, loud
// validation of corrupt/future/wrong-identity checkpoints, and the long-horizon
// guarantee (sequential checkpoints outlive the bounded-walk guards that the origin
// walk cannot).

const marketDomain = require('../game/marketDomain');
const priceEngine = require('../game/priceEngine');
const pricingCheckpoint = require('../game/pricingCheckpoint');

jest.setTimeout(120000);

const SEED = 'stage1-checkpoint-test-seed';
const ROUND_START_MS = 0;
const COIN_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const BASELINE_BY_COIN = new Map([
  [1, 0.10], [2, 1.37], [3, 0.12], [4, 0.10], [5, 96.45],
  [6, 43.46], [7, 3.91], [8, 33.48], [9, 0.10], [10, 32.00]
]);
const LIFECYCLES = ['GROWTH', 'PLATEAU', 'DECLINE', 'COLLAPSE'];

function originPrice({ coinId, nowMs, lifecycleState = 'GROWTH' }) {
  return priceEngine.unifiedPriceAt({
    seed: SEED,
    coinId,
    baselinePrice: BASELINE_BY_COIN.get(coinId),
    roundStartMs: ROUND_START_MS,
    nowMs,
    amplitude: 1,
    lifecycleState,
    cycleProgress: 0
  });
}

function resumedPrice({ coinId, nowMs, stored, lifecycleState = 'GROWTH' }) {
  const resume = pricingCheckpoint.resolveResumeCheckpoints({
    stored, seed: SEED, coinId, nowMs, lifecycleState
  });
  return priceEngine.unifiedPriceAt({
    seed: SEED,
    coinId,
    baselinePrice: BASELINE_BY_COIN.get(coinId),
    roundStartMs: ROUND_START_MS,
    nowMs,
    amplitude: 1,
    lifecycleState,
    cycleProgress: 0,
    domainCheckpoint: resume.domainCheckpoint,
    crashCheckpoint: resume.crashCheckpoint
  });
}

function freeze({ coinId, nowMs, lifecycleState = 'GROWTH', stored = null }) {
  return pricingCheckpoint.extractPricingCheckpoint({
    seed: SEED,
    coinId,
    roundStartMs: ROUND_START_MS,
    nowMs,
    lifecycleState,
    stored
  });
}

describe('Stage 1 pricing checkpoints: origin/checkpoint bit-identity', () => {
  test('a single checkpoint resumes bit-identically to the origin walk for every coin', () => {
    const checkpointAtMs = 11 * 60 * 1000 + 37 * 1000; // arbitrary mid-round instant
    for (const coinId of COIN_IDS) {
      const stored = freeze({ coinId, nowMs: checkpointAtMs });
      for (const tMs of [checkpointAtMs, checkpointAtMs + 1, checkpointAtMs + 5000, checkpointAtMs + 90 * 1000, checkpointAtMs + 7 * 60 * 1000]) {
        const origin = originPrice({ coinId, nowMs: tMs });
        const resumed = resumedPrice({ coinId, nowMs: tMs, stored });
        expect(Object.is(resumed, origin)).toBe(true);
      }
    }
  });

  test('sequential chained checkpoints stay bit-identical to the origin walk', () => {
    // Chain 24 checkpoints at 45s cadence; at every link the resumed price
    // must equal the origin price at several sample instants.
    for (const coinId of COIN_IDS) {
      let stored = null;
      for (let link = 1; link <= 24; link++) {
        const tMs = link * 45 * 1000;
        stored = freeze({ coinId, nowMs: tMs, stored });
        for (const sample of [tMs, tMs + 1234, tMs + 30 * 1000]) {
          const origin = originPrice({ coinId, nowMs: sample });
          const resumed = resumedPrice({ coinId, nowMs: sample, stored });
          expect(Object.is(resumed, origin)).toBe(true);
        }
      }
    }
  });

  test('the checkpointed evaluation is bit-identical under every constant lifecycle state', () => {
    const checkpointAtMs = 9 * 60 * 1000 + 11 * 1000;
    for (const lifecycleState of LIFECYCLES) {
      for (const coinId of COIN_IDS) {
        const stored = freeze({ coinId, nowMs: checkpointAtMs, lifecycleState });
        for (const tMs of [checkpointAtMs + 1, checkpointAtMs + 60 * 1000, checkpointAtMs + 5 * 60 * 1000]) {
          const origin = originPrice({ coinId, nowMs: tMs, lifecycleState });
          const resumed = resumedPrice({ coinId, nowMs: tMs, stored, lifecycleState });
          expect(Object.is(resumed, origin)).toBe(true);
        }
      }
    }
  });

  test('in-flight episode rule: a checkpoint taken mid-crash/mid-rally resumes bit-identically', () => {
    // Find an instant where a crash/rally episode is genuinely in flight,
    // checkpoint there, and prove the transient state is reproduced (never
    // burned into the accumulator).
    let found = 0;
    for (const coinId of COIN_IDS) {
      for (let tMs = 60 * 1000; tMs < 25 * 60 * 1000 && found < 6; tMs += 7000) {
        const probe = priceEngine.evaluateCrashRallyFactor({
          seed: SEED, coinId, roundStartMs: ROUND_START_MS, nowMs: tMs, lifecycleState: 'COLLAPSE'
        });
        if (!probe.activeEpisode) continue;
        found += 1;
        const stored = freeze({ coinId, nowMs: tMs, lifecycleState: 'COLLAPSE' });
        // The in-flight episode must NOT be frozen: the accumulator's
        // cursor is at or before the active window's start boundary.
        expect(stored.crashCursorMs).toBeLessThanOrEqual(tMs);
        for (const sample of [tMs, tMs + 500, tMs + 60 * 1000, tMs + 4 * 60 * 1000]) {
          const origin = originPrice({ coinId, nowMs: sample, lifecycleState: 'COLLAPSE' });
          const resumed = resumedPrice({ coinId, nowMs: sample, stored, lifecycleState: 'COLLAPSE' });
          expect(Object.is(resumed, origin)).toBe(true);
        }
      }
    }
    // The fixture must actually exercise in-flight episodes, not vacuously pass.
    expect(found).toBeGreaterThan(0);
  });

  test('lifecycle transition invalidates only the crash accumulator and stays bit-identical', () => {
    const checkpointAtMs = 8 * 60 * 1000;
    for (const coinId of COIN_IDS) {
      const stored = freeze({ coinId, nowMs: checkpointAtMs, lifecycleState: 'GROWTH' });
      const tMs = checkpointAtMs + 3 * 60 * 1000;
      // Resume under a DIFFERENT lifecycle: the domain checkpoint still
      // applies, the crash accumulator is discarded (re-walk from origin
      // under the new state) — exactly what the stateless engine computes.
      const resume = pricingCheckpoint.resolveResumeCheckpoints({
        stored, seed: SEED, coinId, nowMs: tMs, lifecycleState: 'COLLAPSE'
      });
      expect(resume.domainCheckpoint).not.toBeNull();
      expect(resume.crashCheckpoint).toBeNull();
      const resumed = resumedPrice({ coinId, nowMs: tMs, stored, lifecycleState: 'COLLAPSE' });
      const origin = originPrice({ coinId, nowMs: tMs, lifecycleState: 'COLLAPSE' });
      expect(Object.is(resumed, origin)).toBe(true);
    }
  });

  test('crash accumulator freeze/continue matches the origin factor exactly (Object.is)', () => {
    // Directly compare the raw factors (not just rounded prices) through a
    // chain of freezes under one lifecycle.
    for (const coinId of COIN_IDS) {
      let crashCheckpoint = null;
      for (let link = 1; link <= 12; link++) {
        const tMs = link * 50 * 1000;
        const frozen = priceEngine.extractCrashCheckpoint({
          seed: SEED, coinId, roundStartMs: ROUND_START_MS, nowMs: tMs,
          lifecycleState: 'DECLINE', checkpoint: crashCheckpoint
        });
        crashCheckpoint = frozen;
        const originFactor = priceEngine.evaluateCrashRallyFactor({
          seed: SEED, coinId, roundStartMs: ROUND_START_MS, nowMs: tMs + 10 * 1000, lifecycleState: 'DECLINE'
        }).factor;
        const resumedFactor = priceEngine.evaluateCrashRallyFactor({
          seed: SEED, coinId, roundStartMs: ROUND_START_MS, nowMs: tMs + 10 * 1000,
          lifecycleState: 'DECLINE', checkpoint: crashCheckpoint
        }).factor;
        expect(Object.is(resumedFactor, originFactor)).toBe(true);
      }
    }
  });

  test('domain accumulator freeze/continue matches the origin base exactly (Object.is)', () => {
    for (const coinId of COIN_IDS) {
      let domainCheckpoint = null;
      for (let link = 1; link <= 12; link++) {
        const tMs = link * 40 * 1000;
        domainCheckpoint = marketDomain.extractDomainCheckpoint({
          seed: SEED, coinId, roundStartMs: ROUND_START_MS, nowMs: tMs, checkpoint: domainCheckpoint
        });
        const originBase = marketDomain.evaluateMarketPoint({
          seed: SEED, coinId, baselinePrice: BASELINE_BY_COIN.get(coinId),
          roundStartMs: ROUND_START_MS, nowMs: tMs + 7777, amplitude: 1
        }).price;
        const resumedBase = marketDomain.evaluateMarketPoint({
          seed: SEED, coinId, baselinePrice: BASELINE_BY_COIN.get(coinId),
          roundStartMs: ROUND_START_MS, nowMs: tMs + 7777, amplitude: 1, checkpoint: domainCheckpoint
        }).price;
        expect(Object.is(resumedBase, originBase)).toBe(true);
      }
    }
  });
});

describe('Stage 1 pricing checkpoints: loud validation', () => {
  const goodStored = () => freeze({ coinId: 1, nowMs: 10 * 60 * 1000 });

  test('a wrong-seed checkpoint fails loudly', () => {
    const stored = { ...goodStored(), seed: 'some-other-seed' };
    expect(() => pricingCheckpoint.resolveResumeCheckpoints({
      stored, seed: SEED, coinId: 1, nowMs: 11 * 60 * 1000, lifecycleState: 'GROWTH'
    })).toThrow(/identity mismatch/);
  });

  test('a wrong-coin checkpoint fails loudly', () => {
    const stored = { ...goodStored(), coinId: 2 };
    expect(() => pricingCheckpoint.resolveResumeCheckpoints({
      stored, seed: SEED, coinId: 1, nowMs: 11 * 60 * 1000, lifecycleState: 'GROWTH'
    })).toThrow(/identity mismatch/);
  });

  test('a checkpoint from the future fails loudly', () => {
    const stored = goodStored();
    expect(() => pricingCheckpoint.resolveResumeCheckpoints({
      stored, seed: SEED, coinId: 1, nowMs: 5 * 60 * 1000, lifecycleState: 'GROWTH'
    })).toThrow(/from the future/);
  });

  test('corrupt domain accumulators fail loudly', () => {
    for (const bad of [
      { domainAnchor: 0 },
      { domainAnchor: -1.5 },
      { domainAnchor: NaN },
      { domainBoundary: 0 },
      { domainCycleIndex: -1 },
      { domainCycleIndex: 1.5 }
    ]) {
      const stored = { ...goodStored(), ...bad };
      expect(() => pricingCheckpoint.resolveResumeCheckpoints({
        stored, seed: SEED, coinId: 1, nowMs: 11 * 60 * 1000, lifecycleState: 'GROWTH'
      })).toThrow();
    }
  });

  test('corrupt crash accumulators fail loudly', () => {
    for (const bad of [
      { crashFactor: 0 },
      { crashFactor: -0.25 },
      { crashFactor: NaN },
      { crashEpisodeIndex: 0 },
      { crashEpisodeIndex: 2.5 }
    ]) {
      const stored = { ...goodStored(), ...bad };
      expect(() => pricingCheckpoint.resolveResumeCheckpoints({
        stored, seed: SEED, coinId: 1, nowMs: 11 * 60 * 1000, lifecycleState: 'GROWTH'
      })).toThrow();
    }
  });

  test('a crash checkpoint cursor before the origin or in the future fails loudly at evaluation', () => {
    const stored = goodStored();
    const resume = pricingCheckpoint.resolveResumeCheckpoints({
      stored, seed: SEED, coinId: 1, nowMs: 11 * 60 * 1000, lifecycleState: 'GROWTH'
    });
    expect(() => priceEngine.evaluateCrashRallyFactor({
      seed: SEED, coinId: 1, roundStartMs: ROUND_START_MS, nowMs: 11 * 60 * 1000,
      lifecycleState: 'GROWTH', checkpoint: { ...resume.crashCheckpoint, cursorMs: -1000 }
    })).toThrow(/precedes the timeline origin/);
    expect(() => priceEngine.evaluateCrashRallyFactor({
      seed: SEED, coinId: 1, roundStartMs: ROUND_START_MS, nowMs: 11 * 60 * 1000,
      lifecycleState: 'GROWTH', checkpoint: { ...resume.crashCheckpoint, cursorMs: 12 * 60 * 1000 }
    })).toThrow(/from the future/);
  });
});

describe('Stage 1 pricing checkpoints: long horizon beyond the bounded-walk guards', () => {
  test('90 simulated days via sequential checkpoints: no world-age/timeline/crash-horizon failure', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const CADENCE_MS = 30 * 60 * 1000; // the live batch cadence
    const steps = Math.floor((90 * DAY_MS) / CADENCE_MS);
    for (const coinId of COIN_IDS) {
      let stored = null;
      let lastPrice = null;
      for (let s = 1; s <= steps; s++) {
        const tMs = s * CADENCE_MS;
        stored = freeze({ coinId, nowMs: tMs, stored, lifecycleState: 'COLLAPSE' });
        lastPrice = resumedPrice({ coinId, nowMs: tMs, stored, lifecycleState: 'COLLAPSE' });
        expect(Number.isFinite(lastPrice)).toBe(true);
        expect(lastPrice).toBeGreaterThan(0);
      }
    }
  });

  test('the origin walk alone provably fails the horizon the checkpoints survive', () => {
    // The guards this suite protects: an un-checkpointed origin walk over a
    // persistent world age must hit the bounded-walk caps. ZIP (coin 1) has
    // 1-3 minute market cycles, so +45 simulated days is ~21k-65k market
    // cycles and ~21k-65k crash candidates — far beyond both 10,000 caps.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const tMs = 45 * DAY_MS;
    expect(() => originPrice({ coinId: 1, nowMs: tMs })).toThrow();
    // The chained-checkpoint continuation over the same span is fine: each
    // individual freeze/evaluation walk is a handful of cycles, so the
    // world age never trips a guard (and bit-identity inside the caps is
    // proven above).
    let stored = null;
    for (let s = 1; s * 30 * 60 * 1000 <= tMs; s++) {
      stored = freeze({ coinId: 1, nowMs: s * 30 * 60 * 1000, stored, lifecycleState: 'COLLAPSE' });
    }
    const price = resumedPrice({ coinId: 1, nowMs: tMs, stored, lifecycleState: 'COLLAPSE' });
    expect(Number.isFinite(price)).toBe(true);
    expect(price).toBeGreaterThan(0);
  });

  test('sequential-checkpoint and origin walks agree bit-identically at a within-cap long-horizon instant', () => {
    // Cross-check the chained-accumulator path against the origin engine at
    // the largest horizon still inside BOTH caps for every coin, so the
    // equality proof is direct, not transitivity-only.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const tMs = 6 * DAY_MS; // inside ZIP's ~7-21 day domain cycle cap
    for (const coinId of COIN_IDS) {
      let stored = null;
      for (let s = 1; s * 30 * 60 * 1000 <= tMs; s++) {
        stored = freeze({ coinId, nowMs: s * 30 * 60 * 1000, stored, lifecycleState: 'COLLAPSE' });
      }
      const origin = originPrice({ coinId, nowMs: tMs, lifecycleState: 'COLLAPSE' });
      const resumed = resumedPrice({ coinId, nowMs: tMs, stored, lifecycleState: 'COLLAPSE' });
      expect(Object.is(resumed, origin)).toBe(true);
    }
  });
});
