// Crypto Chaos gameplay overhaul SIM-02: central simulation tuning config.
//
// This module is the single authoritative definition of the NEW gameplay
// simulation's tunable values (gameplay_changes.md / gameplay_build_plan.md
// Stage 1): coin events, market phases, the hidden lifecycle, crash/rally
// behaviour, bounded trading pressure, and dynamic collapse inputs. Do not
// scatter these numbers through controllers, workers, routes, services, or
// frontend code.
//
// Conventions (matching game/gameConstants.js and game/apocalypseVolatility.js):
//   * Defaults are game-design starting values from the specification, tuned
//     later through the simulation harness (Waves 6+). They are validated
//     tunables, never magic numbers.
//   * Validation REJECTS impossible ranges, out-of-range probabilities,
//     non-normalised weight sets, illegal caps, and broken ordering. Nothing
//     is silently coerced, clamped, or rounded into validity.
//   * DB-free and deterministic: no database handle, no clock, no
//     Math.random(), no timers, no environment reads. resolveSimulationConfig
//     is a pure function of its argument.
//   * The resolved config is deeply frozen: tuning must be changed here (or
//     via an explicit override object), never mutated at runtime.
//
// Wave 0 scope note: nothing in the live runtime requires this module yet.
// Later waves (SIM-03 onwards) wire these values into the engines; until
// then adding this module changes no existing behaviour.
//
// All fractions (modifiers, probabilities, magnitudes) are plain numbers:
// 0.02 means 2%. Durations are integer milliseconds.

// ---------------------------------------------------------------------------
// Fixed vocabularies (the redaction/validation contract — exact key sets).
// ---------------------------------------------------------------------------

// Coin-event strength categories, in ascending strength order.
const COIN_EVENT_STRENGTH_IDS = Object.freeze(['MINOR', 'MODERATE', 'MAJOR', 'EXTREME']);

// Market phases. The sign of each phase's modifier is part of the game
// design: positive phases must have strictly positive ranges, negative
// phases strictly negative ranges.
const MARKET_PHASE_IDS = Object.freeze([
  'GOLDEN_AGE', 'BOOM', 'BULL', 'BEAR', 'BUST', 'RECESSION'
]);
const POSITIVE_MARKET_PHASE_IDS = Object.freeze(['GOLDEN_AGE', 'BOOM', 'BULL']);
const NEGATIVE_MARKET_PHASE_IDS = Object.freeze(['BEAR', 'BUST', 'RECESSION']);

// Hidden lifecycle states, in legal transition order
// (GROWTH -> PLATEAU -> DECLINE -> COLLAPSE; never backwards).
const LIFECYCLE_STATE_IDS = Object.freeze(['GROWTH', 'PLATEAU', 'DECLINE', 'COLLAPSE']);

// Dynamic collapse risk input weights (gameplay_changes.md §20 /
// gameplay_build_plan.md Stage 10). Exact key set.
const COLLAPSE_INPUT_IDS = Object.freeze([
  'marketDrawdown',
  'coinPriceVsPeak',
  'negativeActiveEvents',
  'recentCrashDamage',
  'negativeMarketPhase',
  'recentSellPressure',
  'lifecycleStage',
  'cycleProgress'
]);

// Floating-point tolerance for probability/weight normalisation checks.
// Sums of 2dp values land within binary representation noise of 1.
const NORMALISATION_TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// Defaults — starting values from the agreed specification. All are balance
// starting points to be tuned by the Wave 6 harness, not permanent truths.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000;

