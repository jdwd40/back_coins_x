// Crypto Chaos gameplay overhaul SIM-11: bounded, decaying player/bot
// trading pressure.
//
// Recent buy notional contributes bounded temporary upward pressure; recent
// sell notional contributes bounded temporary downward pressure
// (gameplay_changes.md §14-15, gameplay_build_plan.md Stage 9). The pressure
// for a coin at an instant is derived PURELY from the cycle's persisted
// Core 4 round ledger (apocalypse_transactions) — the same durable ledger
// humans and bots already write through the shared trade domain ops — so:
//   * no new pressure state needs persisting: restarts recompute identical
//     pressure from the ledger alone (no process-local maps anywhere);
//   * bot trades and human trades feed the exact same path — there is no
//     private bot price shortcut;
//   * portfolio/ledger semantics are never touched: this module only READS
//     the ledger shape (coin, side, notional, timestamp) and never mutates
//     financial history to fake pressure.
//
// Anti transaction-spam by construction (config tradingPressure):
//   * volume normalisation — a trade's raw influence saturates at
//     volumeNormalizationAmount of notional;
//   * a per-trade cap — one transaction can never contribute more than
//     maxPerTradeInfluence, however large;
//   * exponential decay — contributions halve every decayHalfLifeMs;
//   * bounded totals — each side's summed decayed influence is hard-clamped
//     to maxBuyPressureModifier / maxSellPressureModifier before it can
//     reach the price path.
// One small trade therefore has only a small bounded influence, and no
// burst of trades can move the market by more than the configured bounds.
//
// Determinism contract: no Math.random(), no wall-clock reads, no database
// access, no process globals. The evaluation window rule is FIXED (the last
// PRESSURE_WINDOW_HALF_LIVES half-lives before the evaluated instant), so a
// caller loading that window once can evaluate any covered instant — live
// tick and lookback alike — with identical results in every process.
//
// Server-authoritative only: pressure values are computed server-side from
// persisted rows; clients can never supply pressure values or prices.
//
// This module never requires gameCycleService or any database module.

const { resolveSimulationConfig } = require('./simulationConfig');

// The fixed evaluation-window rule: a transaction contributes to the
// pressure at an instant only when it executed within the last
// PRESSURE_WINDOW_HALF_LIVES half-lives. 12 half-lives leaves each
// remaining contribution at 2^-12 (~0.024%) of its (already tiny) capped
// size — far below the 4dp persisted price precision — while keeping the
// loaded row set bounded for any cycle length (build plan: pressure must be
// derived safely AND efficiently). A fixed game-design constant, like the
// risk jitter bucket in collapseRiskDomain — deliberately not configurable.
const PRESSURE_WINDOW_HALF_LIVES = 12;

function assertFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`trade pressure ${name} must be a finite number; received ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
}

// The window (ms) a pressure evaluation reaches back: a fixed multiple of
// the configured decay half-life.
function pressureWindowMs(config = resolveSimulationConfig()) {
  return PRESSURE_WINDOW_HALF_LIVES * config.tradingPressure.decayHalfLifeMs;
}

// A single trade's raw influence before decay: the notional normalised
// against volumeNormalizationAmount, saturated at 1, scaled by the
// per-trade cap. A £0 (or negative, which the ledger never contains) trade
// contributes nothing; a trade at or above the normalisation amount
// contributes exactly maxPerTradeInfluence and never more.
function tradeInfluence(notional, config = resolveSimulationConfig()) {
  assertFiniteNumber('notional', notional);
  const tp = config.tradingPressure;
  if (notional <= 0) return 0;
  const normalised = Math.min(1, notional / tp.volumeNormalizationAmount);
  return normalised * tp.maxPerTradeInfluence;
}

// Exponential decay of a contribution `ageMs` after its trade: halves every
// decayHalfLifeMs. ageMs must be non-negative (future trades never
// contribute — callers filter them out).
function decayWeight(ageMs, config = resolveSimulationConfig()) {
  assertFiniteNumber('ageMs', ageMs);
  if (ageMs < 0) {
    throw new Error(`trade pressure ageMs must be non-negative; received ${ageMs}`);
  }
  return Math.pow(2, -ageMs / config.tradingPressure.decayHalfLifeMs);
}

// The bounded pressure for ONE coin at one instant, from that coin's
// persisted round-ledger trades. Each trade is
//   { type: 'BUY' | 'SELL', notional: <pounds>, atMs: <epoch ms> }
// (the live adapter maps apocalypse_transactions rows: total_amount and
// created_at). Only trades inside the fixed window ending at nowMs
// contribute. Returns:
//   buyPressure      — decayed buy-side influence, clamped to
//                      maxBuyPressureModifier;
//   sellPressure     — decayed sell-side influence, clamped to
//                      maxSellPressureModifier;
//   pressureModifier — buyPressure - sellPressure, the signed contribution
//                      the unified price engine composes into the normal
//                      modifier (itself hard-clamped downstream).
// All three are exact deterministic functions of the inputs.
function computeTradePressure({ transactions, nowMs, config = resolveSimulationConfig() }) {
  if (!Array.isArray(transactions)) {
    throw new Error('trade pressure requires a transactions array');
  }
  assertFiniteNumber('nowMs', nowMs);
  const tp = config.tradingPressure;
  const windowMs = pressureWindowMs(config);

  let buySum = 0;
  let sellSum = 0;
  for (const tx of transactions) {
    if (!tx || typeof tx !== 'object') {
      throw new Error('trade pressure transactions must be objects');
    }
    if (tx.type !== 'BUY' && tx.type !== 'SELL') {
      throw new Error(`trade pressure transaction type must be BUY or SELL; received ${JSON.stringify(tx.type)}`);
    }
    assertFiniteNumber('transaction notional', tx.notional);
    assertFiniteNumber('transaction atMs', tx.atMs);
    const ageMs = nowMs - tx.atMs;
    if (ageMs < 0 || ageMs > windowMs) continue; // future or fully decayed
    const contribution = tradeInfluence(tx.notional, config) * decayWeight(ageMs, config);
    if (tx.type === 'BUY') buySum += contribution;
    else sellSum += contribution;
  }

  const buyPressure = Math.min(tp.maxBuyPressureModifier, buySum);
  const sellPressure = Math.min(tp.maxSellPressureModifier, sellSum);
  return {
    buyPressure,
    sellPressure,
    pressureModifier: buyPressure - sellPressure
  };
}

module.exports = {
  PRESSURE_WINDOW_HALF_LIVES,
  pressureWindowMs,
  tradeInfluence,
  decayWeight,
  computeTradePressure
};
