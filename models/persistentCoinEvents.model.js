// Director Coin Events Wave 1: persistence + validation for the
// persistent-world coin-event authority (persistent_coin_events,
// migration 029).
//
// The table is the world-scoped, durable coin-event ledger for the
// persistent market — deliberately separate from the cycle-scoped
// apocalypse coin events. Identity is per-world/per-coin sequence:
// UNIQUE (world_id, coin_id, event_seq) backs idempotent inserts; rows are
// never updated or deleted, so expired history is preserved forever and an
// active event is never mutated underneath a reader.
//
// Validation contract: every write is validated against the resolved
// simulation config BEFORE SQL — direction/source vocabularies, the signed
// individual modifier bound (persistentEvents.maxIndividualModifier, sign
// matching direction), the 1-15 minute duration band
// (persistentEvents.durationMs) and the window ordering. The CHECK
// constraints make structurally impossible rows unwritable behind it.
// Replay contract: re-inserting the identical event at the identical
// identity is a no-op; reusing an identity with a DIFFERENT payload fails
// loudly (never a silent overwrite or reroll).
//
// Wave 1 scope: no live pricing integration and no automatic live event
// generation. This module never reads or writes apocalypse_* tables.

const {
  COIN_EVENT_DIRECTION_IDS,
  PERSISTENT_EVENT_SOURCE_IDS,
  resolveSimulationConfig
} = require('../game/simulationConfig');
const { activeCapacityVerdict } = require('../game/persistentCoinEventDomain');

const MAX_HISTORY_LIMIT = 500;

function toMs(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`persistent coin event ${label} is invalid; received ${String(value)}`);
  }
  return ms;
}

// Validate one persistent coin event before any SQL. Returns the event.
function assertPersistentCoinEvent(event, config = resolveSimulationConfig()) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('persistent coin event must be an object');
  }
  if (!Number.isInteger(Number(event.worldId)) || Number(event.worldId) <= 0) {
    throw new Error(`persistent coin event worldId must be a positive integer; received ${String(event.worldId)}`);
  }
  if (!Number.isInteger(Number(event.coinId)) || Number(event.coinId) <= 0) {
    throw new Error(`persistent coin event coinId must be a positive integer; received ${String(event.coinId)}`);
  }
  if (!Number.isInteger(event.eventSeq) || event.eventSeq < 1) {
    throw new Error(`persistent coin event eventSeq must be a positive integer; received ${String(event.eventSeq)}`);
  }
  if (typeof event.name !== 'string' || event.name.length === 0 || event.name.length > 100) {
    throw new Error('persistent coin event name must be a non-empty string of at most 100 characters');
  }
  if (!COIN_EVENT_DIRECTION_IDS.includes(event.direction)) {
    throw new Error(`persistent coin event direction must be one of ${COIN_EVENT_DIRECTION_IDS.join(', ')}; received ${JSON.stringify(event.direction)}`);
  }
  if (!PERSISTENT_EVENT_SOURCE_IDS.includes(event.source)) {
    throw new Error(`persistent coin event source must be one of ${PERSISTENT_EVENT_SOURCE_IDS.join(', ')}; received ${JSON.stringify(event.source)}`);
  }
  if (typeof event.modifier !== 'number' || !Number.isFinite(event.modifier)) {
    throw new Error(`persistent coin event modifier must be a finite number; received ${String(event.modifier)}`);
  }
  // Persisted precision contract: the column is NUMERIC(12,8), so a
  // submitted modifier must be exactly representable at 8 fractional
  // decimal places. PostgreSQL would SILENTLY ROUND anything finer
  // (0.010000001 -> 0.01000000), so the committed row would differ from
  // the submitted event — breaking the exact signed modifier contract and
  // turning an identical replay into a spurious identity conflict. A tiny
  // nonzero magnitude (1e-9) would round to zero and fail only in SQL.
  // Reject off-grid values here, before SQL, never silently round.
  //
  // Tolerance: scale to the 8-decimal grid and compare with the nearest
  // grid integer. A representable value sits within floating-point noise
  // (a handful of ulps of the scaled magnitude) of an integer; an
  // over-precision value sits at least ~0.1 grid steps away (its first
  // extra digit is the 9th decimal). The gap between the two is many
  // orders of magnitude, so the tolerance is unambiguous.
  const scaledMagnitude = Math.abs(event.modifier) * 1e8;
  const gridTolerance = Number.EPSILON * Math.max(1, scaledMagnitude) * 64;
  if (Math.abs(scaledMagnitude - Math.round(scaledMagnitude)) > gridTolerance) {
    throw new Error(`persistent coin event modifier must be exactly representable at the persisted 8-decimal precision; received ${event.modifier}`);
  }
  // The signed individual bound: magnitude within the configured limit AND
  // the sign matching the declared direction.
  const bound = config.persistentEvents.maxIndividualModifier;
  if (Math.abs(event.modifier) > bound) {
    throw new Error(`persistent coin event modifier magnitude ${event.modifier} exceeds the configured individual bound ${bound}`);
  }
  if (event.direction === 'POSITIVE' && event.modifier <= 0) {
    throw new Error(`persistent coin event modifier must be positive for a POSITIVE event; received ${event.modifier}`);
  }
  if (event.direction === 'NEGATIVE' && event.modifier >= 0) {
    throw new Error(`persistent coin event modifier must be negative for a NEGATIVE event; received ${event.modifier}`);
  }
  const startMs = toMs(event.startsAt, 'startsAt');
  const endMs = toMs(event.endsAt, 'endsAt');
  if (endMs <= startMs) {
    throw new Error(`persistent coin event window must satisfy endsAt after startsAt; received ${event.startsAt} .. ${event.endsAt}`);
  }
  const durationMs = endMs - startMs;
  const { min, max } = config.persistentEvents.durationMs;
  if (durationMs < min || durationMs > max) {
    throw new Error(`persistent coin event duration ${durationMs}ms is outside the configured ${min}-${max}ms band (1-15 minutes)`);
  }
  return event;
}