const DEFAULT_SIMULATION_CONFIG = {
  // gameplay_changes.md §4 / build plan §4: per-coin temporary events.
  coinEvents: {
    // 1 to 15 minutes.
    durationMs: { min: 1 * MINUTE_MS, max: 15 * MINUTE_MS },
    // Up to 5 active events per coin simultaneously.
    maxActivePerCoin: 5,
    // Direction selection weights (normalised). The long-term negative
    // expectation comes from strength/bias, not from more negative events.
    directionWeights: { positive: 0.5, negative: 0.5 },
    // Strength ranges per category (fractions of price, applied with the
    // event's direction sign). Spec §4.3: Minor ±0.2-0.7%, Moderate
    // ±0.7-1.5%, Major ±1.5-3.0%, Extreme ±3.0-5.0%.
    strengthRanges: {
      MINOR: { min: 0.002, max: 0.007 },
      MODERATE: { min: 0.007, max: 0.015 },
      MAJOR: { min: 0.015, max: 0.03 },
      EXTREME: { min: 0.03, max: 0.05 }
    },
    // Category selection probabilities (normalised). Extreme is rare.
    strengthProbabilities: { MINOR: 0.5, MODERATE: 0.3, MAJOR: 0.15, EXTREME: 0.05 },
    // Maximum absolute net stacked modifier from simultaneous events
    // (spec §4.4: approximately ±6%).
    maxStackedModifier: 0.06,
    // Negative long-term bias (spec §2): over time, negative events' total
    // influence exceeds positive events' by this factor. Target band
    // 1.20-1.30; must stay STRICTLY > 1 (a value of 1 or below would mean
    // no net negative expectation, contradicting Rule 1: coin events must
    // have a long-term negative expectation).
    negativeBiasFactor: 1.25
  },

  // gameplay_changes.md §5-6 / build plan §5: temporary whole-market phases.
  marketPhases: {
    phases: {
      // Modifier ranges from the spec table; durations are tunable starting
      // points (extreme phases are shorter and rarer).
      GOLDEN_AGE: { modifier: { min: 0.025, max: 0.04 }, durationMs: { min: 2 * MINUTE_MS, max: 6 * MINUTE_MS } },
      BOOM: { modifier: { min: 0.015, max: 0.03 }, durationMs: { min: 3 * MINUTE_MS, max: 8 * MINUTE_MS } },
      BULL: { modifier: { min: 0.005, max: 0.015 }, durationMs: { min: 4 * MINUTE_MS, max: 10 * MINUTE_MS } },
      BEAR: { modifier: { min: -0.015, max: -0.005 }, durationMs: { min: 4 * MINUTE_MS, max: 10 * MINUTE_MS } },
      BUST: { modifier: { min: -0.03, max: -0.015 }, durationMs: { min: 3 * MINUTE_MS, max: 8 * MINUTE_MS } },
      RECESSION: { modifier: { min: -0.04, max: -0.025 }, durationMs: { min: 2 * MINUTE_MS, max: 6 * MINUTE_MS } }
    },
    // Phase selection weights per hidden lifecycle state (spec §6 / build
    // plan Stage 3): growth favours positive phases, plateau is balanced,
    // decline/collapse favour negative phases while keeping positive phases
    // possible (Rule 8: believable hope late in the game). Each set must be
    // normalised.
    lifecycleWeights: {
      GROWTH: { GOLDEN_AGE: 0.15, BOOM: 0.25, BULL: 0.35, BEAR: 0.15, BUST: 0.07, RECESSION: 0.03 },
      PLATEAU: { GOLDEN_AGE: 0.10, BOOM: 0.15, BULL: 0.25, BEAR: 0.25, BUST: 0.15, RECESSION: 0.10 },
      DECLINE: { GOLDEN_AGE: 0.03, BOOM: 0.07, BULL: 0.15, BEAR: 0.30, BUST: 0.25, RECESSION: 0.20 },
      COLLAPSE: { GOLDEN_AGE: 0.02, BOOM: 0.05, BULL: 0.10, BEAR: 0.28, BUST: 0.30, RECESSION: 0.25 }
    }
  },

  // gameplay_changes.md §7-13 / build plan Stages 4-5: hidden lifecycle.
  lifecycle: {
    // Macro market support during Growth (spec §3 example: +1.2% market
    // pressure overpowering roughly -0.4% coin-event drain). Must be
    // positive.
    growthSupportModifier: 0.012,
    // Per-cycle generated peak region as a multiple of the starting market
    // index (spec §10: each cycle generates a target peak region rather
    // than one fixed number). Must be >= 1 (a plateau below the starting
    // value contradicts the growth arc).
    plateauTargetMultiplier: { min: 2.0, max: 3.0 },
    // Plateau oscillation band around the target (spec §11: fluctuation
    // around the top, not a flat line). Fraction in (0, 1).
    plateauTolerance: 0.10,
    // Macro pressure during Decline (spec §12 example: market support
    // +0.3% no longer offsets the coin drain). Signed; must be below the
    // growth support.
    declinePressureModifier: 0.003,
    // Drawdown thresholds (spec §18), strictly ascending fractions in
    // (0, 1): normal struggle / panic crashes increasingly likely /
    // collapse risk territory.
    drawdownThresholds: { struggle: 0.05, panic: 0.15, collapseRisk: 0.30 },
    // Intensifying macro negative pressure range during Collapse (spec
    // §20-22: collapse pressure rises until every coin reaches £0). Both
    // bounds negative, ordered.
    collapsePressureModifier: { min: -0.08, max: -0.03 }
  },

  // gameplay_changes.md §14-19 / build plan Stages 7-8: crashes and rallies.
  // Crashes/rallies are distinct simulation states, NOT ordinary coin events.
  crashRally: {
    // Base crash probability per evaluation, per lifecycle state. Crashes
    // are uncommon early and increasingly likely after the plateau.
    crashProbability: { GROWTH: 0.02, PLATEAU: 0.04, DECLINE: 0.08, COLLAPSE: 0.12 },
    // Crash magnitude as a fraction of price removed. Significantly larger
    // than ordinary tick movement (Rule: crashes are dramatic).
    crashMagnitude: { min: 0.10, max: 0.35 },
    // Probability that a sufficiently large crash is followed by a rally,
    // per lifecycle state (dip buying; spec §15).
    rallyProbabilityAfterCrash: { GROWTH: 0.9, PLATEAU: 0.75, DECLINE: 0.6, COLLAPSE: 0.4 },
    // Recovery strength as a fraction of the value the crash removed.
    // Early: may exceed 1 (Rule 3: early crashes normally recover to a new
    // high). Late: usually below 1 (Rule 7: lower highs). Ordering
    // enforced: late.max <= early.max, early.max >= 1.
    recoveryStrength: {
      early: { min: 0.90, max: 1.10 },
      late: { min: 0.40, max: 0.80 }
    },
    // Probability that a late rally forms a lower high rather than
    // regaining the previous peak (spec §16: "usually a LOWER HIGH"; §19:
    // decline is interrupted but never permanently defeated).
    lowerHighBias: 0.7
  },

  // gameplay_changes.md §14-15 / build plan Stage 9: bounded, decaying
  // player/bot trading pressure. Trading amplifies movement but a few
  // trades must never control the market.
  tradingPressure: {
    // Absolute bounds on the price modifier contribution from recent buy /
    // sell pressure (fractions). Bounded influence only.
    maxBuyPressureModifier: 0.005,
    maxSellPressureModifier: 0.005,
    // Exponential decay half-life of accumulated pressure.
    decayHalfLifeMs: 2 * MINUTE_MS,
    // Volume normalisation: the notional (£) at which a single trade's raw
    // influence saturates before the per-trade cap applies.
    volumeNormalizationAmount: 1000,
    // A single transaction can never move the market by more than this
    // fraction (anti transaction-spam; must not exceed either bound).
    maxPerTradeInfluence: 0.0005
  },

  // gameplay_changes.md §20-22 / build plan Stage 10: dynamic collapse.
  // Inputs to per-coin collapse risk; the final all-coins-£0 guarantee
  // remains an elapsed-cycle-time safety rule owned by the engine (SIM-13),
  // not this config.
  dynamicCollapse: {
    // Normalised weights of the risk inputs (exact key set above).
    inputWeights: {
      marketDrawdown: 0.25,
      coinPriceVsPeak: 0.20,
      negativeActiveEvents: 0.10,
      recentCrashDamage: 0.10,
      negativeMarketPhase: 0.10,
      recentSellPressure: 0.10,
      lifecycleStage: 0.10,
      cycleProgress: 0.05
    },
    // Collapse chance is very low before the late game: the effective risk
    // is capped at this probability until the DECLINE state is reached.
    preDeclineRiskCap: 0.01,
    // Hard cap on per-evaluation collapse probability regardless of inputs.
    maxRiskPerEvaluation: 0.10
  }
};

