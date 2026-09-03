// Crypto Chaos gameplay overhaul SIM-08/09/10: the unified price engine.
//
// This module is the SINGLE authoritative normal-price calculation for the
// gameplay overhaul (gameplay_changes.md §1, gameplay_build_plan.md Stage
// 6-8). The live market writer (models/market-simulator.js — still the only
// writer of coins.current_price and MARKET_TICK price history) and the
// DB-free headless simulator (simulation/roundEnvironment.js) both call
// unifiedPriceAt(); there is no second pricing implementation anywhere.
//
// Composition (multiplicative, each factor bounded, applied ONCE):
//
//   price = base(t) x (1 + normalModifier(t)) x crashRallyFactor(t)
//
//   * base(t)           — the existing continuous market-domain baseline
//                         (game/marketDomain.evaluateMarketPoint: seeded
//                         DIP->RISE->BOOM->FALL path, Core 2 amplitude,
//                         bounded noise). Preserved verbatim; the new forces
//                         compose on top of it, never replace it.
//   * normalModifier(t) — lifecycle pressure + current market-phase modifier
//                         + capped net coin-event modifier + bounded
//                         buy/sell trading pressure (SIM-08, SIM-11). All
//                         inputs are supplied by the caller from the
//                         persisted Wave 1/2/4 authorities (or the headless
//                         environment's pure equivalents); the sum is
//                         hard-clamped to +/-NORMAL_MODIFIER_LIMIT so
//                         stacking can never run away.
//   * crashRallyFactor  — the seeded crash/rally episode model (SIM-09/10).
//
// Determinism contract: no Math.random(), no wall-clock reads, no database
// access, no process globals. Every random-looking value comes from
// createSeededRandom streams keyed by the persisted Core 1 cycle seed. Same
// inputs -> identical price, in every process, forever. Persisted rounding
// is marketDomain.roundGamePrice (the existing 4dp gameplay precision), so
// live and headless prices share the exact rounding rule.
//
// Crash/rally model (SIM-09/10). Each coin walks a seeded chain of
// CANDIDATE episodes (`${seed}:sim3-crash-rally:coin:<coinId>:<index>`,
// fixed draw order), chained gap-after-window exactly like the coin-event
// streams. A candidate ACTIVATES only when its activation roll clears the
// current lifecycle state's crashProbability. Lifecycle is monotone
// (GROWTH -> PLATEAU -> DECLINE -> COLLAPSE) and the configured
// probabilities are non-decreasing along it, so activation is a monotone
// gate: an episode that could not fire during Growth may fire later, never
// the reverse. An activated episode:
//   * crashes from 1 to (1 - magnitude) over its crash window
//     (magnitude bounded by config crashMagnitude);
//   * then rallies when its rally roll clears the lifecycle state's
//     rallyProbabilityAfterCrash, recovering `strength` of the removed
//     value over the rally window. Strength is drawn from
//     recoveryStrength.early (GROWTH/PLATEAU — may exceed 1, so early
//     rallies can make new highs) or recoveryStrength.late
//     (DECLINE/COLLAPSE — strictly below early, Rule 7); late rallies are
//     additionally damped with probability lowerHighBias by a seeded
//     (non-fixed) scale, so late recoveries usually form lower highs
//     without a rigid visible percentage.
//   * leaves a PERMANENT residual multiplier (1 - magnitude x (1 -
//     effectiveStrength)) after its window ends: the unrecovered portion of
//     a crash persists for the rest of the cycle. This is what produces the
//     descending staircase of a dying market — early crashes wash out,
//     late crashes ratchet the price path downward.
// Every per-episode multiplier is strictly positive (magnitude < 1,
// strength >= 0), so the factor can never produce a zero, negative, NaN or
// Infinity price; the domain floor (MIN_POSITIVE_PRICE) is the final guard.
// Coin DEATH (exact £0) is the exclusive authority of the dynamic collapse
// engine (game/dynamicCollapseService.js, SIM-13/14) — nothing here zeroes
// a coin.
//
// Hidden-internals policy: computeUnifiedPrice returns its internal factor
// breakdown for server-side diagnostics and tests ONLY. Public responses
// must never serialise the seed, lifecycle state, phase/event modifiers,
// crash probability/magnitude, rally internals or any factor components
// (the Wave 5 redaction boundary is unchanged).
//
// This module never requires gameCycleService or any database module.

