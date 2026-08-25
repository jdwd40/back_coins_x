// Crypto Chaos V2-2: shared Power + position-limit domain.
//
// This module is the SINGLE authoritative implementation of the Power
// resource rules. It is pure (no database, no real clock, no Math.random):
// every function takes its inputs explicitly, so the live round-trade
// service (game/gameRoundService.js) and the headless simulator
// (simulation/) execute IDENTICAL logic — the same way game/marketDomain.js
// is shared for V2-1 pricing. Tunables come from game/gameConstants.js via
// the validated resolvers; callers may also inject explicit overrides
// (the simulator uses this for tuning studies).
//
// Power rules (see GAMEPLAY_V2_NIGHT_PLAN.md V2-2):
//   * BUY costs Power: 1 + floor(buyTotal / divisor) — a flat per-order
//     charge plus linear deployment cost, so transaction fragmentation can
//     never reduce the price of deploying the same money. SELL costs zero
//     Power and is NEVER blocked by Power.
//   * Power regenerates lazily from REAL elapsed time: +1 per regen
//     interval, clamped to [0, max]. There is no per-participant timer; the
//     stored (power, power_updated_at) pair is reconciled against the
//     authoritative now at every read/spend.
//   * Power persists across restart, inactivity and apocalypse rollover:
//     the stored pair is carried verbatim from a user's previous participant
//     row to the next round's row (migration 018 columns); elapsed time does
//     the rest through reconciliation. New players start at max Power.
//   * Future or invalid timestamps NEVER create Power.
//   * At most GAME_MAX_OPEN_POSITIONS distinct OPEN LIVE positions: a live
//     position is a holding with quantity > 0 whose coin has not collapsed
//     in the participant's cycle. Collapsed and zero-quantity holdings are
//     history and never consume a slot.

const {
  resolveGamePowerMax,
  resolveGamePowerRegenMsPerPoint,
  resolveGamePowerBuyCostDivisor,
  resolveGameMaxOpenPositions
} = require('./gameConstants');

// The resolved Power configuration. Explicit option fields win over env
// overrides, which win over the game-design defaults. All fields are
// validated by the gameConstants resolvers.
function resolvePowerConfig({ maxPower, regenMsPerPoint, buyCostDivisor, maxOpenPositions } = {}) {
  return {
    maxPower: maxPower === undefined ? resolveGamePowerMax() : resolveGamePowerMax(maxPower),
    regenMsPerPoint: regenMsPerPoint === undefined ? resolveGamePowerRegenMsPerPoint() : resolveGamePowerRegenMsPerPoint(regenMsPerPoint),
    buyCostDivisor: buyCostDivisor === undefined ? resolveGamePowerBuyCostDivisor() : resolveGamePowerBuyCostDivisor(buyCostDivisor),
    maxOpenPositions: maxOpenPositions === undefined ? resolveGameMaxOpenPositions() : resolveGameMaxOpenPositions(maxOpenPositions)
  };
}

