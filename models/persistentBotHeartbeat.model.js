// Issue #56: the durable cross-process persistent bot worker heartbeat
// (migration 033, one row per world).
//
// Writers (the bot tick, on its own bounded session) record distinct
// facts — an attempt, a claim, a completed success, a failure — so a
// claimed tick can never be mistaken for a successful one. The public read
// (GET /api/persistent/runtime) projects an allowlisted DTO only: the
// outcome is a fixed vocabulary and no raw error text, seed, strategy or
// configuration internal is ever stored or returned.

const HEARTBEAT_OUTCOMES = Object.freeze(['SUCCESS', 'SIGNALS_FAILED', 'TIMEOUT', 'ERROR']);

function assertWorldId(worldId) {
  if (!Number.isInteger(worldId) || worldId <= 0) {
    throw new Error(`persistent bot heartbeat requires a positive integer worldId; received ${String(worldId)}`);
  }
}

function assertTickId(tickId) {
  if (!Number.isInteger(tickId) || tickId < 0) {
    throw new Error(`persistent bot heartbeat requires a non-negative integer tickId; received ${String(tickId)}`);
  }
}

function assertCount(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`persistent bot heartbeat ${name} must be a non-negative integer; received ${String(value)}`);
  }
}

// A worker holding the run lock reached the tick (whether or not it goes on
// to claim it).
async function recordAttempt(queryable, worldId) {
  assertWorldId(worldId);
  await queryable.query(
    `INSERT INTO persistent_bot_heartbeat (world_id, last_attempt_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (world_id) DO UPDATE
       SET last_attempt_at = now(), updated_at = now()`,
    [worldId]
  );
}

// The tick was claimed (persistent_bot_ticks row inserted). Tick ids only
// move forward; the claim time is the database clock.
async function recordClaim(queryable, worldId, tickId) {
  assertWorldId(worldId);
  assertTickId(tickId);
  await queryable.query(
    `INSERT INTO persistent_bot_heartbeat (world_id, last_claimed_tick_id, last_claimed_at, updated_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (world_id) DO UPDATE
       SET last_claimed_tick_id = GREATEST(COALESCE(persistent_bot_heartbeat.last_claimed_tick_id, EXCLUDED.last_claimed_tick_id), EXCLUDED.last_claimed_tick_id),
           last_claimed_at = now(),
           updated_at = now()`,
    [worldId, tickId]
  );
}

// A bot trade/loan/repay has just COMMITTED (review R5). Recorded at
// commit time, independently of how the containing tick ends, so a later
// timeout/error in the same tick can never hide an action that really
// happened. It never touches the success fields: an action is not a
// successful tick.
async function recordAction(queryable, worldId) {
  assertWorldId(worldId);
  await queryable.query(
    `INSERT INTO persistent_bot_heartbeat (world_id, last_action_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (world_id) DO UPDATE
       SET last_action_at = now(), updated_at = now()`,
    [worldId]
  );
}

// Every roster bot was processed WITHOUT a decision, programming or
// infrastructure failure (expected domain rejections and HOLDs are fine).
// Only this path ever writes the success fields; failures reset nothing
// here.
async function recordSuccess(queryable, worldId, tickId, { trades, holds, skips }) {
  assertWorldId(worldId);
  assertTickId(tickId);
  assertCount(trades, 'trades');
  assertCount(holds, 'holds');
  assertCount(skips, 'skips');
  const { rowCount } = await queryable.query(
    `UPDATE persistent_bot_heartbeat
        SET last_success_tick_id = GREATEST(COALESCE(last_success_tick_id, $2), $2),
            last_success_at = now(),
            last_outcome = 'SUCCESS',
            consecutive_failures = 0,
            last_trade_count = $3,
            last_hold_count = $4,
            last_skip_count = $5,
            updated_at = now()
      WHERE world_id = $1
        AND last_claimed_tick_id IS NOT NULL
        AND last_claimed_tick_id >= $2`,
    [worldId, tickId, trades, holds, skips]
  );
  if (rowCount !== 1) {
    throw new Error(`persistent bot heartbeat: tick ${tickId} cannot succeed before it is claimed`);
  }
}

