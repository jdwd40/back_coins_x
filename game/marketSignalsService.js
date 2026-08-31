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
//
// SIM-15 (Wave 5): the payload additionally explains the live simulation —
// the current market phase (public id/name, expiry) and, per live coin, up
// to five active coin events (public name, direction, expiry) — via the
// dedicated public DTOs below. Hidden internals (lifecycle state, phase
// sequence/modifier, event strength/modifier/sequence, start times, seeds,
// collapse probabilities) are redacted by construction: the DTOs are built
// field-by-field from an explicit allowlist, never by spreading rows.

const db = require('../db/connection');
const marketDomain = require('./marketDomain');
const collapseRiskDomain = require('./collapseRiskDomain');
const { getApocalypseVolatility } = require('./apocalypseVolatility');
const dynamicCollapseService = require('./dynamicCollapseService');
const priceEngine = require('./priceEngine');
const { loadPricingContext } = require('./pricingContext');
const marketPhaseEngine = require('./marketPhaseEngine');
const coinEventEngine = require('./coinEventEngine');

// SIM-15: the public display names of the market phases. The persisted
// engine rows store the config id (GOLDEN_AGE, ...); the public payload
// carries that id plus this friendly name. No public description/flavour
// text is defined anywhere in the game design yet, so none is exposed.
const PUBLIC_MARKET_PHASE_NAMES = Object.freeze({
  GOLDEN_AGE: 'Golden Age',
  BOOM: 'Boom',
  BULL: 'Bull',
  BEAR: 'Bear',
  BUST: 'Bust',
  RECESSION: 'Recession'
});

// SIM-15: at most this many active coin events are exposed per coin
// (matches the engine's simultaneous-activity cap).
const PUBLIC_MAX_EVENTS_PER_COIN = 5;

// The public DTO for the current market phase. Built field-by-field from
// the persisted engine row: the id, the public display name and the expiry
// timestamp ONLY. The hidden lifecycle state, phase sequence, modifier,
// start time and created timestamps never survive this shape.
function toPublicMarketPhase(phaseRow) {
  if (!phaseRow) return null;
  return {
    id: phaseRow.phase,
    name: PUBLIC_MARKET_PHASE_NAMES[phaseRow.phase] || phaseRow.phase,
    endsAt: new Date(phaseRow.ends_at).toISOString()
  };
}

// The public DTO for one active coin event. Built field-by-field: public
// name, direction and expiry timestamp ONLY. The event id/sequence, cycle
// id, strength category, signed modifier and start time never survive this
// shape.
function toPublicCoinEvent(eventRow) {
  return {
    name: eventRow.name,
    direction: eventRow.direction,
    endsAt: new Date(eventRow.ends_at).toISOString()
  };
}

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
    eventModifier: pricingContext.eventModifierFor(coinId, nowMs),
    pressureModifier: pricingContext.pressureModifierFor(coinId, nowMs)
  });
  const pastPrice = priceEngine.unifiedPriceAt({
    ...shared,
    nowMs: lookbackMs,
    cycleProgress: cycleProgressAt(lookbackMs),
    phaseModifier: pricingContext.phaseModifierAt(lookbackMs),
    eventModifier: pricingContext.eventModifierFor(coinId, lookbackMs),
    pressureModifier: pricingContext.pressureModifierFor(coinId, lookbackMs)
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

  const collapsedCoinIds = await dynamicCollapseService.getCollapsedCoinIds();

  // SIM-08/SIM-11: the persisted Wave 1/2/4 pricing context feeding the
  // unified signal path. Internal only — never serialised publicly.
  const pricingContext = await loadPricingContext(db, cycle, { nowMs });
  const cycleDurationMs = Number(cycle.duration_ms);

  // SIM-15: the persisted player-facing read — the current market phase
  // and the active coin events, observed AFTER the reconcile above extended
  // their coverages to `now`. The raw rows are internal; only the public
  // DTO fields (toPublicMarketPhase / toPublicCoinEvent) reach the payload.
  const [currentPhaseRow, activeEventRows] = await Promise.all([
    marketPhaseEngine.getCurrentMarketPhase(db, cycle.cycle_id, nowDate),
    coinEventEngine.getActiveCoinEvents(db, cycle.cycle_id, nowDate)
  ]);
  const publicEventsByCoin = new Map();
  for (const eventRow of activeEventRows) {
    const list = publicEventsByCoin.get(eventRow.coin_id) || [];
    list.push(eventRow);
    publicEventsByCoin.set(eventRow.coin_id, list);
  }

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
        dead: true,
        // SIM-15: a collapsed coin's DEAD contract is unchanged — its
        // public event list is always empty.
        events: []
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
      dead: false,
      // SIM-15: up to five of the coin's currently active events, public
      // fields only (name, direction, endsAt), chronological order.
      events: (publicEventsByCoin.get(coin.coin_id) || [])
        .slice(0, PUBLIC_MAX_EVENTS_PER_COIN)
        .map(toPublicCoinEvent)
    };
  });

  return {
    apocalypseId: cycle.apocalypse_id,
    apocalypsePercent,
    serverTime: nowDate.toISOString(),
    // SIM-15: the current public market phase (id, display name, expiry),
    // or null when no persisted phase covers `now`. The hidden lifecycle
    // state, modifier and chain position are redacted by the DTO.
    marketPhase: toPublicMarketPhase(currentPhaseRow),
    coins: signals
  };
}

module.exports = { getPublicMarketSignals, computeLiveCoinSignal };