function rowToEvent(row) {
  return {
    eventId: Number(row.event_id),
    worldId: Number(row.world_id),
    coinId: Number(row.coin_id),
    eventSeq: Number(row.event_seq),
    name: row.name,
    direction: row.direction,
    source: row.source,
    modifier: parseFloat(row.modifier),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at
  };
}

// Idempotent, capacity-enforcing insert of one validated persistent coin
// event. Capacity contract: admitting the event must never push the coin's
// simultaneously ACTIVE events past the configured caps
// (persistentEvents.maxActivePerCoin and the per-direction caps) at any
// instant of the event's own window — checked by the pure
// activeCapacityVerdict helper against the persisted overlapping rows.
//
// Serialisation contract: the capacity check and the insert run in ONE
// transaction that first locks the catalogue coin row
// (SELECT ... FROM coins WHERE coin_id = $1 FOR UPDATE). Concurrent
// inserts for the same coin serialise on that row lock, so two
// transactions can never both pass the cap check; the second transaction's
// check runs after the first commits (READ COMMITTED gives each statement
// a fresh snapshot) and observes the committed row. When handed the
// connection pool (anything exposing getClient) this function manages its
// own client and BEGIN/COMMIT/ROLLBACK; when handed a client, it
// participates in the caller's surrounding transaction — the caller MUST
// then hold an open transaction for the row lock to be held across the
// check and the insert.
//   * fresh identity, within capacity     -> insert, { inserted: true }
//   * fresh identity, over capacity       -> loud failure, nothing written
//   * identical payload at that identity  -> replay no-op, { inserted: false }
//     (capacity is irrelevant: the event is already committed)
//   * DIFFERENT payload at that identity  -> loud failure (identity reuse)
async function insertPersistentCoinEvent(queryable, event, { config = resolveSimulationConfig() } = {}) {
  assertPersistentCoinEvent(event, config);
  if (typeof queryable.getClient === 'function') {
    const owned = await queryable.getClient();
    try {
      await owned.query('BEGIN');
      const result = await insertPersistentCoinEvent(owned, event, { config });
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
  const startMs = toMs(event.startsAt, 'startsAt');
  const endMs = toMs(event.endsAt, 'endsAt');
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  // Serialise concurrent inserts for this coin on its catalogue row lock
  // for the rest of this transaction (also re-proves the coin exists; the
  // FK is the structural backstop).
  const { rows: coinRows } = await client.query(
    'SELECT coin_id FROM coins WHERE coin_id = $1 FOR UPDATE',
    [event.coinId]
  );
  if (coinRows.length === 0) {
    throw new Error(`persistent coin event coinId ${event.coinId} does not reference a catalogue coin`);
  }
  // Identity first: an already-committed identity decides replay no-op vs
  // loud conflict regardless of capacity — a replayed commit must stay a
  // no-op even when the coin is at cap.
  const { rows: identityRows } = await client.query(
    `SELECT event_id, world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at, created_at
     FROM persistent_coin_events
     WHERE world_id = $1 AND coin_id = $2 AND event_seq = $3`,
    [event.worldId, event.coinId, event.eventSeq]
  );
  if (identityRows.length > 0) {
    const row = identityRows[0];
    const identical =
      row.name === event.name &&
      row.direction === event.direction &&
      row.source === event.source &&
      parseFloat(row.modifier) === event.modifier &&
      toMs(row.starts_at, 'starts_at') === startMs &&
      toMs(row.ends_at, 'ends_at') === endMs;
    if (!identical) {
      throw new Error(`persistent coin event identity conflict at (world ${event.worldId}, coin ${event.coinId}, seq ${event.eventSeq}): the committed payload differs; refusing to overwrite or reroll`);
    }
    return { inserted: false, event: rowToEvent(row) };
  }
  // Capacity: the candidate against this coin's persisted events that
  // overlap its window (starts_at < candidate ends_at AND
  // ends_at > candidate starts_at), peak-concurrency semantics via the
  // pure helper. A fresh identity that would breach the configured caps
  // is rejected BEFORE it is accepted; nothing is written.
  const { rows: overlapping } = await client.query(
    `SELECT event_id, world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at, created_at
     FROM persistent_coin_events
     WHERE world_id = $1 AND coin_id = $2 AND starts_at < $4 AND ends_at > $3`,
    [event.worldId, event.coinId, startIso, endIso]
  );
  const verdict = activeCapacityVerdict(overlapping, event, config);
  if (!verdict.allowed) {
    throw new Error(
      `persistent coin event capacity exceeded for coin ${event.coinId} in world ${event.worldId}: ` +
      `admitting the event peaks at ${verdict.peak.total} active (${verdict.peak.positive} positive, ` +
      `${verdict.peak.negative} negative) against the configured caps ` +
      `${verdict.caps.maxActivePerCoin} total / ${verdict.caps.maxActivePositivePerCoin} positive / ` +
      `${verdict.caps.maxActiveNegativePerCoin} negative`
    );
  }
  const { rows: inserted } = await client.query(
    `INSERT INTO persistent_coin_events
       (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (world_id, coin_id, event_seq) DO NOTHING
     RETURNING event_id, world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at, created_at`,
    [
      event.worldId, event.coinId, event.eventSeq, event.name,
      event.direction, event.source, event.modifier,
      startIso, endIso
    ]
  );
  if (inserted.length > 0) {
    return { inserted: true, event: rowToEvent(inserted[0]) };
  }
  // Unreachable under the coin row lock (the identity was free above and
  // same-coin writers are serialised); kept as a defensive guard — the
  // database remains the authority, never reroll, never overwrite.
  const { rows: existing } = await client.query(
    `SELECT event_id, world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at, created_at
     FROM persistent_coin_events
     WHERE world_id = $1 AND coin_id = $2 AND event_seq = $3`,
    [event.worldId, event.coinId, event.eventSeq]
  );
  if (existing.length === 0) {
    throw new Error(`persistent coin event (world ${event.worldId}, coin ${event.coinId}, seq ${event.eventSeq}) vanished during insert; aborting`);
  }
  const row = existing[0];
  const identical =
    row.name === event.name &&
    row.direction === event.direction &&
    row.source === event.source &&
    parseFloat(row.modifier) === event.modifier &&
    toMs(row.starts_at, 'starts_at') === startMs &&
    toMs(row.ends_at, 'ends_at') === endMs;
  if (!identical) {
    throw new Error(`persistent coin event identity conflict at (world ${event.worldId}, coin ${event.coinId}, seq ${event.eventSeq}): the committed payload differs; refusing to overwrite or reroll`);
  }
  return { inserted: false, event: rowToEvent(row) };
}

// Internal read: the world's events active at the INJECTED `now`
// (starts_at <= now < ends_at), optionally narrowed to one coin.
// Canonically ordered (starts_at, coin_id, event_seq) — the same canonical
// order as the pure domain (game/persistentCoinEventDomain.js
// filterActiveEvents), so model reads and pure computations agree.
// Expired history is preserved in the table but excluded here.
async function listActivePersistentCoinEvents(queryable, worldId, now, { coinId } = {}) {
  if (!Number.isInteger(Number(worldId)) || Number(worldId) <= 0) {
    throw new Error(`persistent coin events worldId must be a positive integer; received ${String(worldId)}`);
  }
  const nowMs = toMs(now, 'now');
  const params = [Number(worldId), new Date(nowMs).toISOString()];
  let coinClause = '';
  if (coinId !== undefined && coinId !== null) {
    if (!Number.isInteger(Number(coinId)) || Number(coinId) <= 0) {
      throw new Error(`persistent coin events coinId must be a positive integer; received ${String(coinId)}`);
    }
    params.push(Number(coinId));
    coinClause = ' AND coin_id = $3';
  }
  const { rows } = await queryable.query(
    `SELECT event_id, world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at, created_at
     FROM persistent_coin_events
     WHERE world_id = $1 AND starts_at <= $2 AND ends_at > $2${coinClause}
     ORDER BY starts_at, coin_id, event_seq`,
    params
  );
  return rows.map(rowToEvent);
}

// Internal read: one coin's full event history (including expired rows),
// newest sequence first, bounded by a validated limit.
async function getPersistentCoinEventHistory(queryable, worldId, coinId, { limit = 50 } = {}) {
  if (!Number.isInteger(Number(worldId)) || Number(worldId) <= 0) {
    throw new Error(`persistent coin event history worldId must be a positive integer; received ${String(worldId)}`);
  }
  if (!Number.isInteger(Number(coinId)) || Number(coinId) <= 0) {
    throw new Error(`persistent coin event history coinId must be a positive integer; received ${String(coinId)}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new Error(`persistent coin event history limit must be an integer in [1, ${MAX_HISTORY_LIMIT}]; received ${String(limit)}`);
  }
  const { rows } = await queryable.query(
    `SELECT event_id, world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at, created_at
     FROM persistent_coin_events
     WHERE world_id = $1 AND coin_id = $2
     ORDER BY event_seq DESC
     LIMIT $3`,
    [Number(worldId), Number(coinId), limit]
  );
  return rows.map(rowToEvent);
}

module.exports = {
  MAX_HISTORY_LIMIT,
  assertPersistentCoinEvent,
  rowToEvent,
  insertPersistentCoinEvent,
  listActivePersistentCoinEvents,
  getPersistentCoinEventHistory
};
