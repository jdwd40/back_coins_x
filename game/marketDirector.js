// Persistent-market Stage 3 (master plan §8/§10/§74): the Market Director.
//
// The Director is a DETERMINISTIC, lightweight, game-logic controller of
// broad market conditions — not an LLM, not a general agent. It walks a
// seeded chain of the six persistent regimes (GOLDEN_AGE, BOOM, BULL,
// BEAR, BUST, RECESSION) with bounded durations and bounded intensities,
// and produces the Market Environment the persistent systems consume
// through the game/marketEnvironment.js seam. It INFLUENCES the market
// environment; it never sets final prices.
//
// Determinism contract: no Math.random(), no wall-clock reads, no
// database access. The regime chain is a pure function of the world seed
// and the injected instant:
//   * genesis regime drawn from director.initialWeights;
//   * each regime's duration and intensity drawn from its config ranges;
//   * each transition drawn from director.transitionWeights[current].
// Same seed -> identical chain, in every process, forever. Deterministic
// replay is the acceptance contract.
//
// Chain walk: environmentAt(nowMs) walks the chain from the world origin
// to nowMs. A monotone in-memory cursor memoises the walk (lookbacks —
// e.g. an episode start behind the cursor — re-walk from the origin, a pure
// seeded computation, never a second implementation). Regime evaluations
// inside a single batch walk are forward-only, so the cursor amortises the
// world age exactly like the pricing checkpoints do.
//
// Public contract (master plan §10): publicRegimeAt exposes ONLY the current
// public regime and its intensity (players see the current regime; the chain
// internals, transition rolls and future regimes are NEVER exposed. Bots never
// see hidden future Director rolls or privileged probabilities — the provider
// never enters any bot state; only the resolved current environment enters the
// pricing inputs, and the public payload carries only regime + intensity.
//
// This module never requires any database or service module.

const { createSeededRandom } = require('./seededRandom');
const { NEUTRAL_ENVIRONMENT } = require('./marketEnvironment');
const { resolveSimulationConfig, MARKET_PHASE_IDS } = require('./simulationConfig');

// Bounded-walk guard: regime durations are >= 6 hours by config, so a
// 365-day world has well under 1,500 regimes — the guard bounds WALK
// LENGTH, never the absolute chain index.
const MAX_DIRECTOR_REGIMES = 100000;

function assertSeedAndOrigin(seed, originMs) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('market director seed must be a non-empty string');
  }
  if (typeof originMs !== 'number' || !Number.isFinite(originMs)) {
    throw new Error(`market director originMs must be a finite number; received ${String(originMs)}`);
  }
}

// The deterministic draws for one chain position. Fixed draw order:
// duration, intensity, transition roll. Same (seed, index) -> identical
// draws, in every process, forever. Own domain separator — independent of
// every pricing, risk and bot stream.
function drawDirectorStep({ seed, regimeIndex, config = resolveSimulationConfig() }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('market director seed must be a non-empty string');
  }
  if (!Number.isInteger(regimeIndex) || regimeIndex < 0) {
    throw new Error(`market director regime index must be a non-negative integer; received ${String(regimeIndex)}`);
  }
  const rng = createSeededRandom(`${seed}:persistent-director:regime:${regimeIndex}`);
  const durationRoll = rng();
  const intensityRoll = rng();
  const transitionRoll = rng();
  return { durationRoll, intensityRoll, transitionRoll };
}

// Select a regime id from a normalised weight set by a roll in [0, 1).
function selectRegime(weights, roll) {
  let cumulative = 0;
  for (const id of MARKET_PHASE_IDS) {
    cumulative += weights[id];
    if (roll < cumulative) return id;
  }
  // Floating-point tail: the last id is the safe fallback (weights are
  // validated normalised).
  return MARKET_PHASE_IDS[MARKET_PHASE_IDS.length - 1];
}

