// Persistent-market Stage 3: persistence + validation for the world-level
// Market Director cursor (market_director_state, migration 025).
//
// The row commits the deterministic Director chain's current position for
// one world (master plan §12C: world/Director state — current regime,
// regime timing, intensity). The chain itself is a pure function of the
// world seed (game/marketDirector.js); this table holds the authoritative
// committed cursor so runtime and diagnostics read one row instead of
// re-walking the world age, and so the PUBLIC regime (master plan §10)
// has a redaction-safe authoritative source.
//
// Validation contract: every write is validated; a row with an unknown
// regime, an out-of-range intensity or a negative chain index fails
// loudly — the CHECK constraints (migration 025) make structurally
// impossible state unwritable, and this layer rejects it before SQL.
// This module never reads or writes apocalypse_* tables.

const { MARKET_PHASE_IDS } = require('../game/simulationConfig');

function assertDirectorState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('market director state must be an object');
  }
  if (!Number.isInteger(Number(state.worldId)) || Number(state.worldId) <= 0) {
    throw new Error(`market director state worldId must be a positive integer; received ${String(state.worldId)}`);
  }
  if (!MARKET_PHASE_IDS.includes(state.regime)) {
    throw new Error(`market director state regime must be one of ${MARKET_PHASE_IDS.join(', ')}; received ${JSON.stringify(state.regime)}`);
  }
  const startedMs = new Date(state.regimeStartedAt).getTime();
  if (!Number.isFinite(startedMs)) {
    throw new Error(`market director state regimeStartedAt is invalid; received ${String(state.regimeStartedAt)}`);
  }
  if (typeof state.intensity !== 'number' || !Number.isFinite(state.intensity) || state.intensity < 0 || state.intensity > 1) {
    throw new Error(`market director state intensity must be a finite number in [0, 1]; received ${String(state.intensity)}`);
  }
  if (!Number.isInteger(state.regimeIndex) || state.regimeIndex < 0) {
    throw new Error(`market director state regimeIndex must be a non-negative integer; received ${String(state.regimeIndex)}`);
  }
  return state;
}

function rowToState(row) {
  return {
    worldId: Number(row.world_id),
    regime: row.regime,
    regimeStartedAt: row.regime_started_at,
    intensity: row.intensity,
    regimeIndex: row.regime_index
  };
}

// Load the Director cursor for one world (null when none is committed
// yet — the world opens at the deterministic genesis). Runs on the
// caller's client so it can participate in a surrounding transaction.
async function loadDirectorState(client, worldId) {
  const { rows } = await client.query(
    `SELECT world_id, regime, regime_started_at, intensity, regime_index
       FROM market_director_state
      WHERE world_id = $1
      FOR UPDATE`,
    [worldId]
  );
  return rows.length === 0 ? null : rowToState(rows[0]);
}

// Insert or update the world's validated Director cursor. Replay-safe:
// the row is a pure function of the deterministic chain, so re-committing
// the same cursor is a no-op write.
async function upsertDirectorState(client, state) {
  assertDirectorState(state);
  await client.query(
    `INSERT INTO market_director_state (
       world_id, regime, regime_started_at, intensity, regime_index
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (world_id) DO UPDATE SET
       regime            = EXCLUDED.regime,
       regime_started_at = EXCLUDED.regime_started_at,
       intensity         = EXCLUDED.intensity,
       regime_index      = EXCLUDED.regime_index,
       updated_at        = now()`,
    [
      state.worldId, state.regime, new Date(state.regimeStartedAt).toISOString(),
      state.intensity, state.regimeIndex
    ]
  );
}

module.exports = {
  assertDirectorState,
  rowToState,
  loadDirectorState,
  upsertDirectorState
};
