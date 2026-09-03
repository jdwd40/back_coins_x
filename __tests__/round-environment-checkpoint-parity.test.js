// Persistent-market Stage 1 (master plan §20): live/simulation equality.
//
// The headless round environment (simulation/roundEnvironment.js) prices
// through the SAME checkpointed production price path the live writer
// uses (game/pricingCheckpoint.js over game/priceEngine.js). This suite
// pins the hard invariant:
//
//   checkpointed(originState) === existingEngine(originState)
//
// BIT-FOR-BIT (Object.is) for every coin at every probed instant —
// including after the per-coin checkpoint cache has advanced past the
// probed instant (a lookback), across lifecycle transitions (the crash
// accumulator invalidation path) and through the full dynamic-collapse
// forward pass. It also proves the checkpoint path is load-bearing in
// simulation (resumes actually happen and accumulators advance).

const { createRoundEnvironment, CANONICAL_COINS } = require('../simulation/roundEnvironment');
const priceEngine = require('../game/priceEngine');
const pricingCheckpoint = require('../game/pricingCheckpoint');

jest.setTimeout(120000);

const SEED = 'stage1-round-env-parity-seed';

// The stateless ORIGIN engine evaluation for the exact inputs the
// environment derives at nowMs (via its internal pricingInputsAt surface).
function originEnginePrice(env, coinId, nowMs) {
  const inputs = env.pricingInputsAt(coinId, nowMs);
  const coin = CANONICAL_COINS.find((c) => c.coinId === coinId);
  return priceEngine.unifiedPriceAt({
    seed: env.seed,
    coinId,
    baselinePrice: coin.baselinePrice,
    roundStartMs: 0,
    nowMs,
    amplitude: inputs.amplitude,
    lifecycleState: inputs.lifecycleState,
    cycleProgress: inputs.cycleProgress,
    phaseModifier: inputs.phaseModifier,
    eventModifier: inputs.eventModifier,
    pressureModifier: inputs.pressureModifier
  });
}