// Scale a regime's full-intensity environment template by its committed
// intensity: env = NEUTRAL + (template - NEUTRAL) x intensity. Pure.
function scaleEnvironment(template, intensity) {
  const out = {};
  for (const key of Object.keys(NEUTRAL_ENVIRONMENT)) {
    out[key] = NEUTRAL_ENVIRONMENT[key] + (template[key] - NEUTRAL_ENVIRONMENT[key]) * intensity;
  }
  return out;
}

// Walk the deterministic regime chain from a cursor to nowMs, returning
// the committed current regime. cursor: { regimeIndex, regime, startMs,
// durationMs, intensity } or null for the genesis. Pure: the chain is a
// pure function of (seed, index); the cursor only positions the walk.
function walkDirectorChain({ seed, originMs, nowMs, cursor = null, config = resolveSimulationConfig() }) {
  assertSeedAndOrigin(seed, originMs);
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error(`market director nowMs must be a finite number; received ${String(nowMs)}`);
  }
  // Staggered-start convention: a coin's first market cycle can begin
  // BEFORE the world epoch (seeded stagger offsets, marketDomain). Any
  // instant before the epoch resolves to the genesis regime — the world
  // simply has no earlier committed regime.
  const effectiveNowMs = Math.max(nowMs, originMs);
  const dc = config.director;

  let regimeIndex;
  let regime;
  let startMs;
  let durationMs;
  let intensity;

  if (cursor) {
    regimeIndex = cursor.regimeIndex;
    regime = cursor.regime;
    startMs = cursor.startMs;
    durationMs = cursor.durationMs;
    intensity = cursor.intensity;
    if (effectiveNowMs < startMs) {
      throw new Error(`market director cursor is from the future for nowMs=${nowMs} (startMs=${startMs}); refusing to resume`);
    }
  } else {
    // Genesis: index 0 regime drawn from initialWeights.
    const draws = drawDirectorStep({ seed, regimeIndex: 0, config });
    regime = selectRegime(dc.initialWeights, draws.transitionRoll);
    regimeIndex = 0;
    startMs = originMs;
    const range = dc.regimes[regime];
    durationMs = Math.round(range.durationMs.min + (range.durationMs.max - range.durationMs.min) * draws.durationRoll);
    intensity = range.intensity.min + (range.intensity.max - range.intensity.min) * draws.intensityRoll;
  }

  for (let i = 0; i < MAX_DIRECTOR_REGIMES; i++) {
    const endMs = startMs + durationMs;
    if (effectiveNowMs < endMs) {
      return { regimeIndex, regime, startMs, endMs, durationMs, intensity, environment: scaleEnvironment(dc.regimes[regime].environment, intensity) };
    }
    // Transition: the NEXT regime is selected by THIS position's
    // transition roll (drawn at this index) against the current regime's
    // weights — the committed chain is stable and pure.
    const draws = drawDirectorStep({ seed, regimeIndex, config });
    const nextRegime = selectRegime(dc.transitionWeights[regime], draws.transitionRoll);
    const nextDraws = drawDirectorStep({ seed, regimeIndex: regimeIndex + 1, config });
    const nextRange = dc.regimes[nextRegime];
    regimeIndex += 1;
    regime = nextRegime;
    startMs = endMs;
    durationMs = Math.round(nextRange.durationMs.min + (nextRange.durationMs.max - nextRange.durationMs.min) * nextDraws.durationRoll);
    intensity = nextRange.intensity.min + (nextRange.intensity.max - nextRange.intensity.min) * nextDraws.intensityRoll;
  }
  throw new Error(`market director chain walk exceeded the bounded-walk guard (${MAX_DIRECTOR_REGIMES} regimes); resume from a committed cursor instead of walking the world age`);
}