const marketDomain = require('./marketDomain');
const { createSeededRandom } = require('./seededRandom');
const {
  LIFECYCLE_STATE_IDS,
  resolveSimulationConfig
} = require('./simulationConfig');

// Hard safety bound on the composed normal modifier (lifecycle + phase +
// coin events). The realistic maximum is |lifecycle| 0.08 + |phase| 0.04 +
// |events| 0.06 = 0.18; 0.25 is the unreachable-with-current-config clamp
// that guarantees stacking can never produce runaway or negative pricing
// even if future tuning loosens the sections.
const NORMAL_MODIFIER_LIMIT = 0.25;

// Bounded walk guard for the per-coin episode chain (mirrors
// marketDomain's MAX_TIMELINE_CYCLES convention): with a minimum 2-minute
// gap a 30-minute cycle yields well under 20 episodes. The cap bounds WALK
// LENGTH (iterations between an origin/checkpoint and the evaluated
// instant), never the absolute episode index — a long-lived persistent
// market legitimately accumulates far more than 10,000 episodes from its
// origin, and checkpointed continuation keeps every individual walk tiny.
const MAX_CRASH_EPISODES = 10000;

// Late rallies that roll under lowerHighBias have their recovery strength
// damped by a seeded factor in this band — "usually a lower high" without
// a visibly rigid fixed percentage (gameplay_build_plan.md Stage 8).
const LOWER_HIGH_SCALE = Object.freeze({ min: 0.5, max: 0.85 });

function assertFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`price engine ${name} must be a finite number; received ${String(value)}`);
  }
}

function assertLifecycleState(lifecycleState) {
  if (!LIFECYCLE_STATE_IDS.includes(lifecycleState)) {
    throw new Error(`price engine requires a known lifecycle state; received ${JSON.stringify(lifecycleState)} (expected one of ${LIFECYCLE_STATE_IDS.join(', ')})`);
  }
}

function lerp(min, max, u) {
  return min + (max - min) * u;
}

// ---------------------------------------------------------------------------
// SIM-08: lifecycle pressure — the hidden macro support/drain term.
// ---------------------------------------------------------------------------

// The macro market pressure for a lifecycle state (a signed fraction of
// price, composed into the normal modifier):
//   GROWTH   — full growth support (spec §3: the market overpowers the
//              per-coin negative drain).
//   PLATEAU  — the midpoint between growth and decline support: support
//              has weakened but not yet reversed (spec §11: "positive
//              market support gradually weakens"). Derived from the two
//              configured endpoints rather than a third magic number.
//   DECLINE  — the configured decline pressure (spec §12: support no
//              longer fully offsets the coin drain).
//   COLLAPSE — intensifying negative pressure, interpolated across the
//              configured range by elapsed cycle progress (spec §20-22).
// Pure and bounded by construction; cycleProgress must already be clamped
// to [0, 1] by the caller.
function computeLifecyclePressure({ lifecycleState, cycleProgress, config = resolveSimulationConfig() }) {
  assertLifecycleState(lifecycleState);
  assertFiniteNumber('cycleProgress', cycleProgress);
  const lc = config.lifecycle;
  switch (lifecycleState) {
    case 'GROWTH':
      return lc.growthSupportModifier;
    case 'PLATEAU':
      return (lc.growthSupportModifier + lc.declinePressureModifier) / 2;
    case 'DECLINE':
      return lc.declinePressureModifier;
    default: { // COLLAPSE
      const range = lc.collapsePressureModifier;
      return lerp(range.max, range.min, cycleProgress);
    }
  }
}

// The composed, bounded normal modifier. phaseModifier and eventModifier
// come from the persisted Wave 1 authorities (or their pure headless
// equivalents); the event modifier is already stack-capped by the coin
// event engine. pressureModifier is the bounded, decayed buy-minus-sell
// trading pressure (SIM-11) derived from the persisted round ledger (or a
// headless trade tape) — already side-clamped by the trade-pressure domain.
// The total is hard-clamped to +/-NORMAL_MODIFIER_LIMIT.
function computeNormalModifier({ lifecycleState, cycleProgress, phaseModifier = 0, eventModifier = 0, pressureModifier = 0, config = resolveSimulationConfig() }) {
  assertFiniteNumber('phaseModifier', phaseModifier);
  assertFiniteNumber('eventModifier', eventModifier);
  assertFiniteNumber('pressureModifier', pressureModifier);
  const total = computeLifecyclePressure({ lifecycleState, cycleProgress, config }) + phaseModifier + eventModifier + pressureModifier;
  return Math.max(-NORMAL_MODIFIER_LIMIT, Math.min(NORMAL_MODIFIER_LIMIT, total));
}

