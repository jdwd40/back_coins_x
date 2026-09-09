// Director Coin Events Wave 4: persistence + validation for the
// append-only Director decision history (director_decision_history,
// migration 032) — the public-safe decision ledger behind
// GET /api/persistent/runtime.
//
// director_control_state carries ONLY the current committed decision
// cursor; this table preserves every committed decision forever. The
// application path is INSERT-only (appendDirectorDecision) — nothing here
// updates or deletes rows.
//
// Identity/replay contract (mirroring the persistent_coin_events and
// director_control_state conventions):
//   * fresh identity                      -> insert, { inserted: true }
//   * identical payload at that identity  -> replay no-op, { inserted: false }
//   * DIFFERENT payload at that identity  -> loud failure (never a silent
//     overwrite of committed history)
//
// summary_code is the ONLY carried reason information: the raw internal
// decision reason is NEVER persisted here. summaryCodeForReason maps the
// committed reason onto the fixed public allowlist (unknown reasons ->
// OTHER_SAFE); migration 032's seed applies the SAME mapping in SQL.
//
// Transaction ownership (mirroring models/persistentCoinEvents.model.js):
// when handed anything exposing getClient (the pool) this module manages
// its own client + BEGIN/COMMIT/ROLLBACK; when handed a client it
// participates in the caller's open transaction and issues NO nested
// BEGIN/COMMIT. The persistent writer batch (models/market-simulator.js)
// appends on its batch client AFTER the adaptive Director evaluation's
// control-state upsert, so a batch rollback can never leave control state
// and decision history inconsistent — both live or both vanish. The
// single-statement INSERT ... ON CONFLICT needs no lock of its own and
// takes none: the batch's fixed lock order (coins -> market_worlds ->
// director_control_state/checkpoints) is untouched.
//
// This module never reads or writes apocalypse_* tables and never touches
// market_director_state (the deterministic six-regime Director).

const {
  COIN_EVENT_DIRECTION_IDS,
  DIRECTOR_CONTROL_MODE_IDS
} = require('../game/simulationConfig');

// The public summary allowlist — the exact vocabulary migration 032's
// CHECK constraint (director_decision_history_summary_known) enforces.
const DIRECTOR_DECISION_SUMMARY_CODES = Object.freeze([
  'GENESIS_NORMAL',
  'NORMAL_SWING',
  'REFRACTORY_NORMAL',
  'STAGNATION_SWING',
  'RESCUE_DISTRESS',
  'OVERHEAT_CORRECTION',
  'ROLE_ROTATION',
  'OTHER_SAFE'
]);

const MAX_LATEST_LIMIT = 50;

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`director decision history ${label} is invalid; received ${String(value)}`);
  }
  return ms;
}

// Map a committed decision reason to its public-safe summary code. Pure
// prefix mapping over the adaptive Director's reason vocabulary
// (game/adaptiveDirector.js); anything unrecognised maps to OTHER_SAFE so
// no internal reason text can ever leak into the public ledger. Migration
// 032's seed CASE applies the identical mapping.
function summaryCodeForReason(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return 'OTHER_SAFE';
  if (reason.startsWith('genesis:')) return 'GENESIS_NORMAL';
  if (reason.startsWith('refractory:')) return 'REFRACTORY_NORMAL';
  if (reason.startsWith('stagnation swing:')) return 'STAGNATION_SWING';
  if (reason.startsWith('rescue:')) return 'RESCUE_DISTRESS';
  if (reason.startsWith('overheat correction:')) return 'OVERHEAT_CORRECTION';
  if (reason.startsWith('role rotation:')) return 'ROLE_ROTATION';
  if (reason === 'normal swing window') return 'NORMAL_SWING';
  return 'OTHER_SAFE';
}

// Validate one decision-history entry before any SQL. Returns the entry.
function assertDirectorDecisionEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('director decision history entry must be an object');
  }
  if (!Number.isInteger(Number(entry.worldId)) || Number(entry.worldId) <= 0) {
    throw new Error(`director decision history worldId must be a positive integer; received ${String(entry.worldId)}`);
  }
  if (!Number.isInteger(entry.decisionIndex) || entry.decisionIndex < 0) {
    throw new Error(`director decision history decisionIndex must be a non-negative integer; received ${String(entry.decisionIndex)}`);
  }
  if (!DIRECTOR_CONTROL_MODE_IDS.includes(entry.mode)) {
    throw new Error(`director decision history mode must be one of ${DIRECTOR_CONTROL_MODE_IDS.join(', ')}; received ${JSON.stringify(entry.mode)}`);
  }
  if (!COIN_EVENT_DIRECTION_IDS.includes(entry.direction)) {
    throw new Error(`director decision history direction must be one of ${COIN_EVENT_DIRECTION_IDS.join(', ')}; received ${JSON.stringify(entry.direction)}`);
  }
  if (typeof entry.intensity !== 'number' || !Number.isFinite(entry.intensity) || entry.intensity < 0 || entry.intensity > 1) {
    throw new Error(`director decision history intensity must be a finite number in [0, 1]; received ${String(entry.intensity)}`);
  }
  const startedMs = toMs(entry.startedAt, 'startedAt');
  const endsMs = toMs(entry.endsAt, 'endsAt');
  if (endsMs <= startedMs) {
    throw new Error(`director decision history window must satisfy endsAt after startedAt; received ${entry.startedAt} .. ${entry.endsAt}`);
  }
  if (!DIRECTOR_DECISION_SUMMARY_CODES.includes(entry.summaryCode)) {
    throw new Error(`director decision history summaryCode must be one of ${DIRECTOR_DECISION_SUMMARY_CODES.join(', ')}; received ${JSON.stringify(entry.summaryCode)}`);
  }
  return entry;
}

