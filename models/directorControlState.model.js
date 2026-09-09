// Director Coin Events Wave 1: persistence + validation for the Director
// short-term runtime/control state (director_control_state, migration 029).
//
// One row per world carries the Director's SHORT-TERM control cursor: the
// current NORMAL/BOOM/BUST/RESCUE intervention mode, its direction and
// bounded intensity, its window, the idempotent decision cursor
// (decision_index), the decision reason, the Golden/Demon assignments with
// their expiries, the last broad swing direction, the stagnation tracking
// timestamp and (migration 030, PR #36 correction) the
// last_intervention_ended_at refractory tracker, plus (migration 031,
// PR #36 wave-2 correction) the last_intervention_mode refractory origin
// mode the emergency-refractory policy reads. A restarted runtime reads
// this one committed row and resumes safely; nothing is held in memory
// across processes.
//
// This state is fully SEPARATE from market_director_state (the
// deterministic six-regime Director cursor, migration 025): nothing here
// reads, writes or repurposes that table, and nothing here changes the
// deterministic Director.
//
// Validation contract: every write is validated before SQL; every READ
// validates too — a corrupt committed row fails loudly instead of silently
// driving decisions. Golden and Demon are never the same coin, and each
// assignment is pair-consistent (coin + expiry together, or neither). The
// CHECK constraints make structurally impossible state unwritable behind
// the model. Internal-only: no public API exposes any of these fields.
// This module never reads or writes apocalypse_* tables.

const {
  COIN_EVENT_DIRECTION_IDS,
  DIRECTOR_CONTROL_MODE_IDS
} = require('../game/simulationConfig');

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`director control state ${label} is invalid; received ${String(value)}`);
  }
  return ms;
}

function assertNullableTimestamp(value, label) {
  if (value === null || value === undefined) return;
  toMs(value, label);
}

// Null/undefined-normalised millisecond comparison for nullable timestamps.
function sameNullableTimestamp(a, b) {
  const aMs = a === null || a === undefined ? null : toMs(a, 'timestamp');
  const bMs = b === null || b === undefined ? null : toMs(b, 'timestamp');
  return aMs === bMs;
}

function sameNullableCoinId(a, b) {
  const aId = a === null || a === undefined ? null : Number(a);
  const bId = b === null || b === undefined ? null : Number(b);
  return aId === bId;
}

// Payload equality for the decision cursor: every state field except the
// world identity and the decision index itself.
function sameControlPayload(a, b) {
  return a.mode === b.mode &&
    a.direction === b.direction &&
    a.intensity === b.intensity &&
    toMs(a.startedAt, 'startedAt') === toMs(b.startedAt, 'startedAt') &&
    toMs(a.endsAt, 'endsAt') === toMs(b.endsAt, 'endsAt') &&
    a.reason === b.reason &&
    sameNullableCoinId(a.goldenCoinId, b.goldenCoinId) &&
    sameNullableTimestamp(a.goldenExpiresAt, b.goldenExpiresAt) &&
    sameNullableCoinId(a.demonCoinId, b.demonCoinId) &&
    sameNullableTimestamp(a.demonExpiresAt, b.demonExpiresAt) &&
    (a.lastSwingDirection ?? null) === (b.lastSwingDirection ?? null) &&
    sameNullableTimestamp(a.lastMeaningfulMovementAt, b.lastMeaningfulMovementAt) &&
    sameNullableTimestamp(a.lastInterventionEndedAt, b.lastInterventionEndedAt) &&
    (a.lastInterventionMode ?? null) === (b.lastInterventionMode ?? null);
}

function assertAssignment(coinId, expiresAt, label) {
  const hasCoin = coinId !== null && coinId !== undefined;
  const hasExpiry = expiresAt !== null && expiresAt !== undefined;
  if (hasCoin !== hasExpiry) {
    throw new Error(`director control state ${label} assignment must carry coin id and expiry together, or neither`);
  }
  if (hasCoin) {
    if (!Number.isInteger(Number(coinId)) || Number(coinId) <= 0) {
      throw new Error(`director control state ${label} coin id must be a positive integer; received ${String(coinId)}`);
    }
    toMs(expiresAt, `${label} expiry`);
  }
}