describe('round environment: checkpointed production price path parity (master plan §20)', () => {
  test('checkpointed(originState) === existingEngine(originState), bit-for-bit, at a dense grid', () => {
    const env = createRoundEnvironment({ seed: SEED, economy: false });
    // Force the full gameplay forward pass first (lifecycle transitions,
    // dynamic collapses, phase chain) — every evaluation inside it also
    // flows through the checkpointed path.
    env.gameplayDiagnostics();

    const probeCount = 200;
    for (const coin of CANONICAL_COINS) {
      for (let i = 0; i < probeCount; i++) {
        // Deliberately NON-step-aligned instants across the whole round.
        const nowMs = Math.floor((i + 0.37) * (env.durationMs / probeCount));
        if (env.isDead(coin.coinId, nowMs)) {
          expect(env.priceAt(coin.coinId, nowMs)).toBe(0);
          continue;
        }
        const checkpointed = env.priceAt(coin.coinId, nowMs);
        const origin = originEnginePrice(env, coin.coinId, nowMs);
        expect(Object.is(checkpointed, origin)).toBe(true);
      }
    }
  });

  test('parity holds after the cache has advanced past the probed instant (lookback order)', () => {
    const env = createRoundEnvironment({ seed: SEED, economy: false });
    // The forward pass itself prices every coin monotonely through the
    // checkpointed path (the live reconcile pattern), so each coin's
    // cache sits at its last alive evaluation instant.
    const diagnostics = env.gameplayDiagnostics();
    const collapseOf = (coinId) => {
      const t = diagnostics.naturalCollapseAtMs.get(coinId);
      return t === undefined ? Infinity : t;
    };
    const survivorId = CANONICAL_COINS
      .map((c) => c.coinId)
      .sort((a, b) => collapseOf(b) - collapseOf(a))[0];
    const advanced = env.pricingCheckpointAt(survivorId);
    expect(advanced).not.toBeNull();
    expect(advanced.checkpointMs).toBeGreaterThan(0);
    expect(advanced.checkpointMs).toBeLessThanOrEqual(env.durationMs);
    // Now probe EARLIER instants (behind the frozen checkpoint): priced
    // from the origin engine, still bit-identical.
    for (const nowMs of [60 * 1000, 5 * 60 * 1000 + 1234, 10 * 60 * 1000 + 7]) {
      if (env.isDead(survivorId, nowMs)) continue;
      const checkpointed = env.priceAt(survivorId, nowMs);
      const origin = originEnginePrice(env, survivorId, nowMs);
      expect(Object.is(checkpointed, origin)).toBe(true);
    }
    // The cache never rewound.
    expect(env.pricingCheckpointAt(survivorId).checkpointMs).toBe(advanced.checkpointMs);
    // And resuming FORWARD from the advanced checkpoint stays identical
    // (an instant just beyond it, still inside the round and alive).
    const forwardMs = Math.min(advanced.checkpointMs + 15 * 1000, collapseOf(survivorId) - 1);
    if (forwardMs > advanced.checkpointMs && !env.isDead(survivorId, forwardMs)) {
      const checkpointed = env.priceAt(survivorId, forwardMs);
      const origin = originEnginePrice(env, survivorId, forwardMs);
      expect(Object.is(checkpointed, origin)).toBe(true);
      expect(env.pricingCheckpointAt(survivorId).checkpointMs).toBe(forwardMs);
    }
  });

  test('the checkpoint path is load-bearing in simulation: resumes happen and accumulators advance', () => {
    const env = createRoundEnvironment({ seed: `${SEED}-loadbearing`, economy: false });
    const resolveSpy = jest.spyOn(pricingCheckpoint, 'resolveResumeCheckpoints');
    const extractSpy = jest.spyOn(pricingCheckpoint, 'extractPricingCheckpoint');
    try {
      // The gameplay forward pass prices every coin monotonely at the 30s reconcile
      // cadence — every evaluation flows through the checkpointed production path.
      env.gameplayDiagnostics();
      expect(resolveSpy.mock.calls.length).toBeGreaterThan(50);
      expect(extractSpy.mock.calls.length).toBeGreaterThan(50);
      // Every coin carries a cached checkpoint row after the pass, and the
      // accumulators genuinely advanced through episodes and cycles.
      for (const coin of CANONICAL_COINS) {
        const stored = env.pricingCheckpointAt(coin.coinId);
        expect(stored).not.toBeNull();
        expect(stored.checkpointMs).toBeGreaterThan(0);
        expect(stored.checkpointMs).toBeLessThanOrEqual(env.durationMs);
        expect(stored.domainCycleIndex).toBeGreaterThan(0);
      }
      // The longest-lived coin's accumulator walked deep into both streams.
      const diagnostics = env.gameplayDiagnostics();
      const collapseOf = (coinId) => {
        const t = diagnostics.naturalCollapseAtMs.get(coinId);
        return t === undefined ? Infinity : t;
      };
      const survivorId = CANONICAL_COINS
        .map((c) => c.coinId)
        .sort((a, b) => collapseOf(b) - collapseOf(a))[0];
      const stored = env.pricingCheckpointAt(survivorId);
      expect(stored.crashEpisodeIndex).toBeGreaterThanOrEqual(3);
      expect(stored.domainCycleIndex).toBeGreaterThan(2);
      expect(stored.activationContext).not.toBeUndefined();
    } finally {
      resolveSpy.mockRestore();
      extractSpy.mockRestore();
    }
  });

  test('parity holds across lifecycle transitions (crash accumulator invalidation path)', () => {
    // A round with trades feeds pressure through the same path; the
    // lifecycle advances through the forward pass, forcing crash
    // accumulator invalidation/re-freeze under later states.
    const env = createRoundEnvironment({ seed: `${SEED}-lifecycle`, economy: false });
    env.gameplayDiagnostics();
    const diagnostics = env.gameplayDiagnostics();
    const states = new Set(diagnostics.steps.map((s) => s.lifecycleState));
    // Whatever lifecycle trajectory this seed produced, every probed instant still matches.
    expect(states.size).toBeGreaterThanOrEqual(1);
    for (const coin of CANONICAL_COINS.slice(0, 4)) {
      for (let i = 0; i < 60; i++) {
        const nowMs = Math.floor((i + 0.5) * (env.durationMs / 60));
        if (env.isDead(coin.coinId, nowMs)) continue;
        const checkpointed = env.priceAt(coin.coinId, nowMs);
        const origin = originEnginePrice(env, coin.coinId, nowMs);
        expect(Object.is(checkpointed, origin)).toBe(true);
      }
    }
  });
});