function assertFiniteMoney(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number; received ${String(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Buy cost: 1 + floor(total / divisor).
//
// A flat 1-Power order charge plus one point per full £125 deployed. With
// the default divisor this lands near the plan's initial targets:
//   £250 -> 3, £500 -> 5, £1,000 -> 9, £2,500 -> 21
// (the plan's "~2/~4/~8/~20" concept, with the +1 order charge added).
//
// Why not plain max(1, ceil(total/d))? A pure ceiling lets an ALIGNED split
// cost exactly the same as the single buy (£3,000 -> 24 equals two £1,500
// buys at 12 + 12), and smaller fragments deploy more smoothly against a
// tight Power budget — fragmentation was strictly BETTER under scarcity in
// the multi-round study. The flat per-order charge makes every fragment pay
// for its own order, so splitting can NEVER reduce cost and typically
// increases it:
//   fragments: sum(1 + floor(xi/d)) = n + sum(floor(xi/d))
//   single:    1 + floor(sum(xi)/d)
//   and n + sum(floor(xi/d)) >= 1 + floor(sum(xi)/d) always, with strict
//   inequality whenever any fragment boundary drops a remainder (the normal
//   case). A £0.01 micro-buy still costs 1 Power, so buy-spam is bounded by
//   the regen rate.
// ---------------------------------------------------------------------------
function buyPowerCost(totalAmount, { buyCostDivisor } = {}) {
  assertFiniteMoney('buy total', totalAmount);
  if (!(totalAmount > 0)) {
    throw new Error(`buy total must be positive; received ${totalAmount}`);
  }
  const divisor = buyCostDivisor === undefined ? resolveGamePowerBuyCostDivisor() : resolveGamePowerBuyCostDivisor(buyCostDivisor);
  return 1 + Math.floor(totalAmount / divisor);
}

// ---------------------------------------------------------------------------
// Lazy reconciliation: effective Power at `nowMs` from the stored pair
// (storedPower, updatedAtMs).
//
//   * elapsed whole regen intervals add one point each;
//   * the result is clamped to [0, maxPower];
//   * a future `nowMs` (before updatedAtMs) adds NOTHING — clock skew and
//     client-supplied futures can never mint Power;
//   * non-finite timestamps are treated as "no elapsed time", never an
//     error that could be weaponised and never a source of Power;
//   * a non-finite/negative stored value is treated as 0 (never negative
//     effective Power, never NaN leaking into trade arithmetic).
//
// Returns { power, nextPointAtMs }: the integer effective Power and the
// epoch ms at which the NEXT point lands (null when already full). The
// caller that spends Power persists (power - cost, nowMs) as the new stored
// pair; read-only callers persist nothing.
// ---------------------------------------------------------------------------
function reconcilePower({ storedPower, updatedAtMs, nowMs, maxPower, regenMsPerPoint } = {}) {
  const max = maxPower === undefined ? resolveGamePowerMax() : resolveGamePowerMax(maxPower);
  const regenMs = regenMsPerPoint === undefined ? resolveGamePowerRegenMsPerPoint() : resolveGamePowerRegenMsPerPoint(regenMsPerPoint);

  let stored = typeof storedPower === 'number' && Number.isFinite(storedPower) ? Math.trunc(storedPower) : 0;
  if (stored < 0) stored = 0;
  if (stored > max) stored = max;

  const from = Number.isFinite(updatedAtMs) ? updatedAtMs : null;
  const now = Number.isFinite(nowMs) ? nowMs : null;

  let regenerated = 0;
  if (from !== null && now !== null && now > from) {
    regenerated = Math.floor((now - from) / regenMs);
  }

  const power = Math.min(max, stored + regenerated);
  let nextPointAtMs = null;
  if (power < max && from !== null && now !== null) {
    const elapsed = Math.max(0, now - from);
    nextPointAtMs = from + (Math.floor(elapsed / regenMs) + 1) * regenMs;
  }
  return { power, nextPointAtMs };
}

// Convenience for spend paths: validate that effective Power covers `cost`
// and return the post-spend stored pair. Throws nothing — the caller
// decides the domain error shape; returns null when unaffordable.
//
// The returned updatedAtMs PRESERVES the sub-interval regen phase: the
// stored pair becomes (power - cost, lastWholeIntervalAt), so a player who
// buys repeatedly is not punished by losing their partial progress toward
// the next point. When effective Power was clamped at max, surplus regen
// time is already accounted and the stamp is simply nowMs. When the stored
// timestamp is in the future (clock skew), the stamp is kept in the future
// — regeneration stays paused until real time catches up, never creating
// Power.
function spendPower({ storedPower, updatedAtMs, nowMs, cost, maxPower, regenMsPerPoint } = {}) {
  if (!Number.isInteger(cost) || cost < 0) {
    throw new Error(`Power cost must be a non-negative integer; received ${String(cost)}`);
  }
  const max = maxPower === undefined ? resolveGamePowerMax() : resolveGamePowerMax(maxPower);
  const regenMs = regenMsPerPoint === undefined ? resolveGamePowerRegenMsPerPoint() : resolveGamePowerRegenMsPerPoint(regenMsPerPoint);
  const { power } = reconcilePower({ storedPower, updatedAtMs, nowMs, maxPower: max, regenMsPerPoint: regenMs });
  if (power < cost) return null;

  const from = Number.isFinite(updatedAtMs) ? updatedAtMs : null;
  const now = Number.isFinite(nowMs) ? nowMs : null;
  let stamp = now;
  if (from !== null && now !== null && now > from && power < max) {
    stamp = from + Math.floor((now - from) / regenMs) * regenMs;
  } else if (from !== null && now !== null && now <= from) {
    stamp = from; // stored future timestamp: keep it; regen stays paused
  }
  if (stamp === null || stamp === undefined) stamp = from !== null ? from : 0;
  return { power: power - cost, updatedAtMs: stamp };
}

// ---------------------------------------------------------------------------
// Position limit. The rule in one place: a holding counts as an OPEN LIVE
// position exactly when quantity > 0 AND its coin has not collapsed in the
// holding's cycle. Opening a NEW distinct live position is allowed only
// while fewer than maxOpenPositions are open; adding to an existing live
// position (same coin) is always allowed.
//
// `holdings` is any iterable of { coinId, quantity, dead } — dead meaning
// the coin has an executed collapse in the holding's cycle. The simulator
// uses this exact predicate; the live service enforces the identical rule in
// SQL inside the advisory-locked buy transaction (kept in lockstep by
// __tests__/v2-power-trades.test.js).
// ---------------------------------------------------------------------------
function livePositionCoinIds(holdings) {
  const ids = new Set();
  for (const holding of holdings) {
    if (!holding) continue;
    if (!(holding.quantity > 0)) continue;
    if (holding.dead) continue;
    ids.add(holding.coinId);
  }
  return ids;
}

// May the participant buy `coinId` under the position limit? Returns
// { allowed, reason, openPositions } — reason is 'within-limit' when adding
// to an existing live position or opening below the cap, 'position-limit'
// when a NEW position would exceed the cap. Accepts either `holdings` (see
// above) or a precomputed `liveCoinIds` iterable (the live service computes
// the identical set in SQL and passes it here, so the acceptance rule itself
// is never duplicated).
function evaluatePositionLimit({ holdings, liveCoinIds, coinId, maxOpenPositions } = {}) {
  const max = maxOpenPositions === undefined ? resolveGameMaxOpenPositions() : resolveGameMaxOpenPositions(maxOpenPositions);
  const liveIds = liveCoinIds ? new Set(liveCoinIds) : livePositionCoinIds(holdings || []);
  if (liveIds.has(coinId)) {
    return { allowed: true, reason: 'within-limit', openPositions: liveIds.size };
  }
  if (liveIds.size >= max) {
    return { allowed: false, reason: 'position-limit', openPositions: liveIds.size };
  }
  return { allowed: true, reason: 'within-limit', openPositions: liveIds.size };
}

module.exports = {
  resolvePowerConfig,
  buyPowerCost,
  reconcilePower,
  spendPower,
  livePositionCoinIds,
  evaluatePositionLimit
};
