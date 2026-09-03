// Persistent-market Stage 2 (master plan §10/§73): the persistent public
// coin signal — the single shared shape the future human-facing
// market-signals endpoint and the persistent bot decision layer both
// publish/consume (bots see the SAME public information or less, never
// hidden Director rolls, future environment, damage internals or death
// probabilities).
//
// This module is the persistent analogue of
// marketSignalsService.computeLiveCoinSignal: a PURE function over the
// persistent pricing engine (game/persistentPricing.js), the Market
// Environment seam and the coin's committed public condition. It invents
// no state store and never touches a database; the live/read-side
// adapters that assemble it from persisted world state arrive with the
// Stage 4/6 runtime threading.
//
// Redaction contract (the exact-key allowlist below): the payload carries
// ONLY coarse public fields — current price, recent public movement over
// the fixed public lookback, the current coarse phase (name only), the
// public condition LABEL (derived UI state, never the authoritative
// scalar), the coarse persistent collapse-risk level, the archetype and
// its approximate typical ranges. The world seed, anchors, cycle index,
// structural reference, damage accumulators, regime internals and any
// future information never survive this shape.

const marketDomain = require('./marketDomain');
const collapseRiskDomain = require('./collapseRiskDomain');
const persistentPricing = require('./persistentPricing');
const { NEUTRAL_ENVIRONMENT } = require('./marketEnvironment');
const { resolveSimulationConfig } = require('./simulationConfig');

// Keys a persistent public signal is allowed to carry — the redaction
// contract, enforced by test.
const PERSISTENT_PUBLIC_SIGNAL_KEYS = Object.freeze([
  'coinId',
  'archetype',
  'currentPrice',
  'recentChangePct',
  'phase',
  'momentum',
  'typicalCycleMinutes',
  'typicalSwingPct',
  'condition',
  'collapseRisk'
]);

// Recompute the coarse momentum vocabulary from a recent-change
// percentage (the shared domain threshold — identical public semantics to
// the V2 signal).
function coarseMomentum(recentChangePct) {
  return recentChangePct > marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT
    ? 'UP'
    : recentChangePct < -marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT
      ? 'DOWN'
      : 'FLAT';
}

// The persistent public signal for one LIVE coin at one instant. Options
// mirror computePersistentPrice plus the coin's committed public
// condition (used for the derived label and the coarse risk level — both
// computed from PUBLIC information only).
function computePersistentCoinSignal({
  seed,
  coinId,
  archetypeId,
  originMs,
  nowMs,
  structuralReference,
  condition = 0,
  environment = NEUTRAL_ENVIRONMENT,
  eventModifier = 0,
  pressureModifier = 0,
  checkpoint = null,
  lookbackMs = marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS,
  config = resolveSimulationConfig()
}) {
  const archetype = marketDomain.MARKET_ARCHETYPES[archetypeId];
  if (!archetype) {
    throw new Error(`persistent signals require an explicit known archetype for coin ${String(coinId)}; received ${JSON.stringify(archetypeId)}`);
  }
  if (typeof condition !== 'number' || !Number.isFinite(condition) || condition < -1 || condition > 1) {
    throw new Error(`persistent signals condition for coin ${String(coinId)} must be in [-1, 1]; received ${String(condition)}`);
  }

  const shared = {
    seed, coinId, archetypeId, originMs, structuralReference,
    environment, eventModifier, pressureModifier, checkpoint, config
  };
  const current = persistentPricing.computePersistentPrice({ ...shared, nowMs });
  const currentPrice = marketDomain.roundGamePrice(current.price);
  const pastMs = Math.max(originMs, nowMs - Math.max(1, lookbackMs));
  const pastPrice = persistentPricing.persistentPriceAt({ ...shared, nowMs: pastMs });
  const recentChangePct = pastPrice > 0
    ? Math.round(((currentPrice - pastPrice) / pastPrice) * 10000) / 100
    : null;
  const momentum = recentChangePct === null ? 'FLAT' : coarseMomentum(recentChangePct);

  return {
    coinId: Number(coinId),
    archetype: archetypeId,
    currentPrice,
    recentChangePct,
    phase: current.phase,
    momentum,
    typicalCycleMinutes: [archetype.cycleMs[0] / (60 * 1000), archetype.cycleMs[1] / (60 * 1000)],
    typicalSwingPct: [archetype.swing[0] * 100, archetype.swing[1] * 100],
    // §11: the derived UI label of the public condition scalar.
    condition: persistentPricing.conditionLabel(condition),
    // The coarse, imperfect persistent collapse-risk level — public
    // observables + schedule-independent seeded noise only (never hidden
    // Director rolls, damage internals or death probabilities).
    collapseRisk: collapseRiskDomain.getPersistentCollapseRisk({
      seed,
      coinId,
      archetypeId,
      condition,
      phase: current.phase,
      momentum,
      recentChangePct,
      nowMs
    })
  };
}

// The minimal public marker for a DEAD persistent coin: only its death
// and archetype identity — no phase/momentum/condition pretence (the same
// dead-marker contract as the V2 signal; history is preserved, trading is
// stopped permanently).
function deadPersistentSignal({ coinId, archetypeId }) {
  if (!marketDomain.MARKET_ARCHETYPES[archetypeId]) {
    throw new Error(`persistent signals require an explicit known archetype for coin ${String(coinId)}; received ${JSON.stringify(archetypeId)}`);
  }
  return {
    coinId: Number(coinId),
    archetype: archetypeId,
    currentPrice: 0,
    recentChangePct: null,
    phase: 'DEAD',
    momentum: 'FLAT',
    typicalCycleMinutes: null,
    typicalSwingPct: null,
    condition: null,
    collapseRisk: collapseRiskDomain.DEAD_RISK_MARKER,
    dead: true
  };
}

module.exports = {
  PERSISTENT_PUBLIC_SIGNAL_KEYS,
  computePersistentCoinSignal,
  deadPersistentSignal
};
