// Crypto Chaos V2-3: coarse, imperfect public collapse-risk signals.
//
// This module is the SINGLE source of truth for the per-coin collapse-risk
// vocabulary shared by the live public market-signals endpoint
// (game/marketSignalsService.js) and the headless simulator
// (simulation/roundEnvironment.js). It is pure: no database, no real clock,
// no Math.random — every input is explicit.
//
// WHAT THE SIGNAL IS
//   A coarse danger hint for the desired late-game decision:
//     "My position is +30%. Apocalypse is 92%. The coin is CRITICAL.
//      Do I cash out or risk another rise?"
//   Risk rises with apocalypse progress (collapses only happen inside the
//   final 30% window — that window boundary is a fixed, publicly documented
//   game-design constant), with the coin's PUBLIC archetype personality,
//   and with currently OBSERVABLE market stress (phase/momentum/recent
//   movement — all already legal public signals).
//
// WHAT THE SIGNAL MUST NEVER BE
//   A leak of the hidden collapse schedule. This module NEVER reads the
//   persisted schedule, collapse ranks, scheduled timestamps or the
//   collapse RNG stream, and never derives risk from "is this the next
//   scheduled coin?" or any equivalent future lookup. Its only seeded
//   inputs are two noise streams with their own domain separators
//   (':v2-risk:' / ':v2-risk-jitter:'), which are INDEPENDENT of the Core 3
//   collapse shuffle — so the per-coin noise cannot correlate with the
//   collapse order. The result is deliberately useful but imperfect:
//   CRITICAL coins are genuinely dangerous to hold late in the round, yet
//   the risk ranking is provably NOT a classifier for which coin dies next
//   (asserted by test over seeded samples).
//
// Vocabulary (fixed, exported): STABLE < SHAKY < DANGER < CRITICAL for
// live coins. Collapsed coins are not rated here at all — the callers
// report them as dead (phase 'DEAD', risk marker 'DEAD') and they remain
// visibly dead and never buyable.

const { createSeededRandom } = require('./seededRandom');
const marketDomain = require('./marketDomain');

const COLLAPSE_RISK_LEVELS = Object.freeze(['STABLE', 'SHAKY', 'DANGER', 'CRITICAL']);
// Dead coins carry this marker instead of a level (callers compose it).
const DEAD_RISK_MARKER = 'DEAD';
const COLLAPSE_RISK_ORDINAL = Object.freeze({
  STABLE: 0,
  SHAKY: 1,
  DANGER: 2,
  CRITICAL: 3
});

// Score thresholds: [SHAKY, DANGER, CRITICAL] lower bounds.
const RISK_THRESHOLDS = Object.freeze({ SHAKY: 1.5, DANGER: 3.0, CRITICAL: 4.5 });

// Inherent risk personality per PUBLIC archetype. Coarse and static — a
// RUG coin is simply a more dangerous animal than a ZIP coin, and every
// player can see the archetype on the card. Deliberately too coarse to
// order coins within an archetype pair.
const ARCHETYPE_RISK = Object.freeze({
  ZIP: 0,
  MOON: 0.25,
  BULL: 0.5,
  HODL: 0.5,
  DEGEN: 1.25,
  RUG: 1.75
});

// Progress danger ramp. Collapses only occur from 70% onward, so danger
// begins rising ahead of the window and steepens inside it: zero below
// 45%, full weight at 100%. Uses ONLY the public apocalypse percentage.
function progressDanger(apocalypsePercent) {
  const p = typeof apocalypsePercent === 'number' && Number.isFinite(apocalypsePercent)
    ? Math.min(100, Math.max(0, apocalypsePercent))
    : 0;
  if (p <= 45) return 0;
  return 4 * Math.pow((p - 45) / 55, 1.5);
}

// Observable market stress from already-public signal fields. A coin deep
// in a FALL with downward momentum is genuinely dangerous to hold late in
// the round; a booming coin is not (its danger is missing the exit, which
// the phase signal already shows).
function marketStress({ phase, momentum, recentChangePct }) {
  let stress = 0;
  if (phase === 'FALL') stress += 1.0;
  if (momentum === 'DOWN') stress += 0.5;
  if (typeof recentChangePct === 'number' && Number.isFinite(recentChangePct)) {
    if (recentChangePct <= -10) stress += 1.0;
    else if (recentChangePct <= -5) stress += 0.5;
  }
  return stress;
}

// Per-coin persistent risk personality for this round: a seeded draw in
// [-1.5, +1.5) from the ':v2-risk:' stream. This is the intentional
// imperfection: it is independent of the collapse shuffle, changes every
// apocalypse (the round seed changes), and is large enough that the risk
// ranking can NEVER track the hidden collapse order.
function persistentNoise(seed, coinId) {
  const random = createSeededRandom(`${seed}:v2-risk:${Number(coinId)}`);
  return random() * 3 - 1.5;
}

// Slow time-varying jitter (5-minute buckets) in [-0.75, +0.75), so a
// coin's risk drifts a little as the round develops instead of reading as
// a static label. Fully deterministic in (seed, coinId, nowMs) — replay
// reproduces it exactly.
const RISK_JITTER_BUCKET_MS = 5 * 60 * 1000;
function jitterNoise(seed, coinId, nowMs) {
  const bucket = Math.floor(nowMs / RISK_JITTER_BUCKET_MS);
  const random = createSeededRandom(`${seed}:v2-risk-jitter:${Number(coinId)}:${bucket}`);
  return random() * 1.5 - 0.75;
}

// The numeric risk score for a live coin. Exported so the simulator can
// rank coins deterministically when measuring signal imperfectness; never
// serialised into any public payload (players see only the coarse level).
function getCollapseRiskScore({ seed, coinId, apocalypsePercent, phase, momentum, recentChangePct, nowMs }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('collapse risk seed must be a non-empty string');
  }
  const archetypeId = marketDomain.resolveArchetypeId(coinId);
  const score =
    progressDanger(apocalypsePercent) +
    (ARCHETYPE_RISK[archetypeId] || 0) +
    marketStress({ phase, momentum, recentChangePct }) +
    persistentNoise(seed, coinId) +
    jitterNoise(seed, coinId, Number.isFinite(nowMs) ? nowMs : 0);
  return score;
}

// The coarse public level for a live coin. Same inputs as the score; the
// only public output is one of COLLAPSE_RISK_LEVELS.
function getCollapseRisk(options) {
  const score = getCollapseRiskScore(options);
  if (score >= RISK_THRESHOLDS.CRITICAL) return 'CRITICAL';
  if (score >= RISK_THRESHOLDS.DANGER) return 'DANGER';
  if (score >= RISK_THRESHOLDS.SHAKY) return 'SHAKY';
  return 'STABLE';
}

module.exports = {
  COLLAPSE_RISK_LEVELS,
  COLLAPSE_RISK_ORDINAL,
  DEAD_RISK_MARKER,
  RISK_THRESHOLDS,
  ARCHETYPE_RISK,
  RISK_JITTER_BUCKET_MS,
  progressDanger,
  getCollapseRiskScore,
  getCollapseRisk
};
