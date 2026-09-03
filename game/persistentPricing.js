// Persistent-market Stage 2 (master plan §21-27, Stage 2): the
// persistent-safe pricing composition.
//
// This module is the persistent world's pure deterministic price engine.
// It composes over the PROVEN Stage 1 machinery — the market-domain cycle
// shape stream (game/marketDomain.buildMarketCycle), the seeded
// crash/rally episode draws (game/priceEngine.drawCrashEpisode), the
// SHA-256 seeded-RNG convention and the 4dp gameplay rounding — while
// replacing everything the master plan retires:
//
//   * NO apocalypse percentage, NO late-game/lifecycle escalation, NO
//     Apocalypse volatility progression, NO fake apocalypsePercent = 0.
//     Broad conditions enter ONLY through the Market Environment seam
//     (game/marketEnvironment.js).
//   * §22 log-neutral structural drift: the per-cycle structural draw is
//     symmetric IN LOG SPACE and converted back with exp(), so the
//     neutral environment has exactly zero expected log drift (the V2
//     arithmetic drift's Jensen decay is deliberately not carried over,
//     and not merely shrunk).
//   * §23 weak log-space restoring force toward the coin's slowly moving
//     structural reference (authoritative market_coin_state input). The
//     reference is an INPUT, never recomputed here; it evolves between
//     evaluations via advanceStructuralReference.
//   * §24/§25 decaying crash damage with committed historical semantics:
//     completed episode residuals enter a decaying accumulator evaluated
//     in FACTOR space (a log-space leaky integrator advanced by
//     pow/multiply, so the frozen accumulator is itself the exact double
//     the walk holds — no log/exp round-trip anywhere) that decays toward
//     neutral with the configured half-life: ordinary old crashes never
//     multiply forever. Episode activation is committed under the
//     environment at the EPISODE's start instant; a later regime change
//     never rewrites it.
//   * §26 decaying/rolling peak reference (advancePeakReference) — no
//     all-time monotonic peak.
//   * §27 living positive safety floor only: MIN_POSITIVE_PRICE guards a
//     living coin's price; touching the floor NEVER kills a coin (death
//     is an explicit authoritative transition, Stage 9).
//
// State separation (master plan §12): this module owns ONLY the derived
// resumable calculation state (the pricing checkpoint: cycle accumulator
// + crash-damage accumulator). Condition, structural reference, decaying
// peak and death live in market_coin_state; world/Director state lives in
// the world layer. The checkpoint is never a generic state bag.
//
// Checkpoint contract (composes game/pricingCheckpoint.js conventions;
// the row shape maps exactly onto market_price_checkpoints, migration
// 023, with the world seed as the timeline identity):
//   * Domain accumulator: cycle index, absolute (fractional) cycle start,
//     exact anchor/boundary doubles. Resuming reproduces the identical
//     floating-point sequence an origin walk under the SAME inputs
//     (reference, environment) would compute.
//   * Crash accumulator: next candidate index, cursor (end of the last
//     COMPLETED candidate window at or before the checkpoint instant),
//     and the decayed damage factor at the cursor. The in-flight episode
//     rule is preserved: an episode whose window contains the checkpoint
//     instant is never frozen — it is redrawn from the seed and
//     re-evaluated transiently on resume.
//   * activationContext is the literal 'PERSISTENT': the persistent
//     accumulator never invalidates on a regime change (activation is
//     committed under historical conditions, §25), unlike the V2
//     lifecycle-gated accumulator.
//   * Corrupt, future or wrong-identity checkpoints throw loudly; there
//     is no silent fallback to origin pricing on CORRUPT state.
//
// Determinism contract: no Math.random(), no wall-clock reads, no
// database access. Same inputs -> identical price, in every process,
// forever. The environment input may be a literal environment or any
// provider behind game/marketEnvironment.js (Stage 2 neutral, Stage 3
// Director) — pricing never knows which.
//
// Hidden-internals policy: the seed, accumulator internals and factor
// breakdowns never leave the server; nothing here is serialised publicly.
//
// This module never requires any database or service module.

const marketDomain = require('./marketDomain');
const priceEngine = require('./priceEngine');
const { createSeededRandom } = require('./seededRandom');
const { NEUTRAL_ENVIRONMENT, resolveEnvironment } = require('./marketEnvironment');
const { resolveSimulationConfig } = require('./simulationConfig');

const DAY_MS = 24 * 60 * 60 * 1000;
const LN2 = Math.log(2);

// Bounded-walk guards (marketDomain.MAX_TIMELINE_CYCLES convention): the
// guard caps how far ONE evaluation walks from its origin/checkpoint,
// never the absolute cycle/episode index — a persistent world
// legitimately accumulates unbounded cycles over its life, and
// checkpointed continuation keeps every individual walk short.
const MAX_PERSISTENT_CYCLES = 10000;
const MAX_PERSISTENT_EPISODES = 10000;

// The persistent crash accumulator's gating context marker. Unlike the V2
// lifecycle context, this never changes: activation is committed under
// historical conditions, so the accumulator stays valid for the world's
// whole life.
const PERSISTENT_ACTIVATION_CONTEXT = 'PERSISTENT';

