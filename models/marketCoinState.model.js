// Persistent-market Stage 2: persistence + validation for the separate
// per-coin persistent market state (market_coin_state, migration 024).
//
// The state per coin: a bidirectional bounded condition, the structural
// reference price (log-space anchor for the weak restoring force), a
// DECAYING peak reference (never an all-time monotonic peak), and the
// explicit permanent death status/timestamp. All accumulator doubles are
// float8 (bit-exact node-pg round-trip, same contract as the Stage 1
// pricing checkpoints).
//
// Validation contract: every write is validated; a coin with a missing or
// unknown archetype FAILS LOUDLY at write time — the archetype is never
// silently defaulted at this layer. Death is an explicit one-way
// transition: recordDeath is the only writer of the DEAD status and is
// idempotent on replay (same instant), but refuses to resurrect or to move
// a recorded death.

const marketDomain = require('../game/marketDomain');

const KNOWN_ARCHETYPES = Object.keys(marketDomain.MARKET_ARCHETYPES);

function assertArchetype(archetype, coinId) {
  if (typeof archetype !== 'string' || !KNOWN_ARCHETYPES.includes(archetype)) {
    throw new Error(`market coin state for coin ${String(coinId)} requires a known archetype (one of ${KNOWN_ARCHETYPES.join(', ')}); received ${JSON.stringify(archetype)} — never default silently`);
  }
}

function assertFinitePositive(name, value, coinId) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`market coin state ${name} for coin ${String(coinId)} must be a finite positive number; received ${String(value)}`);
  }
}

function assertCondition(value, coinId) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`market coin state condition for coin ${String(coinId)} must be a finite number in [-1, 1]; received ${String(value)}`);
  }
}

// Validate a full state object (the write path). Returns it unchanged.
function assertCoinState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('market coin state must be an object');
  }
  if (!Number.isInteger(Number(state.coinId)) || Number(state.coinId) <= 0) {
    throw new Error(`market coin state coinId must be a positive integer; received ${String(state.coinId)}`);
  }
  if (!Number.isInteger(Number(state.worldId)) || Number(state.worldId) <= 0) {
    throw new Error(`market coin state worldId must be a positive integer; received ${String(state.worldId)}`);
  }
  assertArchetype(state.archetype, state.coinId);
  assertCondition(state.condition, state.coinId);
  assertFinitePositive('structuralReference', state.structuralReference, state.coinId);
  assertFinitePositive('peakReference', state.peakReference, state.coinId);
  if (state.status !== 'ALIVE' && state.status !== 'DEAD') {
    throw new Error(`market coin state status for coin ${String(state.coinId)} must be ALIVE or DEAD; received ${JSON.stringify(state.status)}`);
  }
  const diedAtMs = state.diedAt === null || state.diedAt === undefined
    ? null
    : new Date(state.diedAt).getTime();
  if (state.status === 'DEAD' && !Number.isFinite(diedAtMs)) {
    throw new Error(`market coin state for coin ${String(state.coinId)} is DEAD without a valid died_at; death must be explicit and timestamped`);
  }
  if (state.status === 'ALIVE' && diedAtMs !== null) {
    throw new Error(`market coin state for coin ${String(state.coinId)} is ALIVE with a died_at; death consistency violated`);
  }
  return state;
}

function rowToState(row) {
  return {
    coinId: Number(row.coin_id),
    worldId: Number(row.world_id),
    archetype: row.archetype,
    condition: row.condition,
    structuralReference: row.structural_reference,
    peakReference: row.peak_reference,
    status: row.status,
    diedAt: row.died_at
  };
}

// Load every coin's state for one world, keyed by coin id.
async function loadCoinStates(client, worldId) {
  const { rows } = await client.query(
    `SELECT coin_id, world_id, archetype, condition, structural_reference,
            peak_reference, status, died_at
       FROM market_coin_state
      WHERE world_id = $1
      FOR UPDATE`,
    [worldId]
  );
  const byCoin = new Map();
  for (const row of rows) {
    byCoin.set(Number(row.coin_id), rowToState(row));
  }
  return byCoin;
}

// Insert or update one coin's validated state. The update path never
// touches status/died_at: death transitions go exclusively through
// recordDeath.
async function upsertCoinState(client, state) {
  assertCoinState(state);
  await client.query(
    `INSERT INTO market_coin_state (
       coin_id, world_id, archetype, condition, structural_reference,
       peak_reference, status, died_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (coin_id) DO UPDATE SET
       world_id             = EXCLUDED.world_id,
       archetype            = EXCLUDED.archetype,
       condition            = EXCLUDED.condition,
       structural_reference = EXCLUDED.structural_reference,
       peak_reference       = EXCLUDED.peak_reference,
       updated_at           = now()`,
    [
      state.coinId, state.worldId, state.archetype, state.condition,
      state.structuralReference, state.peakReference, state.status,
      state.status === 'DEAD' ? state.diedAt : null
    ]
  );
}

// The explicit, permanent, timestamped death transition. Idempotent on
// exact replay (same death instant); refuses to move an existing death or
// to die twice differently. Never touches any other field — history and
// accumulators are preserved.
async function recordDeath(client, { coinId, worldId, diedAt }) {
  const diedAtDate = new Date(diedAt);
  if (!Number.isFinite(diedAtDate.getTime())) {
    throw new Error(`market coin state recordDeath for coin ${String(coinId)} requires a valid death instant; received ${String(diedAt)}`);
  }
  const { rows } = await client.query(
    `UPDATE market_coin_state
        SET status = 'DEAD', died_at = $3, updated_at = now()
      WHERE coin_id = $1 AND world_id = $2 AND status = 'ALIVE'
      RETURNING coin_id`,
    [coinId, worldId, diedAtDate.toISOString()]
  );
  if (rows.length === 1) return { died: true, alreadyDead: false };

  const { rows: existing } = await client.query(
    'SELECT status, died_at FROM market_coin_state WHERE coin_id = $1 AND world_id = $2',
    [coinId, worldId]
  );
  if (existing.length === 0) {
    throw new Error(`market coin state recordDeath: no state row for coin ${String(coinId)} in world ${String(worldId)}`);
  }
  const recordedMs = existing[0].died_at ? new Date(existing[0].died_at).getTime() : null;
  if (existing[0].status === 'DEAD' && recordedMs === diedAtDate.getTime()) {
    return { died: false, alreadyDead: true }; // exact replay: no-op
  }
  throw new Error(`market coin state recordDeath: coin ${String(coinId)} is already DEAD at a different instant (${existing[0].died_at}); death is permanent and cannot move`);
}

module.exports = {
  KNOWN_ARCHETYPES,
  assertArchetype,
  assertCoinState,
  rowToState,
  loadCoinStates,
  upsertCoinState,
  recordDeath
};