// Validate one Director control state (before SQL, and on read). Returns
// the state.
function assertDirectorControlState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('director control state must be an object');
  }
  if (!Number.isInteger(Number(state.worldId)) || Number(state.worldId) <= 0) {
    throw new Error(`director control state worldId must be a positive integer; received ${String(state.worldId)}`);
  }
  if (!DIRECTOR_CONTROL_MODE_IDS.includes(state.mode)) {
    throw new Error(`director control state mode must be one of ${DIRECTOR_CONTROL_MODE_IDS.join(', ')}; received ${JSON.stringify(state.mode)}`);
  }
  if (!COIN_EVENT_DIRECTION_IDS.includes(state.direction)) {
    throw new Error(`director control state direction must be one of ${COIN_EVENT_DIRECTION_IDS.join(', ')}; received ${JSON.stringify(state.direction)}`);
  }
  if (typeof state.intensity !== 'number' || !Number.isFinite(state.intensity) || state.intensity < 0 || state.intensity > 1) {
    throw new Error(`director control state intensity must be a finite number in [0, 1]; received ${String(state.intensity)}`);
  }
  const startedMs = toMs(state.startedAt, 'startedAt');
  const endsMs = toMs(state.endsAt, 'endsAt');
  if (endsMs <= startedMs) {
    throw new Error(`director control state window must satisfy endsAt after startedAt; received ${state.startedAt} .. ${state.endsAt}`);
  }
  if (!Number.isInteger(state.decisionIndex) || state.decisionIndex < 0) {
    throw new Error(`director control state decisionIndex must be a non-negative integer; received ${String(state.decisionIndex)}`);
  }
  if (typeof state.reason !== 'string' || state.reason.length === 0) {
    throw new Error('director control state reason must be a non-empty string');
  }
  assertAssignment(state.goldenCoinId, state.goldenExpiresAt, 'golden');
  assertAssignment(state.demonCoinId, state.demonExpiresAt, 'demon');
  const golden = state.goldenCoinId === undefined ? null : state.goldenCoinId;
  const demon = state.demonCoinId === undefined ? null : state.demonCoinId;
  if (golden !== null && demon !== null && Number(golden) === Number(demon)) {
    throw new Error(`director control state Golden and Demon can never be the same coin (both ${golden})`);
  }
  if (state.lastSwingDirection !== null && state.lastSwingDirection !== undefined
      && !COIN_EVENT_DIRECTION_IDS.includes(state.lastSwingDirection)) {
    throw new Error(`director control state lastSwingDirection must be null or one of ${COIN_EVENT_DIRECTION_IDS.join(', ')}; received ${JSON.stringify(state.lastSwingDirection)}`);
  }
  assertNullableTimestamp(state.lastMeaningfulMovementAt, 'lastMeaningfulMovementAt');
  assertNullableTimestamp(state.lastInterventionEndedAt, 'lastInterventionEndedAt');
  if (state.lastInterventionMode !== null && state.lastInterventionMode !== undefined
      && !['BOOM', 'BUST', 'RESCUE'].includes(state.lastInterventionMode)) {
    // The refractory origin (migration 031) is always an INTERVENTION mode.
    throw new Error(`director control state lastInterventionMode must be null or one of BOOM, BUST, RESCUE; received ${JSON.stringify(state.lastInterventionMode)}`);
  }
  return state;
}

// Map a committed row to the validated state shape. Validation on read is
// deliberate: a corrupt row fails loudly here rather than silently driving
// Director decisions after a restart.
function rowToControlState(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('director control state row must be an object');
  }
  return assertDirectorControlState({
    worldId: Number(row.world_id),
    mode: row.mode,
    direction: row.direction,
    intensity: row.intensity,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    decisionIndex: Number(row.decision_index),
    reason: row.reason,
    goldenCoinId: row.golden_coin_id === null ? null : Number(row.golden_coin_id),
    goldenExpiresAt: row.golden_expires_at,
    demonCoinId: row.demon_coin_id === null ? null : Number(row.demon_coin_id),
    demonExpiresAt: row.demon_expires_at,
    lastSwingDirection: row.last_swing_direction,
    lastMeaningfulMovementAt: row.last_meaningful_movement_at,
    lastInterventionEndedAt: row.last_intervention_ended_at === undefined ? null : row.last_intervention_ended_at,
    lastInterventionMode: row.last_intervention_mode === undefined ? null : row.last_intervention_mode
  });
}