// Derived UI vocabulary for the authoritative condition scalar (master
// plan §11: labels are derived state, never authoritative storage).
const CONDITION_LABELS = Object.freeze(['THRIVING', 'HEALTHY', 'UNSTABLE', 'STRUGGLING', 'CRITICAL']);

function assertFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`persistent pricing ${name} must be a finite number; received ${String(value)}`);
  }
}

function assertPositive(name, value) {
  assertFiniteNumber(name, value);
  if (value <= 0) {
    throw new Error(`persistent pricing ${name} must be strictly positive; received ${String(value)}`);
  }
}

function conditionLabel(condition) {
  assertFiniteNumber('condition', condition);
  if (condition >= 0.5) return 'THRIVING';
  if (condition >= 0.1) return 'HEALTHY';
  if (condition > -0.3) return 'UNSTABLE';
  if (condition > -0.7) return 'STRUGGLING';
  return 'CRITICAL';
}

function assertArchetype(archetypeId, coinId) {
  const archetype = marketDomain.MARKET_ARCHETYPES[archetypeId];
  if (!archetype) {
    // Master plan §29: archetype assignment is explicit in the persistent
    // world. A missing/unknown archetype fails loudly — the V2 silent
    // MOON default is never applied here.
    throw new Error(`persistent pricing requires an explicit known archetype for coin ${String(coinId)}; received ${JSON.stringify(archetypeId)}`);
  }
  return archetype;
}

function lerp(min, max, u) {
  return min + (max - min) * u;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// §22: log-space structural drift.
// ---------------------------------------------------------------------------

// The persistent structural draw for one market cycle: symmetric in LOG
// space, so the multiplier exp(logDrift) has exactly zero expected log
// drift under the neutral environment. Own domain separator — independent
// of the V2 market stream, the crash/rally stream and the noise stream.
function drawPersistentLogDrift({ seed, coinId, cycleIndex, scale }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('persistent pricing seed must be a non-empty string');
  }
  assertPositive('structural drift scale', scale);
  const rng = createSeededRandom(`${seed}:persistent-drift:coin:${Number(coinId)}:${cycleIndex}`);
  return lerp(-scale, scale, rng());
}

// One anchor transition across a completed market-cycle boundary:
//   logAnchor' = logAnchor + logDrift + environmentBias + restoring,
// where the restoring term closes the configured fraction of the log gap
// to the structural reference (§23) and the environment bias is the
// committed environment's expected log drift for this cycle's duration.
// Pure in every input.
function advanceAnchor({ anchor, cycle, logDrift, reference, environment, config }) {
  const pc = config.persistent;
  const bias = environment.structuralBias * (cycle.durationMs / DAY_MS);
  const restoring = pc.restoringForcePerCycle * (Math.log(reference) - Math.log(anchor));
  const next = Math.exp(Math.log(anchor) + logDrift + bias + restoring);
  if (!Number.isFinite(next) || next <= 0) {
    throw new Error(`persistent pricing computed an invalid anchor ${String(next)}; aborting`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Checkpoint validation and resolution (loud, §18).
// ---------------------------------------------------------------------------

function assertPersistentDomainCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new Error('persistent pricing domain checkpoint must be an object');
  }
  if (!Number.isInteger(checkpoint.cycleIndex) || checkpoint.cycleIndex < 0) {
    throw new Error(`persistent pricing checkpoint cycleIndex must be a non-negative integer; received ${String(checkpoint.cycleIndex)}`);
  }
  assertFiniteNumber('checkpoint cycleStartMs', checkpoint.cycleStartMs);
  assertPositive('checkpoint anchor', checkpoint.anchor);
  assertPositive('checkpoint boundary', checkpoint.boundary);
}

function assertPersistentCrashCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new Error('persistent pricing crash checkpoint must be an object');
  }
  if (!Number.isInteger(checkpoint.episodeIndex) || checkpoint.episodeIndex < 1) {
    throw new Error(`persistent pricing checkpoint episodeIndex must be a positive integer; received ${String(checkpoint.episodeIndex)}`);
  }
  assertFiniteNumber('checkpoint cursorMs', checkpoint.cursorMs);
  assertPositive('checkpoint damageFactor', checkpoint.damageFactor);
}