// ---------------------------------------------------------------------------
// Validation. Everything throws; nothing is coerced.
// ---------------------------------------------------------------------------

function failConfig(message) {
  throw new Error(`Invalid simulation configuration: ${message}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A number must be a real JS number — strings and other types are rejected
// outright (never coerced via Number()).
function requireFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failConfig(`${name} must be a finite number; received ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  return value;
}

function requirePositiveInteger(name, value) {
  requireFiniteNumber(name, value);
  if (!Number.isInteger(value) || value <= 0) {
    failConfig(`${name} must be a positive integer; received ${value}`);
  }
  return value;
}

function requireProbability(name, value) {
  requireFiniteNumber(name, value);
  if (value < 0 || value > 1) {
    failConfig(`${name} must be a probability in [0, 1]; received ${value}`);
  }
  return value;
}

// An ordered range: both bounds finite, min strictly below max. Bounds may
// be negative (negative phase modifiers, collapse pressure).
function requireRange(name, range) {
  if (!isPlainObject(range)) {
    failConfig(`${name} must be a { min, max } object; received ${Array.isArray(range) ? 'array' : typeof range}`);
  }
  const keys = Object.keys(range).sort();
  if (keys.length !== 2 || keys[0] !== 'max' || keys[1] !== 'min') {
    failConfig(`${name} must have exactly the keys { min, max }; received { ${Object.keys(range).join(', ')} }`);
  }
  requireFiniteNumber(`${name}.min`, range.min);
  requireFiniteNumber(`${name}.max`, range.max);
  if (!(range.min < range.max)) {
    failConfig(`${name} requires min < max; received min ${range.min}, max ${range.max}`);
  }
  return range;
}

// Exact-key-set check: a missing OR extra key is a configuration error, so
// shape drift can never silently drop or smuggle a tuning knob.
function requireExactKeys(name, object, expectedKeys) {
  if (!isPlainObject(object)) {
    failConfig(`${name} must be an object; received ${Array.isArray(object) ? 'array' : typeof object}`);
  }
  const actual = Object.keys(object).sort();
  const expected = expectedKeys.slice().sort();
  if (actual.length !== expected.length || !actual.every((k, i) => k === expected[i])) {
    failConfig(`${name} must have exactly the keys { ${expected.join(', ')} }; received { ${actual.join(', ')} }`);
  }
}

// A probability/weight dictionary: exact keys, each in [0, 1], sum == 1.
function requireNormalisedWeights(name, weights, expectedKeys) {
  requireExactKeys(name, weights, expectedKeys);
  let sum = 0;
  for (const key of expectedKeys) {
    requireProbability(`${name}.${key}`, weights[key]);
    sum += weights[key];
  }
  if (Math.abs(sum - 1) > NORMALISATION_TOLERANCE) {
    failConfig(`${name} weights must sum to 1; they sum to ${sum}`);
  }
}

function validateCoinEvents(name, coinEvents) {
  requireExactKeys(name, coinEvents, [
    'durationMs', 'maxActivePerCoin', 'directionWeights', 'strengthRanges',
    'strengthProbabilities', 'maxStackedModifier', 'negativeBiasFactor'
  ]);

  const duration = requireRange(`${name}.durationMs`, coinEvents.durationMs);
  requirePositiveInteger(`${name}.durationMs.min`, duration.min);
  requirePositiveInteger(`${name}.durationMs.max`, duration.max);

  requirePositiveInteger(`${name}.maxActivePerCoin`, coinEvents.maxActivePerCoin);

  requireNormalisedWeights(`${name}.directionWeights`, coinEvents.directionWeights, ['positive', 'negative']);

  requireExactKeys(`${name}.strengthRanges`, coinEvents.strengthRanges, COIN_EVENT_STRENGTH_IDS);
  let previousMax = 0;
  for (const id of COIN_EVENT_STRENGTH_IDS) {
    const range = requireRange(`${name}.strengthRanges.${id}`, coinEvents.strengthRanges[id]);
    if (range.min <= 0) {
      failConfig(`${name}.strengthRanges.${id}.min must be positive (the sign comes from the event direction); received ${range.min}`);
    }
    // Ordering: categories must ascend (adjacent ranges may share a
    // boundary, e.g. Minor 0.2-0.7% / Moderate 0.7-1.5%).
    if (range.min < previousMax) {
      failConfig(`${name}.strengthRanges.${id} overlaps or precedes a weaker category; min ${range.min} is below ${previousMax}`);
    }
    previousMax = range.max;
  }

  requireNormalisedWeights(`${name}.strengthProbabilities`, coinEvents.strengthProbabilities, COIN_EVENT_STRENGTH_IDS);
  // Ordering: stronger categories must be rarer (extreme events are rare).
  for (let i = 1; i < COIN_EVENT_STRENGTH_IDS.length; i++) {
    const weaker = coinEvents.strengthProbabilities[COIN_EVENT_STRENGTH_IDS[i - 1]];
    const stronger = coinEvents.strengthProbabilities[COIN_EVENT_STRENGTH_IDS[i]];
    if (stronger > weaker) {
      failConfig(`${name}.strengthProbabilities.${COIN_EVENT_STRENGTH_IDS[i]} (${stronger}) exceeds ${COIN_EVENT_STRENGTH_IDS[i - 1]} (${weaker}); stronger events must be rarer`);
    }
  }

  requireFiniteNumber(`${name}.maxStackedModifier`, coinEvents.maxStackedModifier);
  if (coinEvents.maxStackedModifier <= 0) {
    failConfig(`${name}.maxStackedModifier must be positive; received ${coinEvents.maxStackedModifier}`);
  }
  // A stack cap below the extreme range would make extreme events
  // unreachable — an impossible configuration, not something to clip.
  if (coinEvents.maxStackedModifier < coinEvents.strengthRanges.EXTREME.max) {
    failConfig(`${name}.maxStackedModifier ${coinEvents.maxStackedModifier} is below the EXTREME strength maximum ${coinEvents.strengthRanges.EXTREME.max}`);
  }

  requireFiniteNumber(`${name}.negativeBiasFactor`, coinEvents.negativeBiasFactor);
  if (coinEvents.negativeBiasFactor <= 1) {
    failConfig(`${name}.negativeBiasFactor must be strictly greater than 1 (coin events must have a long-term negative expectation); received ${coinEvents.negativeBiasFactor}`);
  }
}

function validateMarketPhases(name, marketPhases) {
  requireExactKeys(name, marketPhases, ['phases', 'lifecycleWeights']);

  requireExactKeys(`${name}.phases`, marketPhases.phases, MARKET_PHASE_IDS);
  for (const id of MARKET_PHASE_IDS) {
    const phase = marketPhases.phases[id];
    requireExactKeys(`${name}.phases.${id}`, phase, ['modifier', 'durationMs']);
    const modifier = requireRange(`${name}.phases.${id}.modifier`, phase.modifier);
    if (POSITIVE_MARKET_PHASE_IDS.includes(id) && modifier.min <= 0) {
      failConfig(`${name}.phases.${id}.modifier must be strictly positive; received min ${modifier.min}`);
    }
    if (NEGATIVE_MARKET_PHASE_IDS.includes(id) && modifier.max >= 0) {
      failConfig(`${name}.phases.${id}.modifier must be strictly negative; received max ${modifier.max}`);
    }
    const duration = requireRange(`${name}.phases.${id}.durationMs`, phase.durationMs);
    requirePositiveInteger(`${name}.phases.${id}.durationMs.min`, duration.min);
    requirePositiveInteger(`${name}.phases.${id}.durationMs.max`, duration.max);
  }

  requireExactKeys(`${name}.lifecycleWeights`, marketPhases.lifecycleWeights, LIFECYCLE_STATE_IDS);
  for (const state of LIFECYCLE_STATE_IDS) {
    requireNormalisedWeights(`${name}.lifecycleWeights.${state}`, marketPhases.lifecycleWeights[state], MARKET_PHASE_IDS);
    // Both phase groups must stay possible in EVERY lifecycle state:
    // negative phases during Growth (crashes/bear spells are possible
    // early) and positive phases during Decline/Collapse (Rule 8:
    // believable hope late in the game). A state with a zeroed group
    // makes one direction impossible, which the design forbids.
    const weights = marketPhases.lifecycleWeights[state];
    const positiveTotal = POSITIVE_MARKET_PHASE_IDS.reduce((sum, id) => sum + weights[id], 0);
    const negativeTotal = NEGATIVE_MARKET_PHASE_IDS.reduce((sum, id) => sum + weights[id], 0);
    if (positiveTotal <= 0) {
      failConfig(`${name}.lifecycleWeights.${state} gives the positive phases a zero total; positive phases must remain possible in every lifecycle state (believable hope)`);
    }
    if (negativeTotal <= 0) {
      failConfig(`${name}.lifecycleWeights.${state} gives the negative phases a zero total; negative phases must remain possible in every lifecycle state`);
    }
  }
}

function validateLifecycle(name, lifecycle) {
  requireExactKeys(name, lifecycle, [
    'growthSupportModifier', 'plateauTargetMultiplier', 'plateauTolerance',
    'declinePressureModifier', 'drawdownThresholds', 'collapsePressureModifier'
  ]);

  requireFiniteNumber(`${name}.growthSupportModifier`, lifecycle.growthSupportModifier);
  if (lifecycle.growthSupportModifier <= 0) {
    failConfig(`${name}.growthSupportModifier must be positive (early market support must exceed coin drain); received ${lifecycle.growthSupportModifier}`);
  }

  const target = requireRange(`${name}.plateauTargetMultiplier`, lifecycle.plateauTargetMultiplier);
  if (target.min < 1) {
    failConfig(`${name}.plateauTargetMultiplier.min must be >= 1 (the peak region cannot sit below the starting market index); received ${target.min}`);
  }

  requireFiniteNumber(`${name}.plateauTolerance`, lifecycle.plateauTolerance);
  if (lifecycle.plateauTolerance <= 0 || lifecycle.plateauTolerance >= 1) {
    failConfig(`${name}.plateauTolerance must be a fraction in (0, 1); received ${lifecycle.plateauTolerance}`);
  }

  requireFiniteNumber(`${name}.declinePressureModifier`, lifecycle.declinePressureModifier);
  // Ordering: decline support must be weaker than growth support, or the
  // growth -> decline transition is meaningless.
  if (lifecycle.declinePressureModifier >= lifecycle.growthSupportModifier) {
    failConfig(`${name}.declinePressureModifier ${lifecycle.declinePressureModifier} must be below growthSupportModifier ${lifecycle.growthSupportModifier}`);
  }

  requireExactKeys(`${name}.drawdownThresholds`, lifecycle.drawdownThresholds, ['struggle', 'panic', 'collapseRisk']);
  const t = lifecycle.drawdownThresholds;
  for (const key of ['struggle', 'panic', 'collapseRisk']) {
    requireFiniteNumber(`${name}.drawdownThresholds.${key}`, t[key]);
    if (t[key] <= 0 || t[key] >= 1) {
      failConfig(`${name}.drawdownThresholds.${key} must be a fraction in (0, 1); received ${t[key]}`);
    }
  }
  if (!(t.struggle < t.panic && t.panic < t.collapseRisk)) {
    failConfig(`${name}.drawdownThresholds must be strictly ascending (struggle < panic < collapseRisk); received ${t.struggle}, ${t.panic}, ${t.collapseRisk}`);
  }

  const collapse = requireRange(`${name}.collapsePressureModifier`, lifecycle.collapsePressureModifier);
  if (collapse.max >= 0) {
    failConfig(`${name}.collapsePressureModifier must be strictly negative; received max ${collapse.max}`);
  }
}

function validateCrashRally(name, crashRally) {
  requireExactKeys(name, crashRally, [
    'crashProbability', 'crashMagnitude', 'rallyProbabilityAfterCrash',
    'recoveryStrength', 'lowerHighBias'
  ]);

  requireExactKeys(`${name}.crashProbability`, crashRally.crashProbability, LIFECYCLE_STATE_IDS);
  for (const state of LIFECYCLE_STATE_IDS) {
    requireProbability(`${name}.crashProbability.${state}`, crashRally.crashProbability[state]);
  }
  // Ordering: crash danger must be non-decreasing along the lifecycle
  // (GROWTH <= PLATEAU <= DECLINE <= COLLAPSE). Crashes get more likely
  // after the plateau, never less (spec §14-19 / Rule: permanent downward
  // bias after plateau).
  for (let i = 1; i < LIFECYCLE_STATE_IDS.length; i++) {
    const previous = crashRally.crashProbability[LIFECYCLE_STATE_IDS[i - 1]];
    const current = crashRally.crashProbability[LIFECYCLE_STATE_IDS[i]];
    if (current < previous) {
      failConfig(`${name}.crashProbability.${LIFECYCLE_STATE_IDS[i]} (${current}) is below ${LIFECYCLE_STATE_IDS[i - 1]} (${previous}); crash danger must be non-decreasing through the lifecycle`);
    }
  }

  const magnitude = requireRange(`${name}.crashMagnitude`, crashRally.crashMagnitude);
  if (magnitude.min <= 0 || magnitude.max >= 1) {
    failConfig(`${name}.crashMagnitude must be a fraction range inside (0, 1); received ${magnitude.min}..${magnitude.max}`);
  }

  requireExactKeys(`${name}.rallyProbabilityAfterCrash`, crashRally.rallyProbabilityAfterCrash, LIFECYCLE_STATE_IDS);
  for (const state of LIFECYCLE_STATE_IDS) {
    requireProbability(`${name}.rallyProbabilityAfterCrash.${state}`, crashRally.rallyProbabilityAfterCrash[state]);
  }

  requireExactKeys(`${name}.recoveryStrength`, crashRally.recoveryStrength, ['early', 'late']);
  const early = requireRange(`${name}.recoveryStrength.early`, crashRally.recoveryStrength.early);
  const late = requireRange(`${name}.recoveryStrength.late`, crashRally.recoveryStrength.late);
  if (early.min <= 0 || late.min <= 0) {
    failConfig(`${name}.recoveryStrength ranges must be positive; received early.min ${early.min}, late.min ${late.min}`);
  }
  if (early.max < 1) {
    failConfig(`${name}.recoveryStrength.early.max must be >= 1 so an early rally can reach a new high; received ${early.max}`);
  }
  if (late.max > early.max) {
    failConfig(`${name}.recoveryStrength.late.max ${late.max} must not exceed early.max ${early.max} (late rallies are weaker)`);
  }

  requireProbability(`${name}.lowerHighBias`, crashRally.lowerHighBias);
}

function validateTradingPressure(name, tradingPressure) {
  requireExactKeys(name, tradingPressure, [
    'maxBuyPressureModifier', 'maxSellPressureModifier', 'decayHalfLifeMs',
    'volumeNormalizationAmount', 'maxPerTradeInfluence'
  ]);

  for (const key of ['maxBuyPressureModifier', 'maxSellPressureModifier', 'volumeNormalizationAmount']) {
    requireFiniteNumber(`${name}.${key}`, tradingPressure[key]);
    if (tradingPressure[key] <= 0) {
      failConfig(`${name}.${key} must be positive; received ${tradingPressure[key]}`);
    }
  }

  requirePositiveInteger(`${name}.decayHalfLifeMs`, tradingPressure.decayHalfLifeMs);

  requireFiniteNumber(`${name}.maxPerTradeInfluence`, tradingPressure.maxPerTradeInfluence);
  if (tradingPressure.maxPerTradeInfluence <= 0) {
    failConfig(`${name}.maxPerTradeInfluence must be positive; received ${tradingPressure.maxPerTradeInfluence}`);
  }
  // Ordering: a single trade can never exceed the total bounded influence.
  const bound = Math.min(tradingPressure.maxBuyPressureModifier, tradingPressure.maxSellPressureModifier);
  if (tradingPressure.maxPerTradeInfluence > bound) {
    failConfig(`${name}.maxPerTradeInfluence ${tradingPressure.maxPerTradeInfluence} exceeds the pressure bound ${bound}`);
  }
}

function validateDynamicCollapse(name, dynamicCollapse) {
  requireExactKeys(name, dynamicCollapse, [
    'inputWeights', 'preDeclineRiskCap', 'maxRiskPerEvaluation'
  ]);

  requireNormalisedWeights(`${name}.inputWeights`, dynamicCollapse.inputWeights, COLLAPSE_INPUT_IDS);

  requireProbability(`${name}.preDeclineRiskCap`, dynamicCollapse.preDeclineRiskCap);
  requireProbability(`${name}.maxRiskPerEvaluation`, dynamicCollapse.maxRiskPerEvaluation);
  // Ordering: the early-game cap cannot exceed the absolute cap.
  if (dynamicCollapse.preDeclineRiskCap > dynamicCollapse.maxRiskPerEvaluation) {
    failConfig(`${name}.preDeclineRiskCap ${dynamicCollapse.preDeclineRiskCap} exceeds maxRiskPerEvaluation ${dynamicCollapse.maxRiskPerEvaluation}`);
  }
}

// Validate a COMPLETE simulation config: every section and every leaf must
// be present with exactly the expected keys, and every value must pass its
// range/probability/cap/ordering rules. Throws on the first problem.
function validateSimulationConfig(config) {
  if (!isPlainObject(config)) {
    failConfig(`config must be an object; received ${Array.isArray(config) ? 'array' : typeof config}`);
  }
  requireExactKeys('config', config, [
    'coinEvents', 'marketPhases', 'lifecycle', 'crashRally', 'tradingPressure', 'dynamicCollapse'
  ]);
  validateCoinEvents('coinEvents', config.coinEvents);
  validateMarketPhases('marketPhases', config.marketPhases);
  validateLifecycle('lifecycle', config.lifecycle);
  validateCrashRally('crashRally', config.crashRally);
  validateTradingPressure('tradingPressure', config.tradingPressure);
  validateDynamicCollapse('dynamicCollapse', config.dynamicCollapse);
  return config;
}

// Deep freeze: the resolved config is immutable. Mirrors the Object.freeze
// vocabulary used across the game modules, extended to nested sections so
// tuning can never be mutated at runtime.
function deepFreeze(value) {
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// Recursive merge of an override section onto a defaults section. Override
// keys that do not exist in the defaults are rejected (an unknown key is a
// configuration error, never silently added); non-object leaves replace
// defaults wholesale and are validated after the merge.
function mergeSection(defaults, overrides, path) {
  if (!isPlainObject(overrides)) {
    failConfig(`${path} override must be an object; received ${Array.isArray(overrides) ? 'array' : typeof overrides}`);
  }
  const merged = {};
  for (const key of Object.keys(defaults)) {
    merged[key] = defaults[key];
  }
  for (const key of Object.keys(overrides)) {
    if (!(key in defaults)) {
      failConfig(`${path} has unknown key ${JSON.stringify(key)}`);
    }
    if (isPlainObject(defaults[key])) {
      merged[key] = mergeSection(defaults[key], overrides[key], `${path}.${key}`);
    } else {
      merged[key] = overrides[key];
    }
  }
  return merged;
}

// Resolve the effective config. With no overrides this is the validated,
// frozen game-design default. With a partial override object, the overrides
// are merged per leaf onto the defaults, the COMPLETE result is validated
// (impossible ranges/probabilities/caps/ordering throw), and the merged
// object is deeply frozen. The input is never mutated.
function resolveSimulationConfig(overrides) {
  if (overrides === undefined || overrides === null) {
    return DEFAULT_SIMULATION_CONFIG;
  }
  if (!isPlainObject(overrides)) {
    failConfig(`overrides must be an object; received ${Array.isArray(overrides) ? 'array' : typeof overrides}`);
  }
  const merged = mergeSection(DEFAULT_SIMULATION_CONFIG, overrides, 'config');
  validateSimulationConfig(merged);
  return deepFreeze(merged);
}

// The defaults are validated at module load: a broken default is a build
// error surfaced immediately, not a runtime surprise in a later wave.
validateSimulationConfig(DEFAULT_SIMULATION_CONFIG);
deepFreeze(DEFAULT_SIMULATION_CONFIG);

module.exports = {
  COIN_EVENT_STRENGTH_IDS,
  MARKET_PHASE_IDS,
  POSITIVE_MARKET_PHASE_IDS,
  NEGATIVE_MARKET_PHASE_IDS,
  LIFECYCLE_STATE_IDS,
  COLLAPSE_INPUT_IDS,
  DEFAULT_SIMULATION_CONFIG,
  validateSimulationConfig,
  resolveSimulationConfig
};