// A failed or aborted attempt (claimed or not). The success fields are left
// untouched, so the last SUCCESSFUL tick stays visible and ages honestly.
async function recordFailure(queryable, worldId, outcome) {
  assertWorldId(worldId);
  if (outcome === 'SUCCESS' || !HEARTBEAT_OUTCOMES.includes(outcome)) {
    throw new Error(`persistent bot heartbeat failure outcome must be one of ${HEARTBEAT_OUTCOMES.filter((o) => o !== 'SUCCESS').join(', ')}; received ${String(outcome)}`);
  }
  await queryable.query(
    `INSERT INTO persistent_bot_heartbeat (world_id, last_failure_at, last_outcome, consecutive_failures, updated_at)
     VALUES ($1, now(), $2, 1, now())
     ON CONFLICT (world_id) DO UPDATE
       SET last_failure_at = now(),
           last_outcome = EXCLUDED.last_outcome,
           consecutive_failures = persistent_bot_heartbeat.consecutive_failures + 1,
           updated_at = now()`,
    [worldId, outcome]
  );
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) throw new Error(`persistent bot heartbeat timestamp is invalid; received ${String(value)}`);
  return new Date(ms).toISOString();
}

function intOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

// Defence in depth (review R4): the CHECK constraint is the authority for
// the outcome vocabulary, but the public projection never passes through
// a stored value it does not recognise — an out-of-vocabulary value (only
// possible on an incompatible schema the verifier reports) is published as
// the generic ERROR outcome, never as its raw text.
function knownOutcomeOrNull(value) {
  if (value === null || value === undefined) return null;
  return HEARTBEAT_OUTCOMES.includes(value) ? value : 'ERROR';
}

function countOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function loadHeartbeat(queryable, worldId) {
  assertWorldId(worldId);
  const { rows } = await queryable.query(
    `SELECT last_attempt_at, last_claimed_tick_id, last_claimed_at,
            last_success_tick_id, last_success_at, last_action_at,
            last_failure_at, last_outcome, consecutive_failures,
            last_trade_count, last_hold_count, last_skip_count
       FROM persistent_bot_heartbeat
      WHERE world_id = $1`,
    [worldId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    lastAttemptAt: isoOrNull(row.last_attempt_at),
    lastClaimedTickId: intOrNull(row.last_claimed_tick_id),
    lastClaimedAt: isoOrNull(row.last_claimed_at),
    lastSuccessTickId: intOrNull(row.last_success_tick_id),
    lastSuccessAt: isoOrNull(row.last_success_at),
    lastActionAt: isoOrNull(row.last_action_at),
    lastFailureAt: isoOrNull(row.last_failure_at),
    lastOutcome: knownOutcomeOrNull(row.last_outcome),
    consecutiveFailures: countOrNull(row.consecutive_failures) ?? 0,
    lastTradeCount: countOrNull(row.last_trade_count),
    lastHoldCount: countOrNull(row.last_hold_count),
    lastSkipCount: countOrNull(row.last_skip_count)
  };
}

// The public runtime projection. `stale` is derived ONLY from durable
// timestamps against the snapshot clock: no successful tick ever, or the
// newest success is older than staleAfterMs (three tick intervals). No
// process-local timer state is consulted, so every API process reports the
// same answer for the same database state.
function projectPublicBotHeartbeat(heartbeat, { snapshotMs, tickIntervalMs, staleAfterMs }) {
  const h = heartbeat || {};
  const lastSuccessfulTickAt = h.lastSuccessAt || null;
  const successMs = lastSuccessfulTickAt === null ? null : Date.parse(lastSuccessfulTickAt);
  const stale = successMs === null || snapshotMs - successMs > staleAfterMs;
  const hasSummary = [h.lastTradeCount, h.lastHoldCount, h.lastSkipCount]
    .every((n) => n !== null && n !== undefined);
  return {
    tickIntervalMs,
    staleAfterMs,
    stale,
    lastAttemptAt: h.lastAttemptAt || null,
    lastClaimedTickAt: h.lastClaimedAt || null,
    lastSuccessfulTickAt,
    lastActionAt: h.lastActionAt || null,
    lastFailureAt: h.lastFailureAt || null,
    lastOutcome: h.lastOutcome || null,
    consecutiveFailures: h.consecutiveFailures || 0,
    lastTickSummary: hasSummary
      ? { trades: h.lastTradeCount, holds: h.lastHoldCount, skips: h.lastSkipCount }
      : null
  };
}

module.exports = {
  HEARTBEAT_OUTCOMES,
  recordAttempt,
  recordClaim,
  recordAction,
  recordSuccess,
  recordFailure,
  loadHeartbeat,
  projectPublicBotHeartbeat
};