// Validate a stored persistent pricing checkpoint's identity and shape
// and convert it into the internal resume accumulators. Throws loudly on
// wrong identity, future checkpoint or structural corruption (§18); never
// silently falls back to origin pricing on CORRUPT state.
//   stored   a checkpoint object (row-shaped camelCase) or null
// Returns { domainCheckpoint, crashCheckpoint } — both null when stored
// is null ("no checkpoint yet").
function resolvePersistentCheckpoint({ stored, seed, coinId, nowMs }) {
  if (stored === null || stored === undefined) {
    return { domainCheckpoint: null, crashCheckpoint: null };
  }
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('persistent pricing seed must be a non-empty string');
  }
  if (stored.seed !== seed) {
    throw new Error(`persistent pricing checkpoint identity mismatch for coin ${String(coinId)}: stored seed does not match the world seed; refusing to resume`);
  }
  if (Number(stored.coinId) !== Number(coinId)) {
    throw new Error(`persistent pricing checkpoint identity mismatch: stored coin ${String(stored.coinId)} does not match priced coin ${String(coinId)}; refusing to resume`);
  }
  assertFiniteNumber('nowMs', nowMs);
  assertFiniteNumber('checkpointMs', stored.checkpointMs);
  if (stored.checkpointMs > nowMs) {
    throw new Error(`persistent pricing checkpoint for coin ${String(coinId)} is from the future (checkpointMs=${stored.checkpointMs} > nowMs=${nowMs}); refusing to resume`);
  }
  if (stored.activationContext !== PERSISTENT_ACTIVATION_CONTEXT) {
    throw new Error(`persistent pricing checkpoint for coin ${String(coinId)} has activation context ${JSON.stringify(stored.activationContext)} (expected ${PERSISTENT_ACTIVATION_CONTEXT}); refusing to resume a foreign accumulator`);
  }

  const domainCheckpoint = {
    cycleIndex: stored.domainCycleIndex,
    cycleStartMs: stored.domainCycleStartMs,
    anchor: stored.domainAnchor,
    boundary: stored.domainBoundary
  };
  assertPersistentDomainCheckpoint(domainCheckpoint);
  if (domainCheckpoint.cycleStartMs > nowMs) {
    throw new Error(`persistent pricing checkpoint cycle start ${domainCheckpoint.cycleStartMs} is in the future for nowMs=${nowMs}; refusing to resume`);
  }

  const crashCheckpoint = {
    episodeIndex: stored.crashEpisodeIndex,
    cursorMs: stored.crashCursorMs,
    damageFactor: stored.crashFactor
  };
  assertPersistentCrashCheckpoint(crashCheckpoint);
  if (crashCheckpoint.cursorMs > nowMs) {
    throw new Error(`persistent pricing crash cursor ${crashCheckpoint.cursorMs} is in the future for nowMs=${nowMs}; refusing to resume`);
  }

  return { domainCheckpoint, crashCheckpoint };
}

// ---------------------------------------------------------------------------
// The persistent market-cycle walk (composes marketDomain shape draws).
// ---------------------------------------------------------------------------

// Walk the coin's persistent market timeline to the cycle containing
// nowMs. Mirrors marketDomain.locateMarketCycle's structure (staggered
// start, seeded cycle stream, bounded walk) with the Stage 2 anchor
// transition: log-space drift + environment bias + weak restoring force
// (never the V2 arithmetic drift). The anchor/boundary levels are
// ABSOLUTE price levels (the world starts exactly at the structural
// reference). Returns the located cycle, its absolute window, its
// anchor/boundary and the environment committed at the cycle's start.
function locatePersistentCycle({ seed, coinId, archetypeId, originMs, nowMs, reference, environment, checkpoint = null, config = resolveSimulationConfig() }) {
  assertFiniteNumber('originMs', originMs);
  assertFiniteNumber('nowMs', nowMs);
  assertPositive('structuralReference', reference);
  const archetype = assertArchetype(archetypeId, coinId);

  let cycle;
  let startMs;
  let anchor;
  let boundary;

  if (checkpoint) {
    assertPersistentDomainCheckpoint(checkpoint);
    if (nowMs < checkpoint.cycleStartMs) {
      throw new Error(`persistent pricing checkpoint is from the future for nowMs=${nowMs} (cycleStartMs=${checkpoint.cycleStartMs}); refusing to resume`);
    }
    cycle = marketDomain.buildMarketCycle({ seed, coinId, archetypeId, index: checkpoint.cycleIndex });
    startMs = checkpoint.cycleStartMs;
    anchor = checkpoint.anchor;
    boundary = checkpoint.boundary;
  } else {
    const first = marketDomain.buildMarketCycle({ seed, coinId, archetypeId, index: 0 });
    const offsetMs = marketDomain.getCoinStartOffsetFraction(seed, coinId) * first.durationMs;
    cycle = first;
    startMs = originMs - offsetMs;
    anchor = reference; // the world starts exactly at the structural reference
    boundary = reference;
  }

  for (let i = 0; i < MAX_PERSISTENT_CYCLES; i++) {
    const endMs = startMs + cycle.durationMs;
    if (nowMs < endMs) {
      return { cycle, startMs, endMs, anchor, boundary, environment: resolveEnvironment(environment, startMs) };
    }
    // Committed historical semantics (§25): the environment in force at
    // the cycle's START governs its anchor transition — a later regime
    // change never rewrites a completed boundary.
    const cycleEnvironment = resolveEnvironment(environment, startMs);
    const logDrift = drawPersistentLogDrift({ seed, coinId, cycleIndex: cycle.index, scale: archetype.drift });
    const nextAnchor = advanceAnchor({ anchor, cycle, logDrift, reference, environment: cycleEnvironment, config });
    const nextBoundary = nextAnchor * (1 - cycle.endDiscount);
    cycle = marketDomain.buildMarketCycle({ seed, coinId, archetypeId, index: cycle.index + 1 });
    startMs = endMs;
    anchor = nextAnchor;
    boundary = nextBoundary;
  }
  throw new Error(`persistent pricing timeline walk exceeded the bounded-walk guard (${MAX_PERSISTENT_CYCLES} cycles) for coin ${String(coinId)}; resume from a checkpoint instead of walking the world age`);
}

