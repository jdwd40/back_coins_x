// Persistent-market Stage 1: the pricing-checkpoint composition layer.
//
// The stateless pricing engine (game/marketDomain.js + game/priceEngine.js)
// computes every price by walking a coin's deterministic market timeline
// from the origin. Those walks are BOUNDED (marketDomain.MAX_TIMELINE_CYCLES
// / priceEngine.MAX_CRASH_EPISODES) — over a long-lived persistent market an
// origin walk would eventually fail the guards. This module freezes and
// validates the per-coin resumable accumulators persisted in
// market_price_checkpoints (migration 023) so a continuation never walks
// from the origin, while staying BIT-IDENTICAL to the stateless engine:
//
//   * Domain accumulator (anchor/boundary/cycle position) has no lifecycle
//     dependence: a resume is always bit-identical to the origin walk.
//   * Crash/rally accumulator freezes episode activation under ONE gating
//     context (the V2 hidden lifecycle state). The stateless engine gates
//     activation on the CURRENT lifecycle input, so on any lifecycle
//     transition the frozen accumulator is discarded (never an error) and
//     re-frozen from the origin under the new state — keeping live prices
//     ALWAYS bit-identical to the pre-checkpoint engine.
//
// Hard-failure policy: a checkpoint with the wrong identity (seed or coin),
// a checkpoint from the future, or a structurally corrupt accumulator throws
// loudly. There is no silent fallback to origin pricing on CORRUPT state —
// corrupt state aborts the batch (and rolls the whole price/history/
// checkpoint transaction back) instead of repricing the market.
//
// Internal only: the seed and the accumulator internals never leave the
// server; nothing here is serialised into any public response.

const marketDomain = require('./marketDomain');
const priceEngine = require('./priceEngine');
const { resolveSimulationConfig, LIFECYCLE_STATE_IDS } = require('./simulationConfig');

function assertFiniteMs(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`pricing checkpoint ${name} must be a finite number; received ${String(value)}`);
  }
}

// Validate a stored checkpoint row's identity and structural shape, and
// convert it into the engine resume parameters for one evaluation.
//   stored          a market_price_checkpoints row (camelCase) or null
//   seed            the timeline seed being priced (wrong-seed -> throw)
//   coinId          the coin being priced (wrong-coin -> throw)
//   nowMs           the evaluation instant (future checkpoint -> throw)
//   lifecycleState  the current gating context; a mismatch discards ONLY
//                   the crash accumulator (documented invalidation), never
//                   the domain accumulator.
// Returns { domainCheckpoint, crashCheckpoint } — either may be null.
function resolveResumeCheckpoints({ stored, seed, coinId, nowMs, lifecycleState }) {
  if (stored === null || stored === undefined) {
    return { domainCheckpoint: null, crashCheckpoint: null };
  }
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('pricing checkpoint seed must be a non-empty string');
  }
  if (stored.seed !== seed) {
    throw new Error(`pricing checkpoint identity mismatch for coin ${String(coinId)}: stored seed does not match the pricing timeline seed; refusing to resume`);
  }
  if (Number(stored.coinId) !== Number(coinId)) {
    throw new Error(`pricing checkpoint identity mismatch: stored coin ${String(stored.coinId)} does not match priced coin ${String(coinId)}; refusing to resume`);
  }
  assertFiniteMs('nowMs', nowMs);
  assertFiniteMs('checkpointMs', stored.checkpointMs);
  if (stored.checkpointMs > nowMs) {
    throw new Error(`pricing checkpoint for coin ${String(coinId)} is from the future (checkpointMs=${stored.checkpointMs} > nowMs=${nowMs}); refusing to resume`);
  }

  const domainCheckpoint = {
    cycleIndex: stored.domainCycleIndex,
    cycleStartMs: stored.domainCycleStartMs,
    anchor: stored.domainAnchor,
    boundary: stored.domainBoundary
  };
  // Loud structural validation lives in the engine assertions.
  marketDomain.assertDomainCheckpoint(domainCheckpoint);

  let crashCheckpoint = null;
  if (stored.activationContext === lifecycleState) {
    crashCheckpoint = {
      episodeIndex: stored.crashEpisodeIndex,
      cursorMs: stored.crashCursorMs,
      factor: stored.crashFactor
    };
    priceEngine.assertCrashCheckpoint(crashCheckpoint);
  }
  // else: lifecycle transition since the freeze — discard the crash
  // accumulator (re-frozen from the origin under the new state when the
  // next checkpoint is extracted). NOT an error and NOT a silent price
  // change: an origin walk under the new lifecycle is exactly what the
  // stateless engine would compute.

  return { domainCheckpoint, crashCheckpoint };
}

// Freeze a fresh checkpoint row for one coin at nowMs. When a prior stored
// checkpoint is supplied (already identity-validated for this instant), the
// extraction resumes from it so the freeze walk stays short; the crash
// accumulator is continued only when the lifecycle still matches its freeze
// context, otherwise it is re-frozen from the origin under the current
// state. Returns the row-shaped checkpoint (camelCase) ready for upsert.
function extractPricingCheckpoint({ seed, coinId, roundStartMs, nowMs, lifecycleState, stored = null, config = resolveSimulationConfig() }) {
  if (!LIFECYCLE_STATE_IDS.includes(lifecycleState)) {
    throw new Error(`pricing checkpoint requires a known lifecycle state; received ${JSON.stringify(lifecycleState)}`);
  }
  assertFiniteMs('roundStartMs', roundStartMs);
  assertFiniteMs('nowMs', nowMs);

  const { domainCheckpoint, crashCheckpoint } = stored
    ? resolveResumeCheckpoints({ stored, seed, coinId, nowMs, lifecycleState })
    : { domainCheckpoint: null, crashCheckpoint: null };

  const domain = marketDomain.extractDomainCheckpoint({
    seed, coinId, roundStartMs, nowMs, checkpoint: domainCheckpoint
  });
  const crash = priceEngine.extractCrashCheckpoint({
    seed, coinId, roundStartMs, nowMs, lifecycleState, checkpoint: crashCheckpoint, config
  });

  return {
    coinId: Number(coinId),
    seed,
    checkpointMs: nowMs,
    domainCycleIndex: domain.cycleIndex,
    domainCycleStartMs: domain.cycleStartMs,
    domainAnchor: domain.anchor,
    domainBoundary: domain.boundary,
    crashEpisodeIndex: crash.episodeIndex,
    crashCursorMs: crash.cursorMs,
    crashFactor: crash.factor,
    activationContext: lifecycleState
  };
}

module.exports = {
  resolveResumeCheckpoints,
  extractPricingCheckpoint
};