function rowToDecision(row) {
  return {
    decisionId: Number(row.decision_id),
    worldId: Number(row.world_id),
    decisionIndex: Number(row.decision_index),
    mode: row.mode,
    direction: row.direction,
    intensity: row.intensity,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    summaryCode: row.summary_code,
    createdAt: row.created_at
  };
}

const DECISION_COLUMNS = `decision_id, world_id, decision_index, mode, direction, intensity,
       started_at, ends_at, summary_code, created_at`;

// Payload equality at one identity: every field except the surrogate row
// id and created_at.
function sameDecisionPayload(row, entry) {
  return row.mode === entry.mode &&
    row.direction === entry.direction &&
    row.intensity === entry.intensity &&
    toMs(row.started_at, 'started_at') === toMs(entry.startedAt, 'startedAt') &&
    toMs(row.ends_at, 'ends_at') === toMs(entry.endsAt, 'endsAt') &&
    row.summary_code === entry.summaryCode;
}

// Append one validated decision to the world's history. Idempotent at the
// (world_id, decision_index) identity: an identical retry is a write-free
// no-op; a divergent payload at a committed identity fails loudly —
// committed history is never rewritten.
async function appendDirectorDecision(queryable, entry) {
  assertDirectorDecisionEntry(entry);
  if (typeof queryable.getClient === 'function') {
    const owned = await queryable.getClient();
    try {
      await owned.query('BEGIN');
      const result = await appendDirectorDecision(owned, entry);
      await owned.query('COMMIT');
      return result;
    } catch (error) {
      await owned.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      owned.release();
    }
  }
  const client = queryable;
  const { rows: inserted } = await client.query(
    `INSERT INTO director_decision_history
       (world_id, decision_index, mode, direction, intensity, started_at, ends_at, summary_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (world_id, decision_index) DO NOTHING
     RETURNING ${DECISION_COLUMNS}`,
    [
      Number(entry.worldId), entry.decisionIndex, entry.mode, entry.direction, entry.intensity,
      new Date(toMs(entry.startedAt, 'startedAt')).toISOString(),
      new Date(toMs(entry.endsAt, 'endsAt')).toISOString(),
      entry.summaryCode
    ]
  );
  if (inserted.length > 0) {
    return { inserted: true, decision: rowToDecision(inserted[0]) };
  }
  const { rows: existing } = await client.query(
    `SELECT ${DECISION_COLUMNS}
       FROM director_decision_history
      WHERE world_id = $1 AND decision_index = $2`,
    [Number(entry.worldId), entry.decisionIndex]
  );
  if (existing.length === 0) {
    throw new Error(`director decision history (world ${entry.worldId}, decision ${entry.decisionIndex}) vanished during insert; aborting`);
  }
  if (!sameDecisionPayload(existing[0], entry)) {
    throw new Error(`director decision history identity conflict at (world ${entry.worldId}, decision ${entry.decisionIndex}): the committed payload differs; refusing to rewrite committed history`);
  }
  return { inserted: false, decision: rowToDecision(existing[0]) };
}

// The world's latest committed decisions, NEWEST first, bounded by a
// validated limit (the public runtime endpoint passes 10). Plain SELECT —
// never a write lock — so it participates cleanly in a surrounding
// read-only snapshot transaction.
async function listLatestDirectorDecisions(queryable, worldId, { limit = 10 } = {}) {
  if (!Number.isInteger(Number(worldId)) || Number(worldId) <= 0) {
    throw new Error(`director decision history worldId must be a positive integer; received ${String(worldId)}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LATEST_LIMIT) {
    throw new Error(`director decision history limit must be an integer in [1, ${MAX_LATEST_LIMIT}]; received ${String(limit)}`);
  }
  const { rows } = await queryable.query(
    `SELECT ${DECISION_COLUMNS}
       FROM director_decision_history
      WHERE world_id = $1
      ORDER BY decision_index DESC
      LIMIT $2`,
    [Number(worldId), limit]
  );
  return rows.map(rowToDecision);
}

module.exports = {
  DIRECTOR_DECISION_SUMMARY_CODES,
  summaryCodeForReason,
  assertDirectorDecisionEntry,
  rowToDecision,
  appendDirectorDecision,
  listLatestDirectorDecisions
};