// Rebuild a chain-walk cursor from a committed market_director_state row
// (migration 025) so a restarted worker resumes the deterministic walk at
// the committed regime instead of re-walking the world age. The row stores
// (regime, regime_started_at, intensity, regime_index) — NOT duration_ms —
// but each position's duration and intensity are pure functions of
// (seed, regimeIndex) via drawDirectorStep, exactly as walkDirectorChain
// derives them (genesis and every transition use the draws AT that index).
// The rebuild re-derives both and verifies the committed intensity
// BIT-EXACTLY (float8 round-trips exactly through node-pg); a mismatch means
// the committed cursor is corrupt and fails loudly rather than resuming a
// forked chain. Pure: no database, no clock.
function resumeDirectorCursor({ seed, state, config = resolveSimulationConfig() }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('market director resume requires a non-empty seed');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('market director resume requires a committed director state row');
  }
  if (!Number.isInteger(state.regimeIndex) || state.regimeIndex < 0) {
    throw new Error(`market director resume regimeIndex must be a non-negative integer; received ${String(state.regimeIndex)}`);
  }
  if (!MARKET_PHASE_IDS.includes(state.regime)) {
    throw new Error(`market director resume regime must be one of ${MARKET_PHASE_IDS.join(', ')}; received ${JSON.stringify(state.regime)}`);
  }
  const startMs = new Date(state.regimeStartedAt).getTime();
  if (!Number.isFinite(startMs)) {
    throw new Error(`market director resume regimeStartedAt is invalid; received ${String(state.regimeStartedAt)}`);
  }
  const range = config.director.regimes[state.regime];
  const draws = drawDirectorStep({ seed, regimeIndex: state.regimeIndex, config });
  const durationMs = Math.round(range.durationMs.min + (range.durationMs.max - range.durationMs.min) * draws.durationRoll);
  const intensity = range.intensity.min + (range.intensity.max - range.intensity.min) * draws.intensityRoll;
  if (!Object.is(intensity, state.intensity)) {
    throw new Error(`market director resume: committed intensity ${String(state.intensity)} does not match the deterministic chain's ${String(intensity)} at regime index ${state.regimeIndex}; the committed cursor is corrupt — refusing to resume`);
  }
  return { regimeIndex: state.regimeIndex, regime: state.regime, startMs, durationMs, intensity };
}

// The Market Director as a Market Environment provider (the Stage 3
// provider behind the game/marketEnvironment.js seam — pricing never
// knows which provider it is evaluating). A monotone in-memory cursor
// memoises the chain walk; lookbacks re-walk from the origin (a pure
// seeded computation, never a second implementation). An optional initial
// cursor (e.g. rebuilt from the committed market_director_state row by
// resumeDirectorCursor) lets a restarted worker resume at the committed
// regime instead of re-walking the world age.
function createMarketDirectorProvider({ seed, originMs, cursor: initialCursor = null, config = resolveSimulationConfig() } = {}) {
  assertSeedAndOrigin(seed, originMs);
  let cursor = initialCursor;
  const locate = (nowMs) => {
    if (cursor && nowMs >= cursor.startMs) {
      const located = walkDirectorChain({ seed, originMs, nowMs, cursor, config });
      cursor = located;
      return located;
    }
    const located = walkDirectorChain({ seed, originMs, nowMs, config });
    if (!cursor || located.startMs > cursor.startMs) cursor = located;
    return located;
  };
  return {
    id: 'DIRECTOR',
    // The Market Environment in force at nowMs (validated by the seam).
    environmentAt(nowMs) {
      return locate(nowMs).environment;
    },
    // Internal detail (tests/diagnostics/runtime persistence only —
    // never serialised publicly): the committed regime record at nowMs.
    regimeAt(nowMs) {
      const located = locate(nowMs);
      return {
        regime: located.regime,
        regimeIndex: located.regimeIndex,
        startMs: located.startMs,
        endMs: located.endMs,
        durationMs: located.durationMs,
        intensity: located.intensity
      };
    },
    // The PUBLIC Director contract (master plan §10): the current regime
    // and its intensity ONLY. No chain index, no rolls, no timing of
    // future transitions.
    publicRegimeAt(nowMs) {
      const located = locate(nowMs);
      return { regime: located.regime, intensity: Math.round(located.intensity * 1000) / 1000 };
    }
  };
}

module.exports = {
  MAX_DIRECTOR_REGIMES,
  drawDirectorStep,
  selectRegime,
  scaleEnvironment,
  walkDirectorChain,
  resumeDirectorCursor,
  createMarketDirectorProvider
};