// Ease a segment position x in [0,1] exactly like the V2 domain: falling
// segments ease in, rising segments ease out, the BOOM plateau is linear.
function easeSegment(x, shape, direction) {
  const clamped = clamp(x, 0, 1);
  if (direction === 'UP') return 1 - Math.pow(1 - clamped, shape);
  if (direction === 'DOWN') return Math.pow(clamped, shape);
  return clamped;
}

// Bounded short-term noise: a per-coin pure function of time (continuous
// across cycle boundaries), same two-sine convention as the V2 domain but
// with the persistent stream's own domain separator. The committed
// environment's volatility scale multiplies the amplitude.
function buildPersistentNoise({ seed, coinId, archetypeId }) {
  const archetype = marketDomain.MARKET_ARCHETYPES[archetypeId];
  const rng = createSeededRandom(`${seed}:persistent-noise:coin:${Number(coinId)}`);
  return {
    noiseAmp: archetype.noise * lerp(0.5, 1.0, rng()),
    noisePeriod1Ms: lerp(20 * 1000, 45 * 1000, rng()),
    noisePeriod2Ms: lerp(50 * 1000, 95 * 1000, rng()),
    noisePhase1: rng() * 2 * Math.PI,
    noisePhase2: rng() * 2 * Math.PI,
    noiseMix: rng()
  };
}

function persistentNoiseAt(noise, nowMs) {
  const a = Math.sin((2 * Math.PI * nowMs) / noise.noisePeriod1Ms + noise.noisePhase1);
  const b = Math.sin((2 * Math.PI * nowMs) / noise.noisePeriod2Ms + noise.noisePhase2);
  return noise.noiseAmp * (noise.noiseMix * a + (1 - noise.noiseMix) * b);
}

// Evaluate the intra-cycle DIP -> RISE -> BOOM -> FALL shape at nowMs
// (the proven marketDomain phase mathematics, re-expressed for the
// persistent anchor transition). The committed environment's volatility
// scale scales the DEVIATION from the continuous anchor path, never the
// anchor path itself — regime changes make swings wilder or calmer
// without repricing the market's structural level.
function evaluatePersistentCyclePoint({ location, seed, coinId, archetypeId, reference, nowMs, config }) {
  const { cycle, startMs, anchor, boundary, environment } = location;
  const archetype = assertArchetype(archetypeId, coinId);
  const x = clamp((nowMs - startMs) / cycle.durationMs, 0, 1);

  const logDrift = drawPersistentLogDrift({ seed, coinId, cycleIndex: cycle.index, scale: archetype.drift });
  const nextAnchor = advanceAnchor({ anchor, cycle, logDrift, reference, environment, config });
  const nextBoundary = nextAnchor * (1 - cycle.endDiscount);

  const trough = anchor * (1 - cycle.dipDepth);
  const peak = anchor * (1 + cycle.boomHeight);
  const plateauEnd = peak * (1 - cycle.boomDecay);

  const dipEnd = cycle.dipFrac;
  const riseEnd = dipEnd + cycle.riseFrac;
  const boomEnd = riseEnd + cycle.boomFrac;

  let phase;
  let level;
  if (x < dipEnd) {
    phase = 'DIP';
    const u = easeSegment(x / dipEnd, cycle.shape, 'DOWN');
    level = boundary + (trough - boundary) * u;
  } else if (x < riseEnd) {
    phase = 'RISE';
    const u = easeSegment((x - dipEnd) / cycle.riseFrac, cycle.shape, 'UP');
    level = trough + (peak - trough) * u;
  } else if (x < boomEnd) {
    phase = 'BOOM';
    const u = easeSegment((x - riseEnd) / cycle.boomFrac, cycle.shape, 'FLAT');
    level = peak + (plateauEnd - peak) * u;
  } else {
    phase = 'FALL';
    const span = Math.max(cycle.fallFrac, 1e-9);
    const u = easeSegment((x - boomEnd) / span, cycle.shape, 'DOWN');
    level = plateauEnd + (nextBoundary - plateauEnd) * u;
  }
  const anchorPath = anchor + (nextAnchor - anchor) * x;
  const deviation = level - anchorPath;
  const scaled = anchorPath + deviation * environment.volatilityScale;
  return { phase, structuralLevel: anchorPath, value: scaled };
}

// ---------------------------------------------------------------------------
// §24/§25: decaying crash damage with committed historical semantics.
// ---------------------------------------------------------------------------

// Crash descent / rally recovery shapes (the proven V2 curves).
function crashCurve(x) {
  return Math.sqrt(clamp(x, 0, 1));
}

function rallyCurve(x) {
  const clamped = clamp(x, 0, 1);
  return 1 - Math.pow(1 - clamped, 2);
}

