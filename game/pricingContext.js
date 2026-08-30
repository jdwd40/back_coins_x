// Crypto Chaos gameplay overhaul SIM-08: the live pricing-context adapter.
//
// The unified price engine (game/priceEngine.js) is pure: it accepts the
// hidden lifecycle state, the current market-phase modifier and the per-coin
// net coin-event modifier as INPUTS. This adapter is the smallest safe read
// side that supplies them from the already-persisted Wave 1/2 authorities —
// apocalypse_market_state (migration 021), apocalypse_market_phases and
// apocalypse_coin_events (migration 020) — after the caller has reconciled
// the Core 1 cycle (reconcileCycle extends all three coverages to `now`
// inside its advisory-locked transaction). It invents no parallel state
// store, holds nothing in memory between calls, and never writes.
//
// Consumers: models/market-simulator.js (the single live price writer) and
// game/marketSignalsService.js (the public coarse-signal read side). The
// loaded values are INTERNAL: callers must never serialise the lifecycle
// state, modifiers or phase internals into public responses.
//
// This module never requires gameCycleService (no circular imports).

const marketStateEngine = require('./marketStateEngine');
const marketPhaseEngine = require('./marketPhaseEngine');
const coinEventEngine = require('./coinEventEngine');
const { resolveSimulationConfig } = require('./simulationConfig');

// Load the persisted pricing context for a freshly reconciled cycle.
// `queryable` is any pool/client (read-only queries). Returns:
//   lifecycleState          — the cycle's current hidden lifecycle state.
//   phaseModifierAt(atMs)   — the signed modifier of the primary market
//                             phase covering atMs (0 when no row covers it).
//   eventModifierFor(coinId, atMs) — the stack-capped net modifier of the
//                             coin's events active at atMs.
// Both closures are pure over the loaded persisted rows, so a batch can
// evaluate any instant (current or lookback) consistently.
//
// Fail-safe: a missing market-state row is only possible if the cycle
// predates Wave 2 reconciliation (impossible after reconcileCycle, which
// creates it); default to GROWTH rather than abort the batch.
async function loadPricingContext(queryable, cycle, { config = resolveSimulationConfig() } = {}) {
  const [marketState, phases, events] = await Promise.all([
    marketStateEngine.getCycleMarketState(queryable, cycle.cycle_id),
    marketPhaseEngine.getCycleMarketPhases(queryable, cycle.cycle_id),
    coinEventEngine.getCycleCoinEvents(queryable, cycle.cycle_id)
  ]);

  const eventsByCoin = new Map();
  for (const event of events) {
    const list = eventsByCoin.get(event.coin_id);
    if (list) {
      list.push(event);
    } else {
      eventsByCoin.set(event.coin_id, [event]);
    }
  }

  return {
    lifecycleState: marketState ? marketState.lifecycle_state : 'GROWTH',
    phaseModifierAt(atMs) {
      const phase = marketPhaseEngine.getPhaseAt(phases, atMs);
      return phase ? parseFloat(phase.modifier) : 0;
    },
    eventModifierFor(coinId, atMs) {
      return coinEventEngine.netEventModifier(eventsByCoin.get(coinId) || [], atMs, config);
    }
  };
}

module.exports = { loadPricingContext };