// Internal locked read for the transactional upsert ONLY: the world's
// Director control state under a FOR UPDATE row lock on the caller's
// client. Ordinary reads MUST NOT use this — see loadDirectorControlState
// below for the lock-free path. Validation on read stays: a corrupt
// committed row fails loudly even inside the mutation.
async function loadDirectorControlStateForUpdate(client, worldId) {
  const { rows } = await client.query(
    `SELECT world_id, mode, direction, intensity, started_at, ends_at,
            decision_index, reason,
            golden_coin_id, golden_expires_at, demon_coin_id, demon_expires_at,
            last_swing_direction, last_meaningful_movement_at, last_intervention_ended_at,
            last_intervention_mode
       FROM director_control_state
      WHERE world_id = $1
     FOR UPDATE`,
    [worldId]
  );
  return rows.length === 0 ? null : rowToControlState(rows[0]);
}

// Ordinary validated read: load the world's Director control state (null
// when none is committed yet). This is a plain SELECT — it NEVER takes a
// write lock (no FOR UPDATE), so it neither blocks behind nor contends
// with a writer holding the state row. The row is validated on read: a
// corrupt committed row fails loudly instead of silently driving decisions.
// Runs on any queryable (pool or client), so it can participate in a
// surrounding read transaction.
async function loadDirectorControlState(queryable, worldId) {
  if (!Number.isInteger(Number(worldId)) || Number(worldId) <= 0) {
    throw new Error(`director control state worldId must be a positive integer; received ${String(worldId)}`);
  }
  const { rows } = await queryable.query(
    `SELECT world_id, mode, direction, intensity, started_at, ends_at,
            decision_index, reason,
            golden_coin_id, golden_expires_at, demon_coin_id, demon_expires_at,
            last_swing_direction, last_meaningful_movement_at, last_intervention_ended_at,
            last_intervention_mode
       FROM director_control_state
      WHERE world_id = $1`,
    [worldId]
  );
  return rows.length === 0 ? null : rowToControlState(rows[0]);
}