// ---------------------------------------------------------------------------
// SIM-09/10: the seeded crash/rally episode model.
// ---------------------------------------------------------------------------

// The deterministic draws for one candidate episode. Fixed draw order:
// gap, crash duration, rally duration, magnitude, activation roll, rally
// roll, strength roll, lower-high roll, lower-high scale roll. Same (seed,
// coinId, episodeIndex) -> identical episode, in every process, forever.
function drawCrashEpisode({ seed, coinId, episodeIndex, config = resolveSimulationConfig() }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('price engine seed must be a non-empty string');
  }
  if (!Number.isInteger(episodeIndex) || episodeIndex < 1) {
    throw new Error(`crash episode index must be a positive integer; received ${String(episodeIndex)}`);
  }
  const cr = config.crashRally;
  const rng = createSeededRandom(`${seed}:sim3-crash-rally:coin:${Number(coinId)}:${episodeIndex}`);
  const gapMs = Math.round(lerp(cr.episodeGapMs.min, cr.episodeGapMs.max, rng()));
  const crashDurationMs = Math.round(lerp(cr.crashDurationMs.min, cr.crashDurationMs.max, rng()));
  const rallyDurationMs = Math.round(lerp(cr.rallyDurationMs.min, cr.rallyDurationMs.max, rng()));
  const magnitude = lerp(cr.crashMagnitude.min, cr.crashMagnitude.max, rng());
  const activationRoll = rng();
  const rallyRoll = rng();
  const strengthRoll = rng();
  const lowerHighRoll = rng();
  const lowerHighScaleRoll = rng();
  return {
    episodeIndex,
    gapMs,
    crashDurationMs,
    rallyDurationMs,
    magnitude,
    activationRoll,
    rallyRoll,
    strengthRoll,
    lowerHighRoll,
    lowerHighScaleRoll
  };
}

// Crash descent shape: a sharp initial drop that decelerates into the
// trough (x^0.5: fast start), so a crash reads as a sudden break, not a
// glide. x in [0, 1] -> [0, 1], monotone.
function crashCurve(x) {
  return Math.sqrt(Math.min(1, Math.max(0, x)));
}

// Rally recovery shape: a fast start with a topping drift (mirrors the
// domain's ease-out convention), so recoveries look convincing early and
// stall into their high. x in [0, 1] -> [0, 1], monotone.
function rallyCurve(x) {
  const clamped = Math.min(1, Math.max(0, x));
  return 1 - Math.pow(1 - clamped, 2);
}

// Resolve one activated episode's effective recovery strength for the
// current lifecycle state. Early (GROWTH/PLATEAU): the early range, which
// may exceed 1 (Rule 3: early crashes normally recover to a new high).
// Late (DECLINE/COLLAPSE): the strictly weaker late range, with a
// probability-lowerHighBias seeded damping on top (Rule 7 / spec §16:
// late rallies usually form lower highs, but not by a rigid percentage).
function resolveRecoveryStrength(episode, lifecycleState, config) {
  const cr = config.crashRally;
  const late = lifecycleState === 'DECLINE' || lifecycleState === 'COLLAPSE';
  const range = late ? cr.recoveryStrength.late : cr.recoveryStrength.early;
  let strength = lerp(range.min, range.max, episode.strengthRoll);
  if (late && episode.lowerHighRoll < cr.lowerHighBias) {
    strength *= lerp(LOWER_HIGH_SCALE.min, LOWER_HIGH_SCALE.max, episode.lowerHighScaleRoll);
  }
  return strength;
}