// Resolve one candidate's persistent activation and recovery under the
// environment committed at the episode's start instant. The persistent
// path has no lifecycle: activation is the seeded roll against the base
// crash probability scaled by the environment's crash-probability
// modifier; recovery strength is the configured range scaled by the
// environment recovery modifier. All draws come from the proven V2
// episode stream (priceEngine.drawCrashEpisode).
function resolvePersistentEpisode(episode, environment, config) {
  const pc = config.persistent;
  const crashProbability = clamp(pc.baseCrashProbability * environment.crashProbabilityModifier, 0, 1);
  const activated = episode.activationRoll < crashProbability;
  const rallyActive = episode.rallyRoll < pc.baseRallyProbability;
  const strength = rallyActive
    ? lerp(pc.recoveryStrength.min, pc.recoveryStrength.max, episode.strengthRoll) * environment.recoveryModifier
    : 0;
  return { activated, rallyActive, strength };
}

// Walk state for the crash-damage accumulator, shared by the evaluation
// and freeze paths so both advance the accumulator through the IDENTICAL
// sequence of floating-point operations (bit-identity by construction).
// The accumulator lives in FACTOR space: decay applies as
// Math.pow(factor, exp(-lambda x elapsed)) at EVERY completed candidate
// window boundary (activated or not — so the freeze/resume pow-sequence matches
// the origin walk exactly), commits multiply the residual factor — the frozen value
// is the exact double the walk holds.
function createDamageWalk({ originMs, checkpoint }) {
  if (checkpoint) {
    assertPersistentCrashCheckpoint(checkpoint);
    if (checkpoint.cursorMs < originMs) {
      throw new Error(`persistent pricing crash checkpoint cursor ${checkpoint.cursorMs} precedes the world origin ${originMs}; refusing to resume`);
    }
    return {
      chainCursor: checkpoint.cursorMs, // end of the last completed candidate window
      damageCursor: checkpoint.cursorMs, // instant the accumulated factor is valid at
      factor: checkpoint.damageFactor,
      firstIndex: checkpoint.episodeIndex
    };
  }
  return { chainCursor: originMs, damageCursor: originMs, factor: 1, firstIndex: 1 };
}

// Decay the accumulated damage factor forward to atMs (never backwards).
function decayDamageTo(walk, atMs, lambda) {
  if (atMs > walk.damageCursor) {
    walk.factor = Math.pow(walk.factor, Math.exp(-lambda * (atMs - walk.damageCursor)));
    walk.damageCursor = atMs;
  }
}

// Evaluate the combined crash-damage multiplier at nowMs: the decayed
// committed damage of every completed episode plus the transient shape of
// the in-flight episode (if any). Resumes from the checkpoint accumulator
// when supplied. Returns the factor plus internal detail (never
// serialise publicly).
function evaluatePersistentDamage({ seed, coinId, originMs, nowMs, environment, checkpoint = null, config = resolveSimulationConfig() }) {
  assertFiniteNumber('originMs', originMs);
  assertFiniteNumber('nowMs', nowMs);
  if (nowMs < originMs) {
    throw new Error(`persistent pricing nowMs ${nowMs} precedes the world origin ${originMs}`);
  }
  const pc = config.persistent;
  const lambda = LN2 / pc.crashDamageHalfLifeMs;

  const walk = createDamageWalk({ originMs, checkpoint });
  if (walk.chainCursor > nowMs) {
    throw new Error(`persistent pricing crash checkpoint is from the future for nowMs=${nowMs} (cursorMs=${walk.chainCursor}); refusing to resume`);
  }

  let transientLevel = 1;
  let activeEpisode = null;
  let activatedCount = 0;

  for (let step = 0; step < MAX_PERSISTENT_EPISODES; step++) {
    const index = walk.firstIndex + step;
    const episode = priceEngine.drawCrashEpisode({ seed, coinId, episodeIndex: index, config });
    const start = walk.chainCursor + episode.gapMs;
    const crashEnd = start + episode.crashDurationMs;
    const end = crashEnd + episode.rallyDurationMs;
    if (start > nowMs) break; // future episode: no contribution

    // Committed historical semantics (§25): the environment in force at
    // the episode's START governs its activation and recovery — a later
    // regime change never rewrites an episode's committed history.
    const episodeEnvironment = resolveEnvironment(environment, start);
    const resolved = resolvePersistentEpisode(episode, episodeEnvironment, config);

    const completed = end <= nowMs;
    if (completed) {
      // Decay at EVERY completed window boundary (activated or not) so
      // the pow-sequence matches the freeze path bit-for-bit.
      decayDamageTo(walk, end, lambda);
      if (resolved.activated) {
        // Completed: commit the unrecovered portion into the decaying
        // damage accumulator.
        activatedCount += 1;
        walk.factor *= 1 - episode.magnitude * (1 - resolved.strength);
        if (!Number.isFinite(walk.factor) || walk.factor <= 0) {
          throw new Error(`persistent pricing computed an invalid damage factor ${String(walk.factor)} for coin ${String(coinId)}; aborting`);
        }
      }
    } else if (resolved.activated) {
      activatedCount += 1;
      if (nowMs < crashEnd) {
        // In the crash window: transient descent, never committed.
        const x = (nowMs - start) / episode.crashDurationMs;
        transientLevel = 1 - episode.magnitude * crashCurve(x);
        activeEpisode = { episodeIndex: index, stage: 'CRASH', magnitude: episode.magnitude, strength: resolved.strength };
      } else {
        // In the rally window: transient recovery, never committed.
        const x = (nowMs - crashEnd) / episode.rallyDurationMs;
        transientLevel = (1 - episode.magnitude) + episode.magnitude * resolved.strength * rallyCurve(x);
        activeEpisode = { episodeIndex: index, stage: resolved.rallyActive ? 'RALLY' : 'POST_CRASH', magnitude: episode.magnitude, strength: resolved.strength };
      }
    }
    walk.chainCursor = end; // the chain advances on drawn windows, never on activation
    if (!completed) break; // in-flight window: chain position reached
  }

  // Decay committed damage from the last commit to nowMs.
  decayDamageTo(walk, nowMs, lambda);
  const damageFactor = walk.factor * transientLevel;
  if (!Number.isFinite(damageFactor) || damageFactor <= 0) {
    throw new Error(`persistent pricing computed an invalid damage factor ${String(damageFactor)} for coin ${String(coinId)}; aborting`);
  }
  return {
    damageFactor,
    committedDamageFactor: walk.factor,
    transientLevel,
    activeEpisode,
    activatedCount
  };
}

