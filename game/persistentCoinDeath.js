// Persistent-market Stage 9 (S9-01): authoritative living → DEAD decision.
//
// Death is a deliberate, named state transition — NEVER an implicit side
// effect of the living positive safety floor (§27 / persistentPricing). A
// living coin may sit on the floor indefinitely; only when the existing
// condition-driven persistent collapse-risk SCORE crosses the configured
// death-risk threshold does this module decide that the coin must die.
//
// Contract:
//   * Pure decision: decideAuthoritativePersistentDeath reads only public
//     observables + the committed/advanced condition + validated config.
//     It never writes a database row and never inspects the living floor.
//   * Explicit application: applyAuthoritativePersistentDeath is the only
//     writer-side path that sets price to exactly £0 AND records DEAD via
//     marketCoinState.recordDeath (the sole status writer). History,
//     events and trades are preserved; coin_id is never reused/resurrected.
//   * Effect-idempotent: apply gates on the locked market_coin_state row
//     BEFORE any price/history/checkpoint/accumulator write. Exact replay
//     at the same diedAt is a successful no-op (alreadyDead). A different
//     death instant fails loudly with zero mutations. First death stays
//     on the caller's transaction.

const marketDomain = require('./marketDomain');
const collapseRiskDomain = require('./collapseRiskDomain');
const coinStateModel = require('../models/marketCoinState.model');
const pricingCheckpointModel = require('../models/pricingCheckpoint.model');
const { resolveSimulationConfig } = require('./simulationConfig');

function coarseMomentum(recentChangePct) {
  if (typeof recentChangePct !== 'number' || !Number.isFinite(recentChangePct)) {
    return 'FLAT';
  }
  if (recentChangePct > marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT) return 'UP';
  if (recentChangePct < -marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT) return 'DOWN';
  return 'FLAT';
}

function decideAuthoritativePersistentDeath({
  seed,
  coinId,
  archetypeId,
  condition,
  phase,
  momentum = null,
  recentChangePct = null,
  nowMs,
  config = resolveSimulationConfig()
} = {}) {
  if (!config || !config.persistent || !config.persistent.death) {
    throw new Error('decideAuthoritativePersistentDeath requires a validated persistent.death config section');
  }
  const threshold = config.persistent.death.riskThreshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new Error(`decideAuthoritativePersistentDeath riskThreshold must be finite; received ${String(threshold)}`);
  }

  const resolvedMomentum = momentum == null ? coarseMomentum(recentChangePct) : momentum;
  const riskScore = collapseRiskDomain.getPersistentCollapseRiskScore({
    seed,
    coinId,
    archetypeId,
    condition,
    phase,
    momentum: resolvedMomentum,
    recentChangePct,
    nowMs
  });

  const shouldDie = riskScore >= threshold;
  return {
    shouldDie,
    riskScore,
    threshold,
    reason: shouldDie ? 'PERSISTENT_COLLAPSE_RISK_THRESHOLD' : null
  };
}

async function applyAuthoritativePersistentDeath(client, {
  coinId,
  worldId,
  diedAt,
  nextState,
  checkpoint = null,
  batchInstant
}) {
  const coinIdNum = Number(coinId);
  if (!Number.isInteger(coinIdNum) || coinIdNum <= 0) {
    throw new Error(`applyAuthoritativePersistentDeath requires a positive integer coinId; received ${String(coinId)}`);
  }
  const worldIdNum = Number(worldId);
  if (!Number.isInteger(worldIdNum) || worldIdNum <= 0) {
    throw new Error(`applyAuthoritativePersistentDeath requires a positive integer worldId; received ${String(worldId)}`);
  }
  const diedAtDate = new Date(diedAt);
  if (!Number.isFinite(diedAtDate.getTime())) {
    throw new Error(`applyAuthoritativePersistentDeath requires a valid death instant; received ${String(diedAt)}`);
  }
  if (typeof batchInstant !== 'string' || batchInstant.length === 0) {
    throw new Error('applyAuthoritativePersistentDeath requires the batch instant ISO string for price_history provenance');
  }

  // Authoritative gate FIRST: lock the coin-state row and decide
  // ALIVE→DEAD / exact-replay / moved-death before any side effect.
  const { rows: existing } = await client.query(
    `SELECT status, died_at
       FROM market_coin_state
      WHERE coin_id = $1 AND world_id = $2
      FOR UPDATE`,
    [coinIdNum, worldIdNum]
  );
  if (existing.length === 0) {
    throw new Error(`applyAuthoritativePersistentDeath: no state row for coin ${coinIdNum} in world ${worldIdNum}`);
  }
  const recordedMs = existing[0].died_at ? new Date(existing[0].died_at).getTime() : null;
  if (existing[0].status === 'DEAD') {
    if (recordedMs === diedAtDate.getTime()) {
      return {
        died: false,
        alreadyDead: true,
        price: 0,
        reason: 'PERSISTENT_COLLAPSE_RISK_THRESHOLD'
      };
    }
    throw new Error(`applyAuthoritativePersistentDeath: coin ${coinIdNum} is already DEAD at a different instant (${existing[0].died_at}); death is permanent and cannot move`);
  }
  if (existing[0].status !== 'ALIVE') {
    throw new Error(`applyAuthoritativePersistentDeath: coin ${coinIdNum} has unexpected status ${JSON.stringify(existing[0].status)}`);
  }

  // First valid ALIVE → DEAD. All writes ride the caller's transaction.
  await client.query(
    'UPDATE coins SET current_price = $1 WHERE coin_id = $2',
    [0, coinIdNum]
  );
  await client.query(
    `INSERT INTO price_history (coin_id, cycle_id, price, created_at, source)
     VALUES ($1, NULL, $2, $3, 'MARKET_TICK')`,
    [coinIdNum, 0, batchInstant]
  );

  if (checkpoint) {
    await pricingCheckpointModel.upsertCheckpoint(client, checkpoint);
  }

  if (nextState) {
    await coinStateModel.upsertCoinState(client, {
      ...nextState,
      status: 'ALIVE',
      diedAt: null
    });
  }

  const result = await coinStateModel.recordDeath(client, {
    coinId: coinIdNum,
    worldId: worldIdNum,
    diedAt: diedAtDate
  });

  return {
    died: result.died,
    alreadyDead: result.alreadyDead,
    price: 0,
    reason: 'PERSISTENT_COLLAPSE_RISK_THRESHOLD'
  };
}

module.exports = {
  coarseMomentum,
  decideAuthoritativePersistentDeath,
  applyAuthoritativePersistentDeath
};