// Evaluate the combined crash/rally multiplier at nowMs.
//
// The chain is walked from roundStartMs; each candidate's window is
// [start, crashEnd, end] regardless of activation, so the walk is stable.
// Activation is gated on the CURRENT lifecycle state input (monotone, so a
// later lifecycle can only ever activate more of the chain — matching the
// spec's non-decreasing crash danger). Episodes fully past contribute
// their permanent residual; the episode whose window contains nowMs
// contributes its transient crash/rally shape instead.
//
// Returns the factor plus internal detail (active episode, per-episode
// residuals) for tests/diagnostics — never serialise publicly.
// Persistent-market Stage 1: validate a resumable crash/rally accumulator.
// The accumulator freezes the chain at the END of the last candidate episode
// window at or before the checkpoint instant: episodeIndex is the NEXT
// candidate, cursorMs is that window's end (or roundStartMs when no
// candidate has completed), factor is the exact product of the permanent
// residuals of all activated episodes completed at or before the checkpoint.
// An episode in flight at the checkpoint instant is NEVER frozen — it is
// redrawn from the seed and re-evaluated transiently on resume (the
// in-flight episode rule). Validation is loud: a corrupt accumulator can
// never silently rescale a coin's price path.
function assertCrashCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new Error('price engine crash checkpoint must be an object');
  }
  if (!Number.isInteger(checkpoint.episodeIndex) || checkpoint.episodeIndex < 1) {
    throw new Error(`price engine crash checkpoint episodeIndex must be a positive integer; received ${String(checkpoint.episodeIndex)}`);
  }
  assertFiniteNumber('crash checkpoint cursorMs', checkpoint.cursorMs);
  assertFiniteNumber('crash checkpoint factor', checkpoint.factor);
  if (checkpoint.factor <= 0) {
    throw new Error(`price engine crash checkpoint factor must be positive; received ${String(checkpoint.factor)}`);
  }
}

function evaluateCrashRallyFactor({ seed, coinId, roundStartMs, nowMs, lifecycleState, checkpoint = null, config = resolveSimulationConfig() }) {
  assertFiniteNumber('roundStartMs', roundStartMs);
  assertFiniteNumber('nowMs', nowMs);
  assertLifecycleState(lifecycleState);
  const cr = config.crashRally;

  let factor;
  let cursor;
  let activeEpisode = null;
  let activatedCount = 0;
  let firstIndex;

  if (checkpoint) {
    // Resume from the persisted accumulator. BIT-IDENTITY CONTRACT: this is
    // only identical to an origin walk while the lifecycle input matches the
    // context the accumulator was frozen under — the consumer enforces that
    // (discarding the accumulator on any lifecycle transition); the engine
    // itself stays a pure function of its inputs.
    assertCrashCheckpoint(checkpoint);
    if (checkpoint.cursorMs < roundStartMs) {
      throw new Error(`price engine crash checkpoint cursor ${checkpoint.cursorMs} precedes the timeline origin ${roundStartMs}; refusing to resume`);
    }
    if (checkpoint.cursorMs > nowMs) {
      throw new Error(`price engine crash checkpoint is from the future for nowMs=${nowMs} (cursorMs=${checkpoint.cursorMs}); refusing to resume`);
    }
    factor = checkpoint.factor;
    cursor = checkpoint.cursorMs;
    firstIndex = checkpoint.episodeIndex;
  } else {
    factor = 1;
    cursor = roundStartMs;
    firstIndex = 1;
  }

  // Iteration-bounded walk: the guard caps how far a single evaluation
  // walks, not the absolute episode index (unbounded over a persistent
  // world's life).
  for (let walk = 0; walk < MAX_CRASH_EPISODES; walk++) {
    const index = firstIndex + walk;
    const episode = drawCrashEpisode({ seed, coinId, episodeIndex: index, config });
    const start = cursor + episode.gapMs;
    const crashEnd = start + episode.crashDurationMs;
    const end = crashEnd + episode.rallyDurationMs;
    if (start > nowMs) break; // future episode: no contribution

    // The amortised per-evaluation roll: the candidate activates when its
    // seeded roll clears the current lifecycle state's crash probability.
    const activated = episode.activationRoll < cr.crashProbability[lifecycleState];
    if (activated) {
      activatedCount += 1;
      const rallyActive = episode.rallyRoll < cr.rallyProbabilityAfterCrash[lifecycleState];
      const strength = rallyActive ? resolveRecoveryStrength(episode, lifecycleState, config) : 0;

      if (nowMs < crashEnd) {
        // Inside the crash window: descending toward (1 - magnitude).
        const x = (nowMs - start) / episode.crashDurationMs;
        const level = 1 - episode.magnitude * crashCurve(x);
        factor *= level;
        activeEpisode = { episodeIndex: index, stage: 'CRASH', magnitude: episode.magnitude, strength };
      } else if (nowMs < end) {
        // Inside the rally window: recovering `strength` of the removed
        // value from the crash trough.
        const x = (nowMs - crashEnd) / episode.rallyDurationMs;
        const level = (1 - episode.magnitude) + episode.magnitude * strength * rallyCurve(x);
        factor *= level;
        activeEpisode = { episodeIndex: index, stage: rallyActive ? 'RALLY' : 'POST_CRASH', magnitude: episode.magnitude, strength };
      } else {
        // Episode complete: the unrecovered portion persists as a
        // permanent residual for the rest of the cycle (lower lows; with
        // early strength > 1, a small permanent lift instead).
        factor *= 1 - episode.magnitude * (1 - strength);
      }
    }
    cursor = end; // the chain advances on drawn windows, never on activation
  }

  // Defensive bound: every per-episode multiplier is strictly positive by
  // construction (magnitude < 1, strength >= 0), so a non-finite or
  // non-positive factor here means a broken input, never valid pricing.
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`price engine computed an invalid crash/rally factor ${String(factor)} for coin ${String(coinId)}; aborting`);
  }
  return { factor, activeEpisode, activatedCount };
}