// Freeze the persistent pricing checkpoint at nowMs (the row shape maps
// exactly onto market_price_checkpoints). The crash accumulator freezes
// at the END of the last COMPLETED candidate window at or before nowMs
// with the damage factor decayed to that cursor — the identical double
// the evaluation walk accumulates, so resume is bit-identical. An episode
// whose window CONTAINS nowMs (in flight) is never frozen (the in-flight
// episode rule): it is redrawn from the seed and re-evaluated transiently
// on resume.
function extractPersistentCheckpoint({ seed, coinId, archetypeId, originMs, nowMs, reference, environment, stored = null, config = resolveSimulationConfig() }) {
  assertFiniteNumber('originMs', originMs);
  assertFiniteNumber('nowMs', nowMs);
  const pc = config.persistent;
  const lambda = LN2 / pc.crashDamageHalfLifeMs;

  const { domainCheckpoint, crashCheckpoint } = stored
    ? resolvePersistentCheckpoint({ stored, seed, coinId, nowMs })
    : { domainCheckpoint: null, crashCheckpoint: null };

  // Domain half: the located cycle containing nowMs, its absolute start
  // and its exact anchor/boundary doubles.
  const location = locatePersistentCycle({
    seed, coinId, archetypeId, originMs, nowMs, reference,
    environment, checkpoint: domainCheckpoint, config
  });

  // Crash half: walk candidates (resuming from the stored accumulator)
  // and freeze at the last completed window at or before nowMs.
  const walk = createDamageWalk({ originMs, checkpoint: crashCheckpoint });
  if (walk.chainCursor > nowMs) {
    throw new Error(`persistent pricing crash checkpoint is from the future for nowMs=${nowMs} (cursorMs=${walk.chainCursor}); refusing to resume`);
  }
  let nextIndex = walk.firstIndex;
  for (let step = 0; step < MAX_PERSISTENT_EPISODES; step++) {
    const index = walk.firstIndex + step;
    const episode = priceEngine.drawCrashEpisode({ seed, coinId, episodeIndex: index, config });
    const start = walk.chainCursor + episode.gapMs;
    const crashEnd = start + episode.crashDurationMs;
    const end = crashEnd + episode.rallyDurationMs;
    if (end > nowMs) break; // in-flight or future candidate: never frozen
    const episodeEnvironment = resolveEnvironment(environment, start);
    const resolved = resolvePersistentEpisode(episode, episodeEnvironment, config);
    // Decay at EVERY completed window boundary (activated or not): the
    // identical pow-sequence the evaluation walk performs, so the frozen
    // factor is the exact double an evaluation at the cursor holds.
    decayDamageTo(walk, end, lambda);
    if (resolved.activated) {
      walk.factor *= 1 - episode.magnitude * (1 - resolved.strength);
      if (!Number.isFinite(walk.factor) || walk.factor <= 0) {
        throw new Error(`persistent pricing froze an invalid damage factor ${String(walk.factor)} for coin ${String(coinId)}; aborting`);
      }
    }
    walk.chainCursor = end;
    nextIndex = index + 1;
  }
  // The frozen factor is the committed damage decayed to the freeze
  // cursor (the last completed window end at or before nowMs; a no-op
  // here because the walk decays at every boundary — kept explicit as
  // the cursor contract).
  decayDamageTo(walk, walk.chainCursor, lambda);

  return {
    coinId: Number(coinId),
    seed,
    checkpointMs: nowMs,
    domainCycleIndex: location.cycle.index,
    domainCycleStartMs: location.startMs,
    domainAnchor: location.anchor,
    domainBoundary: location.boundary,
    crashEpisodeIndex: nextIndex,
    crashCursorMs: walk.chainCursor,
    crashFactor: walk.factor,
    activationContext: PERSISTENT_ACTIVATION_CONTEXT
  };
}

// ---------------------------------------------------------------------------
// The persistent price.
// ---------------------------------------------------------------------------

