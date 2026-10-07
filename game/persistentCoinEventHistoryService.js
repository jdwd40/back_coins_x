// Issue #52: public read-only persistent coin-event HISTORY.
// GET /api/persistent/coins/:coin_id/events?limit=N — additive; reuses the
// persistent runtime conventions (game/persistentRuntimeService.js).
//
// Envelope: { status: 'success', data: { serverTime, worldId, coinId, events } }.
//
// Read-only, one REPEATABLE READ READ ONLY snapshot; the DB transaction
// clock (now()) is the single authority for serverTime and for excluding
// future (not yet started) events, which is done in SQL. Never provisions,
// ticks, reconciles or mutates anything.
//
// Validation: coin_id must be a positive integer; limit is optional
// (default 50) and must be an integer in [1, 100]. Invalid -> 400. A coin
// absent from the catalogue -> 404 (dead/retired catalogue coins are
// valid and keep their history). No active world -> 200 with
// worldId null and events []. Real DB errors propagate (5xx).
//
// Event DTO allowlist: { eventId, name, direction, source, modifierPct,
// startsAt, endsAt }. Ordered newest first: startsAt DESC, eventId DESC.
// Active and expired events are both included.
//
// Field safety — `source`: the persisted vocabulary is NORMAL / GOLDEN /
// DEMON / RESCUE / DIRECTOR. GOLDEN/DEMON name hidden Director roles and
// RESCUE names an intervention intent (runtime only publishes roles while
// they are live), so the raw value is NEVER exposed. It is mapped to a
// coarse public category: NORMAL -> 'MARKET', anything else -> 'DIRECTOR'.
// The Director's existence and mode are already public via /runtime.
// Never exposed: event_seq, world internals, created_at, raw source.

const db = require('../db/connection');
const persistentWorld = require('./persistentWorld');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parsePositiveInt(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseCoinId(raw) {
  const id = parsePositiveInt(raw);
  if (id === null || id > 2147483647) {
    throw httpError(400, 'coin_id must be a positive integer');
  }
  return id;
}

function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = parsePositiveInt(raw);
  if (n === null || n > MAX_LIMIT) {
    throw httpError(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

function publicSource(source) {
  return source === 'NORMAL' ? 'MARKET' : 'DIRECTOR';
}

function roundTo(value, decimals) {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  return rounded === 0 ? 0 : rounded;
}

function projectEvent(row) {
  return {
    eventId: Number(row.event_id),
    name: row.name,
    direction: row.direction,
    source: publicSource(row.source),
    modifierPct: roundTo(parseFloat(row.modifier) * 100, 4),
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString()
  };
}

async function resolveActiveWorldOrNull(queryable) {
  try {
    return await persistentWorld.resolveActiveWorld(queryable);
  } catch (err) {
    if (err && /no active market world/.test(err.message)) return null;
    throw err;
  }
}

async function getPersistentCoinEventHistory({ coinId: rawCoinId, limit: rawLimit, queryable = db } = {}) {
  // Validate before touching the DB.
  const coinId = parseCoinId(rawCoinId);
  const limit = parseLimit(rawLimit);

  const ownsConnection = queryable === db;
  let client = queryable;
  if (ownsConnection) {
    client = await db.getClient();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
  try {
    const { rows: nowRows } = await client.query('SELECT now() AS db_now');
    const serverTime = new Date(nowRows[0].db_now).toISOString();

    const { rows: coinRows } = await client.query('SELECT coin_id FROM coins WHERE coin_id = $1', [coinId]);
    if (coinRows.length === 0) {
      throw httpError(404, `coin ${coinId} not found`);
    }

    const world = await resolveActiveWorldOrNull(client);
    let events = [];
    let worldId = null;
    if (world) {
      worldId = world.worldId;
      const { rows } = await client.query(
        `SELECT event_id, name, direction, source, modifier, starts_at, ends_at
           FROM persistent_coin_events
          WHERE world_id = $1 AND coin_id = $2 AND starts_at <= now()
          ORDER BY starts_at DESC, event_id DESC
          LIMIT $3`,
        [worldId, coinId, limit]
      );
      events = rows.map(projectEvent);
    }

    if (ownsConnection) await client.query('COMMIT');
    return { serverTime, worldId, coinId, events };
  } catch (err) {
    if (ownsConnection) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    if (ownsConnection && typeof client.release === 'function') client.release();
  }
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  publicSource,
  getPersistentCoinEventHistory
};
