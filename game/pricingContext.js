// Crypto Chaos gameplay overhaul SIM-08: the live pricing-context adapter.
//
// The unified price engine (game/priceEngine.js) is pure: it accepts the
// hidden lifecycle state, the current market-phase modifier, the per-coin
// net coin-event modifier and the per-coin bounded trading pressure as
// INPUTS. This adapter is the smallest safe read side that supplies them
// from the already-persisted authorities — apocalypse_market_state
// (migration 021), apocalypse_market_phases and apocalypse_coin_events
// (migration 020), and the Core 4 round ledger apocalypse_transactions
// (SIM-11 pressure, derived from durable rows only) — after the caller has
// reconciled the Core 1 cycle (reconcileCycle extends the Wave 1/2
// coverages to `now` inside its advisory-locked transaction). It invents
// no parallel state store, holds nothing in memory between calls, and
// never writes.
//
// Consumers: models/market-simulator.js (the single live price writer) and
// game/marketSignalsService.js (the public coarse-signal read side). The
// loaded values are INTERNAL: callers must never serialise the lifecycle
// state, modifiers, pressure values or phase internals into public
// responses.
//
// This module never requires gameCycleService (no circular imports).

const marketStateEngine = require('./marketStateEngine');
const marketPhaseEngine = require('./marketPhaseEngine');
const coinEventEngine = require('./coinEventEngine');
const marketDomain = require('./marketDomain');
const tradePressureDomain = require('./tradePressureDomain');
const { resolveSimulationConfig } = require('./simulationConfig');

// Load the persisted pricing context for a freshly reconciled cycle.
// `queryable` is any pool/client (read-only queries). Options:
//   nowMs  — the instant the caller is pricing at (default: the real
//            clock). The round-ledger window is loaded to cover every
//            instant the caller may evaluate: [nowMs - public lookback,
//            nowMs], each reaching back one fixed pressure window, so tick
//            and lookback pressure evaluations share one loaded row set.
// Returns:
//   lifecycleState          — the cycle's current hidden lifecycle state.
//   phaseModifierAt(atMs)   — the signed modifier of the primary market
//                             phase covering atMs (0 when no row covers it).
//   eventModifierFor(coinId, atMs) — the stack-capped net modifier of the
//                             coin's events active at atMs.
//   pressureModifierFor(coinId, atMs) — the bounded decayed buy-minus-sell
//                             trading pressure of the coin's persisted
//                             round-ledger trades at atMs (SIM-11).
// All closures are pure over the loaded persisted rows, so a batch can
// evaluate any instant (current or lookback) consistently.
//
// Fail-safe: a missing market-state row is only possible if the cycle
// predates Wave 2 reconciliation (impossible after reconcileCycle, which
// creates it); default to GROWTH rather than abort the batch.
async function loadPricingContext(queryable, cycle, { config = resolveSimulationConfig(), nowMs = Date.now() } = {}) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error(`pricing context nowMs must be a finite number; received ${String(nowMs)}`);
  }
  // SIM-11: the round-ledger window covering every pressure evaluation the
  // caller can make (current instant and the public-signal lookback behind
  // it), each reaching back one fixed pressure window.
  const windowStartMs = nowMs - marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS - tradePressureDomain.pressureWindowMs(config);

  const [marketState, phases, events, transactions] = await Promise.all([
    marketStateEngine.getCycleMarketState(queryable, cycle.cycle_id),
    marketPhaseEngine.getCycleMarketPhases(queryable, cycle.cycle_id),
    coinEventEngine.getCycleCoinEvents(queryable, cycle.cycle_id),
    queryable.query(
      `SELECT coin_id, type, total_amount, created_at
       FROM apocalypse_transactions
       WHERE cycle_id = $1 AND created_at >= $2
       ORDER BY created_at`,
      [cycle.cycle_id, new Date(windowStartMs).toISOString()]
    ).then((result) => result.rows)
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

  const txsByCoin = new Map();
  for (const tx of transactions) {
    const entry = {
      type: tx.type,
      notional: parseFloat(tx.total_amount),
      atMs: new Date(tx.created_at).getTime()
    };
    const list = txsByCoin.get(tx.coin_id);
    if (list) {
      list.push(entry);
    } else {
      txsByCoin.set(tx.coin_id, [entry]);
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
    },
    pressureModifierFor(coinId, atMs) {
      return tradePressureDomain.computeTradePressure({
        transactions: txsByCoin.get(coinId) || [],
        nowMs: atMs,
        config
      }).pressureModifier;
    }
  };
}

module.exports = { loadPricingContext };