// Persistent-market Stage 1: freeze the resumable crash/rally accumulator at
// nowMs. Walks the candidate chain (resuming from an optional prior
// accumulator under the SAME lifecycle state) and freezes at the END of the
// last candidate window at or before nowMs:
//   episodeIndex — the NEXT candidate index after the frozen boundary;
//   cursorMs     — the frozen boundary (roundStartMs when no candidate has
//                  completed yet);
//   factor       — the exact product of the permanent residuals of all
//                  activated episodes completed at or before nowMs.
// A candidate whose window CONTAINS nowMs (in flight) is deliberately NOT
// frozen: on resume it is redrawn from the seed and re-evaluated
// transiently, so checkpointing mid-crash or mid-rally resumes
// bit-identically (the in-flight episode rule). The residual multiplication
// order matches the evaluation walk exactly, so the frozen product is the
// identical double the origin walk would have accumulated.
function extractCrashCheckpoint({ seed, coinId, roundStartMs, nowMs, lifecycleState, checkpoint = null, config = resolveSimulationConfig() }) {
  assertFiniteNumber('roundStartMs', roundStartMs);
  assertFiniteNumber('nowMs', nowMs);
  assertLifecycleState(lifecycleState);
  const cr = config.crashRally;

  let factor;
  let cursor;
  let firstIndex;
  if (checkpoint) {
    assertCrashCheckpoint(checkpoint);
    if (checkpoint.cursorMs < roundStartMs) {
      throw new Error(`price engine crash checkpoint cursor ${checkpoint.cursorMs} precedes the timeline origin ${roundStartMs}; refusing to resume`);
    }
    if (checkpoint.cursorMs > nowMs) {
      throw new Error(`price engine crash checkpoint is from the future for nowMs=${nowMs} (cursorMs=${checkpoint.cursorMs}); refusing to resume`);
    }
    factor = checkpoint.factor;
    cursor = checkpoint.cursorMs;
    firstIndex = checkpoint.episodeIndex;
  } else {
    factor = 1;
    cursor = roundStartMs;
    firstIndex = 1;
  }

  let nextIndex = firstIndex;
  for (let walk = 0; walk < MAX_CRASH_EPISODES; walk++) {
    const index = firstIndex + walk;
    const episode = drawCrashEpisode({ seed, coinId, episodeIndex: index, config });
    const start = cursor + episode.gapMs;
    const crashEnd = start + episode.crashDurationMs;
    const end = crashEnd + episode.rallyDurationMs;
    if (end > nowMs) break; // in-flight or future candidate: never frozen
    const activated = episode.activationRoll < cr.crashProbability[lifecycleState];
    if (activated) {
      const rallyActive = episode.rallyRoll < cr.rallyProbabilityAfterCrash[lifecycleState];
      const strength = rallyActive ? resolveRecoveryStrength(episode, lifecycleState, config) : 0;
      factor *= 1 - episode.magnitude * (1 - strength);
    }
    cursor = end;
    nextIndex = index + 1;
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`price engine froze an invalid crash/rally factor ${String(factor)} for coin ${String(coinId)}; aborting`);
    }
  }
  return { episodeIndex: nextIndex, cursorMs: cursor, factor };
}

