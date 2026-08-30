// V2-1: public market signals (read side).
//
// Builds the coarse, imperfect public signal set for every active catalogue
// coin. Price and recent-movement fields come from the unified price engine
// (game/priceEngine.js, SIM-08) fed by the persisted Wave 1/2 pricing
// context; the coarse phase label and typical archetype ranges come from
// the shared market domain. The shape is the exact same signal shape the
// headless simulator's legal strategies act on. Reconcile-then-read, like
// GET /api/game/state. The cycle seed is read here ONLY to evaluate the
// price path and is never included in the returned payload; no future
// phase, peak, timing, lifecycle or collapse information is present.

const db = require('../db/connection');
const marketDomain = require('./marketDomain');
const collapseRiskDomain = require('./collapseRiskDomain');
const { getApocalypseVolatility } = require('./apocalypseVolatility');
const collapseScheduleService = require('./collapseScheduleService');
const priceEngine = require('./priceEngine');
const { loadPricingContext } = require('./pricingContext');

// Recompute the coarse momentum vocabulary from a recent-change percentage.
// Mirrors the domain's threshold exactly (exported constant), so the
// unified-price override below keeps the same public semantics.
function coarseMomentum(recentChangePct) {
  return recentChangePct > marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT
    ? 'UP'
    : recentChangePct < -marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT
      ? 'DOWN'
      : 'FLAT';
}

// The public signal for one LIVE coin at one instant (SIM-08). Shared by
// getPublicMarketSignals and botService.buildPublicMarketState so the human
// endpoint and the bot decision layer always publish identical values for
// the same instant (that parity is enforced by v2-bot-signals.test.js).
//
// Prices and recent movement are evaluated through the SAME unified price
// path the live writer persists (game/priceEngine.js fed by the persisted
// Wave 1/2 pricing context) — otherwise this signal would publish
// baseline-path prices that no longer match coins.current_price. The coarse
// phase label and typical archetype ranges stay domain-based. The context
// values themselves (lifecycle state, phase/event modifiers) remain hidden:
// only the coarse public keys survive in the returned shape.
function computeLiveCoinSignal({ seed, coin, nowMs, amplitude, apocalypsePercent, roundStartMs, cycleDurationMs, pricingContext }) {
  const coinId = coin.coin_id;
  const baselinePrice = parseFloat(coin.cycle_baseline_price);
  const publicSignal = marketDomain.getPublicCoinSignal({
    seed, coinId, baselinePrice, roundStartMs, nowMs, amplitude
  });

  const lookbackMs = nowMs - marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS;
  const cycleProgressAt = (tMs) => Math.min(1, Math.max(0, (tMs - roundStartMs) / cycleDurationMs));
  const shared = {
    seed,
    coinId,
    baselinePrice,
    roundStartMs,
    amplitude,
    lifecycleState: pricingContext.lifecycleState
  };
  const currentPrice = priceEngine.unifiedPriceAt({
    ...shared,
    nowMs,
    cycleProgress: cycleProgressAt(nowMs),
    phaseModifier: pricingContext.phaseModifierAt(nowMs),
    eventModifier: pricingContext.eventModifierFor(coinId, nowMs)
  });
  const pastPrice = priceEngine.unifiedPriceAt({
    ...shared,
    nowMs: lookbackMs,
    cycleProgress: cycleProgressAt(lookbackMs),
    phaseModifier: pricingContext.phaseModifierAt(lookbackMs),
    eventModifier: pricingContext.eventModifierFor(coinId, lookbackMs)
  });
  const recentChangePct = pastPrice > 0
    ? Math.round(((currentPrice - pastPrice) / pastPrice) * 10000) / 100
    : null;
  const momentum = recentChangePct === null ? publicSignal.momentum : coarseMomentum(recentChangePct);

  return {
    ...publicSignal,
    currentPrice,
    recentChangePct,
    momentum,
    // V2-3: coarse, imperfect collapse-risk level. Computed ONLY from
    // public state (progress, public phase/momentum/movement, public
    // archetype) plus schedule-independent seeded noise — never from the
    // hidden collapse schedule, which is not even read here.
    collapseRisk: collapseRiskDomain.getCollapseRisk({
      seed,
      coinId,
      apocalypsePercent,
      phase: publicSignal.phase,
      momentum,
      recentChangePct,
      nowMs
    })
  };
}

async function getPublicMarketSignals({ now = new Date() } = {}) {
  // Lazy require, matching the codebase's cycle-boundary convention (this
  // module is a read-side consumer of Core 1; gameCycleService never
  // requires this module).
  const { reconcileCycle, deriveProgress } = require('./gameCycleService');

  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const cycle = await reconcileCycle({ now: nowDate });
  const { apocalypsePercent } = deriveProgress({
    startTime: cycle.start_time,
    endTime: cycle.end_time,
    durationMs: cycle.duration_ms,
    now: nowDate
  });
  const amplitude = getApocalypseVolatility(apocalypsePercent);

  const collapsedCoinIds = await collapseScheduleService.getCollapsedCoinIds();

  // SIM-08: the persisted Wave 1/2 pricing context feeding the unified
  // signal path. Internal only — never serialised publicly.
  const pricingContext = await loadPricingContext(db, cycle);
  const cycleDurationMs = Number(cycle.duration_ms);

  const { rows: coins } = await db.query(
    `SELECT coin_id, name, symbol, cycle_baseline_price
     FROM coins
     WHERE retired = FALSE
     ORDER BY coin_id ASC`
  );

  const roundStartMs = new Date(cycle.start_time).getTime();
  const signals = coins.map((coin) => {
    if (collapsedCoinIds.has(coin.coin_id)) {
      return {
        coinId: coin.coin_id,
        name: coin.name,
        symbol: coin.symbol,
        archetype: marketDomain.resolveArchetypeId(coin.coin_id),
        currentPrice: 0,
        recentChangePct: null,
        phase: 'DEAD',
        momentum: 'FLAT',
        typicalCycleMinutes: null,
        typicalSwingPct: null,
        collapseRisk: collapseRiskDomain.DEAD_RISK_MARKER,
        dead: true
      };
    }
    // SIM-08: the shared unified live-coin signal — identical to what the
    // bot decision layer publishes for the same instant.
    const signal = computeLiveCoinSignal({
      seed: cycle.seed,
      coin,
      nowMs,
      amplitude,
      apocalypsePercent,
      roundStartMs,
      cycleDurationMs,
      pricingContext
    });
    return {
      name: coin.name,
      symbol: coin.symbol,
      ...signal,
      dead: false
    };
  });

  return {
    apocalypseId: cycle.apocalypse_id,
    apocalypsePercent,
    serverTime: nowDate.toISOString(),
    coins: signals
  };
}

module.exports = { getPublicMarketSignals, computeLiveCoinSignal };