// The single authoritative persistent normal-price calculation. Options:
//   seed                persisted world seed (internal only)
//   coinId              catalogue coin id
//   archetypeId         the coin's explicit persistent archetype (never
//                       defaulted — master plan §29)
//   originMs            the world epoch origin instant (ms epoch)
//   nowMs               authoritative time (real clock live, injected in sim)
//   structuralReference the coin's authoritative structural reference (> 0)
//   environment         a Market Environment or provider (default: neutral)
//   eventModifier       capped net coin-event modifier (default 0)
//   pressureModifier    bounded decayed buy-minus-sell pressure (default 0)
//   checkpoint          a stored persistent checkpoint (row-shaped) or null
//   config              resolved simulation config (default: game defaults)
// Returns the unrounded exact price plus the internal factor breakdown
// (internal only). The price is always finite and strictly positive.
function computePersistentPrice({
  seed,
  coinId,
  archetypeId,
  originMs,
  nowMs,
  structuralReference,
  environment = NEUTRAL_ENVIRONMENT,
  eventModifier = 0,
  pressureModifier = 0,
  checkpoint = null,
  config = resolveSimulationConfig()
}) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('persistent pricing seed must be a non-empty string');
  }
  assertFiniteNumber('originMs', originMs);
  assertFiniteNumber('nowMs', nowMs);
  if (nowMs < originMs) {
    throw new Error(`persistent pricing nowMs ${nowMs} precedes the world origin ${originMs}`);
  }
  assertPositive('structuralReference', structuralReference);
  assertFiniteNumber('eventModifier', eventModifier);
  assertFiniteNumber('pressureModifier', pressureModifier);

  const { domainCheckpoint, crashCheckpoint } = checkpoint
    ? resolvePersistentCheckpoint({ stored: checkpoint, seed, coinId, nowMs })
    : { domainCheckpoint: null, crashCheckpoint: null };

  const location = locatePersistentCycle({
    seed, coinId, archetypeId, originMs, nowMs,
    reference: structuralReference, environment, checkpoint: domainCheckpoint, config
  });
  const point = evaluatePersistentCyclePoint({
    location, seed, coinId, archetypeId, reference: structuralReference, nowMs, config
  });
  const noise = persistentNoiseAt(buildPersistentNoise({ seed, coinId, archetypeId }), nowMs)
    * location.environment.volatilityScale;

  const damage = evaluatePersistentDamage({
    seed, coinId, originMs, nowMs, environment, checkpoint: crashCheckpoint, config
  });

  // The composed persistent normal modifier: coin events + bounded
  // trading pressure only (no lifecycle pressure term exists in the
  // persistent path), hard-clamped so stacking can never run away.
  const normalModifier = clamp(
    eventModifier + pressureModifier,
    -config.persistent.normalModifierLimit,
    config.persistent.normalModifierLimit
  );

  const raw = point.value * (1 + noise) * damage.damageFactor * (1 + normalModifier);
  // The strictly-positive living floor (§27): a living coin's price can
  // never reach zero, go negative or become NaN. Touching the floor is
  // NOT death — death is an explicit authoritative transition (Stage 9).
  const price = Number.isFinite(raw) && raw > 0
    ? Math.max(marketDomain.MIN_POSITIVE_PRICE, raw)
    : marketDomain.MIN_POSITIVE_PRICE;

  return {
    price,
    phase: point.phase,
    structuralLevel: point.structuralLevel,
    shapeValue: point.value,
    noise,
    damageFactor: damage.damageFactor,
    committedDamageFactor: damage.committedDamageFactor,
    transientLevel: damage.transientLevel,
    normalModifier,
    activeEpisode: damage.activeEpisode,
    activatedCount: damage.activatedCount,
    environment: location.environment
  };
}

// The persisted gameplay price: the persistent price at the shared 4dp
// gameplay rounding (marketDomain.roundGamePrice — the ONLY rounding
// rule, unchanged).
function persistentPriceAt(options) {
  return marketDomain.roundGamePrice(computePersistentPrice(options).price);
}

// ---------------------------------------------------------------------------
// Authoritative coin-state transitions (writer/simulation applied per
// batch — never inside the pure price walk). All pure and deterministic.
// ---------------------------------------------------------------------------

// §23: the structural reference evolves SLOWLY with the coin's committed
// condition and the environment's structural bias, in log space, bounded
// per unit time. Positive condition lifts the reference; negative
// condition lowers it; the environment bias shifts it directly.
function advanceStructuralReference({ structuralReference, condition, environment = NEUTRAL_ENVIRONMENT, elapsedMs, config = resolveSimulationConfig() }) {
  assertPositive('structuralReference', structuralReference);
  assertFiniteNumber('condition', condition);
  if (condition < -1 || condition > 1) {
    throw new Error(`persistent pricing condition must be in [-1, 1]; received ${condition}`);
  }
  assertFiniteNumber('elapsedMs', elapsedMs);
  if (elapsedMs < 0) {
    throw new Error(`persistent pricing elapsedMs must be non-negative; received ${elapsedMs}`);
  }
  const env = resolveEnvironment(environment, 0);
  const pc = config.persistent;
  const days = elapsedMs / DAY_MS;
  const uncapped = (condition * pc.referenceConditionRatePerDay + env.structuralBias) * days;
  const bound = pc.maxReferenceLogMovePerDay * days;
  const delta = clamp(uncapped, -bound, bound);
  const next = structuralReference * Math.exp(delta);
  if (!Number.isFinite(next) || next <= 0) {
    throw new Error(`persistent pricing computed an invalid structural reference ${String(next)}; aborting`);
  }
  return next;
}