// ---------------------------------------------------------------------------
// SIM-08: the unified price.
// ---------------------------------------------------------------------------

// The single authoritative normal-price calculation. Options:
//   seed            persisted apocalypse cycle seed (internal only)
//   coinId          catalogue coin id
//   baselinePrice   persisted cycle_baseline_price (> 0)
//   roundStartMs    persisted apocalypse cycle start (ms epoch)
//   nowMs           authoritative time (real clock live, injected in sim)
//   amplitude       Core 2 apocalypse volatility factor (default 1)
//   lifecycleState  current hidden lifecycle state (default GROWTH)
//   cycleProgress   elapsed cycle fraction in [0, 1] (default 0; callers clamp)
//   phaseModifier   current market-phase modifier (default 0)
//   eventModifier   capped net coin-event modifier for this coin (default 0)
//   pressureModifier bounded decayed buy-minus-sell pressure (default 0)
//   config          resolved simulation config (default: game-design defaults)
// Returns the unrounded exact price plus the internal factor breakdown
// (internal only — see the header's hidden-internals policy). The price is
// always finite and strictly positive.
function computeUnifiedPrice({
  seed,
  coinId,
  baselinePrice,
  roundStartMs,
  nowMs,
  amplitude = 1,
  lifecycleState = 'GROWTH',
  cycleProgress = 0,
  phaseModifier = 0,
  eventModifier = 0,
  pressureModifier = 0,
  domainCheckpoint = null,
  crashCheckpoint = null,
  config = resolveSimulationConfig()
}) {
  assertFiniteNumber('cycleProgress', cycleProgress);
  if (cycleProgress < 0 || cycleProgress > 1) {
    throw new Error(`price engine cycleProgress must be a fraction in [0, 1]; received ${cycleProgress}`);
  }

  const base = marketDomain.evaluateMarketPoint({
    seed, coinId, baselinePrice, roundStartMs, nowMs, amplitude, checkpoint: domainCheckpoint
  }).price;

  const normalModifier = computeNormalModifier({
    lifecycleState, cycleProgress, phaseModifier, eventModifier, pressureModifier, config
  });
  const { factor: crashRallyFactor, activeEpisode, activatedCount } = evaluateCrashRallyFactor({
    seed, coinId, roundStartMs, nowMs, lifecycleState, checkpoint: crashCheckpoint, config
  });

  const raw = base * (1 + normalModifier) * crashRallyFactor;
  // The strictly-positive floor mirrors the domain's own guard: a
  // pathological-but-valid input can never produce 0, a negative price or
  // NaN. (base and crashRallyFactor are already guarded positive; the
  // floor is the final fail-safe.)
  const price = Number.isFinite(raw) && raw > 0
    ? Math.max(marketDomain.MIN_POSITIVE_PRICE, raw)
    : marketDomain.MIN_POSITIVE_PRICE;

  return {
    price,
    basePrice: base,
    normalModifier,
    crashRallyFactor,
    activeEpisode,
    activatedCount
  };
}

// The persisted gameplay price: the unified price at the shared 4dp
// gameplay rounding (marketDomain.roundGamePrice — the ONLY rounding rule,
// unchanged). Live writer and headless simulator both persist/settle at
// exactly this value.
function unifiedPriceAt(options) {
  return marketDomain.roundGamePrice(computeUnifiedPrice(options).price);
}

module.exports = {
  NORMAL_MODIFIER_LIMIT,
  LOWER_HIGH_SCALE,
  computeLifecyclePressure,
  computeNormalModifier,
  drawCrashEpisode,
  resolveRecoveryStrength,
  assertCrashCheckpoint,
  evaluateCrashRallyFactor,
  extractCrashCheckpoint,
  computeUnifiedPrice,
  unifiedPriceAt
};