// Commit the world's validated Director control state. The decision cursor
// is idempotent and monotone:
//   * a NEWER decision_index advances the state;
//   * an EQUAL decision_index with the IDENTICAL payload is a replayed
//     commit — a no-op (no write, updated_at untouched);
//   * an EQUAL decision_index with a DIFFERENT payload is a conflicting
//     replay and fails loudly — the same decision can never mean two
//     different things;
//   * a STALE (lower) index — an old decision replayed after a newer one
//     committed — fails loudly so the cursor never rewinds.
//
// Concurrency: the checks above are only sound when the decision-cursor
// read and the write are serialised per world. The state row's own
// FOR UPDATE lock cannot do that on the FIRST write — when no row exists
// yet it locks nothing, and two concurrent first-time upserts would both
// pass the stale/equal-index checks and race into INSERT ... ON CONFLICT,
// the loser silently overwriting the winner. The repository-approved
// serialisation pattern (a parent/reference row lock inside the caller's
// transaction — the same shape as the coins/users FOR UPDATE validation
// reads) closes it: the referenced market_worlds row is locked FIRST,
// before the state-row lookup, so concurrent first-time upserts for one
// world queue on the world row and the loser re-reads the winner's
// committed cursor under the full monotone/equal-index rules. The world
// FK stays the authority; a missing world fails loudly here, before any
// state write is attempted. Lock order is fixed: market_worlds, then
// director_control_state — nothing else locks either row. In the
// persistent writer batch (models/market-simulator.js) this upsert runs
// on the batch client AFTER the batch has locked the coins rows, so the
// whole-batch order is coins -> market_worlds -> director_control_state.
// Future code must NEVER introduce the inverse market_worlds -> coins
// path (locking the world row before the coin rows in a transaction that
// also touches coins): that inverts the coins-first order every
// coins-touching path follows and completes a deadlock cycle.
//
// Transaction ownership (mirroring models/persistentCoinEvents.model.js):
// when handed anything exposing getClient (the connection pool/wrapper),
// this function acquires ONE client, runs the complete locked
// read/check/write in its own BEGIN/COMMIT transaction, rolls back on any
// error and releases in finally. When handed an already-acquired client,
// it participates in the caller's existing transaction and issues NO
// nested BEGIN/COMMIT — the caller owns that transaction (and MUST hold
// it open for the row locks to span the check and the write).
async function upsertDirectorControlState(queryable, state) {
  assertDirectorControlState(state);
  if (typeof queryable.getClient === 'function') {
    const owned = await queryable.getClient();
    try {
      await owned.query('BEGIN');
      await upsertDirectorControlState(owned, state);
      await owned.query('COMMIT');
      return;
    } catch (error) {
      await owned.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      owned.release();
    }
  }
  const client = queryable;
  const { rows: worldRows } = await client.query(
    'SELECT world_id FROM market_worlds WHERE world_id = $1 FOR UPDATE',
    [state.worldId]
  );
  if (worldRows.length === 0) {
    throw new Error(`director control state worldId ${state.worldId} does not reference a provisioned market world; refusing to write control state for a missing world`);
  }
  const existing = await loadDirectorControlStateForUpdate(client, state.worldId);
  if (existing !== null) {
    const committed = existing.decisionIndex;
    if (state.decisionIndex < committed) {
      throw new Error(`director control state decisionIndex ${state.decisionIndex} is stale: the committed cursor is already at ${committed}; refusing to rewind`);
    }
    if (state.decisionIndex === committed) {
      if (sameControlPayload(existing, state)) {
        return; // identical replay: no-op
      }
      throw new Error(`director control state decisionIndex ${state.decisionIndex} conflicts with the committed decision at that index; refusing to rewrite a committed decision`);
    }
  }
  await client.query(
    `INSERT INTO director_control_state (
       world_id, mode, direction, intensity, started_at, ends_at,
       decision_index, reason,
       golden_coin_id, golden_expires_at, demon_coin_id, demon_expires_at,
       last_swing_direction, last_meaningful_movement_at, last_intervention_ended_at,
       last_intervention_mode
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (world_id) DO UPDATE SET
       mode                       = EXCLUDED.mode,
       direction                  = EXCLUDED.direction,
       intensity                  = EXCLUDED.intensity,
       started_at                 = EXCLUDED.started_at,
       ends_at                    = EXCLUDED.ends_at,
       decision_index             = EXCLUDED.decision_index,
       reason                     = EXCLUDED.reason,
       golden_coin_id             = EXCLUDED.golden_coin_id,
       golden_expires_at          = EXCLUDED.golden_expires_at,
       demon_coin_id              = EXCLUDED.demon_coin_id,
       demon_expires_at           = EXCLUDED.demon_expires_at,
       last_swing_direction       = EXCLUDED.last_swing_direction,
       last_meaningful_movement_at = EXCLUDED.last_meaningful_movement_at,
       last_intervention_ended_at = EXCLUDED.last_intervention_ended_at,
       last_intervention_mode     = EXCLUDED.last_intervention_mode,
       updated_at                 = now()`,
    [
      state.worldId, state.mode, state.direction, state.intensity,
      new Date(toMs(state.startedAt, 'startedAt')).toISOString(),
      new Date(toMs(state.endsAt, 'endsAt')).toISOString(),
      state.decisionIndex, state.reason,
      state.goldenCoinId ?? null,
      state.goldenExpiresAt == null ? null : new Date(toMs(state.goldenExpiresAt, 'goldenExpiresAt')).toISOString(),
      state.demonCoinId ?? null,
      state.demonExpiresAt == null ? null : new Date(toMs(state.demonExpiresAt, 'demonExpiresAt')).toISOString(),
      state.lastSwingDirection ?? null,
      state.lastMeaningfulMovementAt == null ? null : new Date(toMs(state.lastMeaningfulMovementAt, 'lastMeaningfulMovementAt')).toISOString(),
      state.lastInterventionEndedAt == null ? null : new Date(toMs(state.lastInterventionEndedAt, 'lastInterventionEndedAt')).toISOString(),
      state.lastInterventionMode ?? null
    ]
  );
}

module.exports = {
  assertDirectorControlState,
  rowToControlState,
  loadDirectorControlState,
  upsertDirectorControlState
};