// §26: the decaying/rolling peak reference. The peak decays exponentially
// toward the living price with the configured half-life and is lifted by
// any higher current price — a boom long ago never permanently marks a
// healthy coin as catastrophically drawn down, and the reference never
// sits below the current price.
function advancePeakReference({ peakReference, price, elapsedMs, config = resolveSimulationConfig() }) {
  assertPositive('peakReference', peakReference);
  assertPositive('price', price);
  assertFiniteNumber('elapsedMs', elapsedMs);
  if (elapsedMs < 0) {
    throw new Error(`persistent pricing elapsedMs must be non-negative; received ${elapsedMs}`);
  }
  const lambda = LN2 / config.persistent.peakReferenceHalfLifeMs;
  const decayed = peakReference * Math.exp(-lambda * elapsedMs);
  return Math.max(price, decayed);
}

// The drawdown of a living price from its decaying peak reference (a
// fraction in [0, 1)).
function computePeakDrawdown(peakReference, price) {
  assertPositive('peakReference', peakReference);
  assertPositive('price', price);
  return Math.max(0, (peakReference - price) / peakReference);
}

// §11: bidirectional condition dynamics. The authoritative condition
// (migration 024, bounded [-1, 1]) moves toward a target derived from
// committed observable behaviour at a bounded rate, with a weak mean
// reversion toward neutral. Every input is committed state: the recent
// log return over the public window, the drawdown from the DECAYING peak,
// the committed decaying crash damage (log space), the stack-capped net
// coin-event modifier and the resolved environment. The drawdown and
// damage terms act on the EXCESS over the archetype's measured neutral
// typicals (config), so condition reflects unusually good/bad recent
// behaviour FOR THE ARCHETYPE — the neutral environment holds condition
// near zero mean and the structural reference does not secularly drift.
// It moves both directions by construction.
function advanceCondition({
  condition,
  archetypeId,
  elapsedMs,
  recentLogReturn = 0,
  drawdownFromPeak = 0,
  logCommittedDamage = 0,
  netEventModifier = 0,
  environment = NEUTRAL_ENVIRONMENT,
  config = resolveSimulationConfig()
}) {
  assertFiniteNumber('condition', condition);
  if (condition < -1 || condition > 1) {
    throw new Error(`persistent pricing condition must be in [-1, 1]; received ${condition}`);
  }
  const archetype = marketDomain.MARKET_ARCHETYPES[archetypeId];
  if (!archetype) {
    throw new Error(`persistent pricing condition requires an explicit known archetype; received ${JSON.stringify(archetypeId)}`);
  }
  assertFiniteNumber('elapsedMs', elapsedMs);
  if (elapsedMs < 0) {
    throw new Error(`persistent pricing elapsedMs must be non-negative; received ${elapsedMs}`);
  }
  assertFiniteNumber('recentLogReturn', recentLogReturn);
  assertFiniteNumber('drawdownFromPeak', drawdownFromPeak);
  assertFiniteNumber('logCommittedDamage', logCommittedDamage);
  assertFiniteNumber('netEventModifier', netEventModifier);
  const env = resolveEnvironment(environment, 0);
  const cc = config.persistent.condition;
  const days = elapsedMs / DAY_MS;

  const drawdownExcess = drawdownFromPeak - cc.typicalDrawdown[archetypeId];
  const damageExcess = logCommittedDamage - cc.typicalLogCommittedDamage[archetypeId];
  const target = clamp(
    cc.recentReturnWeight * Math.tanh(recentLogReturn / cc.recentReturnScale)
      - cc.drawdownWeight * clamp(drawdownExcess, -1, 1)
      + cc.crashDamageWeight * clamp(damageExcess, -1, 0.5)
      + cc.eventWeight * netEventModifier
      + cc.environmentWeight * Math.tanh(env.structuralBias / cc.environmentBiasScale),
    -1,
    1
  );
  const maxStep = cc.maxChangePerDay * days;
  const step = clamp(target - condition, -maxStep, maxStep);
  const reverted = (condition + step) * (1 - cc.meanReversionPerDay * days);
  return clamp(reverted, -1, 1);
}

module.exports = {
  DAY_MS,
  MAX_PERSISTENT_CYCLES,
  MAX_PERSISTENT_EPISODES,
  PERSISTENT_ACTIVATION_CONTEXT,
  CONDITION_LABELS,
  conditionLabel,
  drawPersistentLogDrift,
  advanceAnchor,
  assertPersistentDomainCheckpoint,
  assertPersistentCrashCheckpoint,
  resolvePersistentCheckpoint,
  locatePersistentCycle,
  buildPersistentNoise,
  persistentNoiseAt,
  evaluatePersistentCyclePoint,
  resolvePersistentEpisode,
  evaluatePersistentDamage,
  extractPersistentCheckpoint,
  computePersistentPrice,
  persistentPriceAt,
  advanceStructuralReference,
  advancePeakReference,
  computePeakDrawdown,
  advanceCondition
};
