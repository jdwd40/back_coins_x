// Director Coin Events Wave 4: public read-only persistent RUNTIME state.
// GET /api/persistent/runtime — additive, uses the existing persistent
// router conventions (game/persistentMarketSignalsService.js is the
// sibling Stage 11-02 surface and is UNCHANGED).
//
// Public envelope always { status: 'success', data: { serverTime, worldId,
// director, coins } }. No auth. Read-only: this service NEVER provisions,
// never ticks the writer, never evaluates the Director, never reconciles,
// repairs or mutates anything — a corrupt/absent control row is reported
// (or fails loudly), never fixed.
//
// Snapshot discipline (one consistent DB snapshot):
//   * For the pool path, ONE pooled client runs BEGIN ISOLATION LEVEL
//     REPEATABLE READ READ ONLY BEFORE world resolution; every read below
//     runs on that client under that one snapshot.
//   * ONE DB transaction timestamp (SELECT now() inside the transaction)
//     is the single authority for serverTime, event active filtering,
//     role expiry and every snapshot semantic. Date.now() is NEVER used
//     for these decisions.
//   * Soft world resolve: no active world -> 200 + the exact null-world
//     response (a valid result, never an error, never a provisioning).
//     Real DB/projection errors throw to the controller's existing 5xx
//     path and NEVER become a null-world response.
//   * No FOR UPDATE anywhere on this path; no N+1: one grouped roster
//     read, one grouped active-event read (the Wave 1 model read), one
//     control read, one bounded history read.
//
// Director projection (adaptive director_control_state ONLY — the
// deterministic macro market_director_state is NEVER read here):
//   * no control row -> director: null (the roster/events still return).
//   * NORMAL projects direction: null and intensity: 0; the committed
//     window is preserved. Non-NORMAL exposes direction POSITIVE/NEGATIVE
//     and the committed intensity rounded to 3 decimals.
//   * Golden/Demon roles publish only when unexpired at the snapshot
//     instant AND the role coin is on the returned ALIVE/non-retired
//     roster; an invalid/expired role publishes BOTH its id and expiry as
//     null. A Golden/Demon collision nulls BOTH roles. Nothing is
//     repaired — the GET reports, the writer owns state.
//   * recentDecisions: the latest 10 committed decisions, newest first,
//     from the append-only director_decision_history (migration 032), with
//     the SAME NORMAL projection applied to history. decisionIndex and the
//     raw reason are never exposed; only the allowlisted summaryCode.
//
// Coin/event projection:
//   * roster = current-lifecycle ALIVE market_coin_state rows whose
//     catalogue coin is retired=false (DEAD coins and soft-retired
//     predecessors excluded; replacements appear under their own id).
//     Zero-event coins are included.
//   * events active exactly starts_at <= snapshotTime AND ends_at >
//     snapshotTime (the Wave 1 model/domain half-open semantics).
//   * Public event order is deterministic: POSITIVE events first, then
//     NEGATIVE, each by (startsAt, eventId) — stable identity only.
//   * modifierPct = the signed persisted fraction * 100, rounded to 4
//     decimals. activeNetModifierPct = the Wave 1 canonical stack-capped
//     net modifier (persistentCoinEventDomain.netActiveModifierCapped —
//     the cap formula is NEVER duplicated here) * 100, rounded to 4
//     decimals.
//
// Exact public keys only: top {serverTime, worldId, director, coins};
// director {mode, direction, intensity, startedAt, endsAt, goldenCoinId,
// goldenExpiresAt, demonCoinId, demonExpiresAt, recentDecisions};
// decision {mode, direction, intensity, startedAt, endsAt, summaryCode};
// coin {coinId, events, activeNetModifierPct}; event {eventId, name,
// modifierPct, startsAt, endsAt}. No convenience fields. Never serialize
// rows directly — explicit allowlisted DTOs only (no seeds, decision
// indices, raw reasons, sources/sequences, thresholds, targets, future
// events, checkpoints/accumulators, cycle/Apocalypse ids).

const db = require('../db/connection');
const persistentWorld = require('./persistentWorld');
const persistentCoinEventDomain = require('./persistentCoinEventDomain');
const controlModel = require('../models/directorControlState.model');
const eventsModel = require('../models/persistentCoinEvents.model');
const decisionHistoryModel = require('../models/directorDecisionHistory.model');
const { resolveSimulationConfig } = require('./simulationConfig');

const RECENT_DECISIONS_LIMIT = 10;

async function resolveActiveWorldOrNull(queryable) {
  try {
    return await persistentWorld.resolveActiveWorld(queryable);
  } catch (err) {
    if (err && /no active market world/.test(err.message)) {
      return null;
    }
    throw err;
  }
}

// Signed-zero-safe fixed-decimal rounding (a rounded -0 would serialise as
// -0, an ambiguous public value; +0 is canonical).
function roundTo(value, decimals) {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  return rounded === 0 ? 0 : rounded;
}

function isoOf(value, label) {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`persistent runtime ${label} is invalid; received ${String(value)}`);
  }
  return new Date(ms).toISOString();
}

// The public projection of one committed decision (current or historical):
// NORMAL projects direction null / intensity 0 (the window is preserved);
// non-NORMAL carries the committed direction and the 3-decimal intensity.
function projectDecision({ mode, direction, intensity, startedAt, endsAt, summaryCode }) {
  if (mode === 'NORMAL') {
    return {
      mode,
      direction: null,
      intensity: 0,
      startedAt: isoOf(startedAt, 'decision startedAt'),
      endsAt: isoOf(endsAt, 'decision endsAt'),
      summaryCode
    };
  }
  return {
    mode,
    direction,
    intensity: roundTo(intensity, 3),
    startedAt: isoOf(startedAt, 'decision startedAt'),
    endsAt: isoOf(endsAt, 'decision endsAt'),
    summaryCode
  };
}

// Role publication: a role stands only when it is assigned, unexpired at
// the snapshot instant, and its coin is on the returned roster. An
// invalid/expired role publishes BOTH fields null (never one without the
// other). A Golden/Demon collision nulls BOTH roles.
function projectRoles(control, rosterIds, snapshotMs) {
  const project = (coinId, expiresAt) => {
    if (coinId === null || coinId === undefined || expiresAt === null || expiresAt === undefined) {
      return { id: null, expiresAt: null };
    }
    const expiryMs = (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).getTime();
    if (!Number.isFinite(expiryMs) || expiryMs <= snapshotMs || !rosterIds.has(Number(coinId))) {
      return { id: null, expiresAt: null };
    }
    return { id: Number(coinId), expiresAt: new Date(expiryMs).toISOString() };
  };
  const golden = project(control.goldenCoinId, control.goldenExpiresAt);
  const demon = project(control.demonCoinId, control.demonExpiresAt);
  if (golden.id !== null && demon.id !== null && golden.id === demon.id) {
    return { golden: { id: null, expiresAt: null }, demon: { id: null, expiresAt: null } };
  }
  return { golden, demon };
}

async function getPersistentRuntime({ queryable = db, config = resolveSimulationConfig() } = {}) {
  const ownsConnection = queryable === db;
  let client = queryable;
  if (ownsConnection) {
    client = await db.getClient();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  try {
    // The ONE snapshot timestamp authority: the DB transaction clock,
    // taken before any resolution/filtering decision. serverTime, event
    // filtering and role expiry all read this value — never Date.now().
    const { rows: nowRows } = await client.query('SELECT now() AS db_now');
    const snapshotMs = new Date(nowRows[0].db_now).getTime();
    if (!Number.isFinite(snapshotMs)) {
      throw new Error('persistent runtime snapshot timestamp is invalid');
    }
    const serverTime = new Date(snapshotMs).toISOString();

    const world = await resolveActiveWorldOrNull(client);
    if (!world) {
      if (ownsConnection) {
        await client.query('COMMIT');
      }
      return { serverTime, worldId: null, director: null, coins: [] };
    }
    const worldId = world.worldId;

    // Grouped reads, no N+1: current control cursor, latest 10 decisions,
    // the ALIVE/non-retired roster, and every active event in one query.
    const control = await controlModel.loadDirectorControlState(client, worldId);
    const history = await decisionHistoryModel.listLatestDirectorDecisions(client, worldId, { limit: RECENT_DECISIONS_LIMIT });
    const { rows: rosterRows } = await client.query(
      `SELECT c.coin_id
         FROM coins c
         JOIN market_coin_state s ON s.coin_id = c.coin_id AND s.world_id = $1
        WHERE c.retired = false AND s.status = 'ALIVE'
        ORDER BY c.coin_id ASC`,
      [worldId]
    );
    const activeEvents = await eventsModel.listActivePersistentCoinEvents(client, worldId, snapshotMs);

    const rosterIds = new Set(rosterRows.map((row) => Number(row.coin_id)));

    const eventsByCoin = new Map();
    for (const event of activeEvents) {
      const coinId = Number(event.coinId);
      if (!rosterIds.has(coinId)) continue; // never leak DEAD/retired/non-roster events
      if (!eventsByCoin.has(coinId)) eventsByCoin.set(coinId, []);
      eventsByCoin.get(coinId).push(event);
    }

    const coins = rosterRows.map((row) => {
      const coinId = Number(row.coin_id);
      const coinEvents = eventsByCoin.get(coinId) || [];
      // Deterministic public order: POSITIVE first, then NEGATIVE, each by
      // (startsAt, eventId) — stable identity only, no event_seq leak.
      const ordered = coinEvents.slice().sort((a, b) =>
        (new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()) ||
        (Number(a.eventId) - Number(b.eventId)));
      const projectEvent = (event) => ({
        eventId: Number(event.eventId),
        name: event.name,
        modifierPct: roundTo(event.modifier * 100, 4),
        startsAt: isoOf(event.startsAt, 'event startsAt'),
        endsAt: isoOf(event.endsAt, 'event endsAt')
      });
      // The canonical Wave 1 stack-capped net modifier over the SAME
      // active set at the SAME snapshot instant.
      const netCapped = persistentCoinEventDomain.netActiveModifierCapped(coinEvents, snapshotMs, config);
      return {
        coinId,
        events: {
          positive: ordered.filter((event) => event.direction === 'POSITIVE').map(projectEvent),
          negative: ordered.filter((event) => event.direction === 'NEGATIVE').map(projectEvent)
        },
        activeNetModifierPct: roundTo(netCapped * 100, 4)
      };
    });

    let director = null;
    if (control !== null) {
      const roles = projectRoles(control, rosterIds, snapshotMs);
      const projected = projectDecision({
        mode: control.mode,
        direction: control.direction,
        intensity: control.intensity,
        startedAt: control.startedAt,
        endsAt: control.endsAt,
        summaryCode: null
      });
      director = {
        mode: projected.mode,
        direction: projected.direction,
        intensity: projected.intensity,
        startedAt: projected.startedAt,
        endsAt: projected.endsAt,
        goldenCoinId: roles.golden.id,
        goldenExpiresAt: roles.golden.expiresAt,
        demonCoinId: roles.demon.id,
        demonExpiresAt: roles.demon.expiresAt,
        recentDecisions: history.map((decision) => projectDecision(decision))
      };
    }

    if (ownsConnection) {
      await client.query('COMMIT');
    }

    return { serverTime, worldId, director, coins };
  } catch (err) {
    if (ownsConnection && client && typeof client.query === 'function') {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    if (ownsConnection && client && typeof client.release === 'function') {
      client.release();
    }
  }
}

module.exports = {
  RECENT_DECISIONS_LIMIT,
  getPersistentRuntime,
  // Exported for the role-projection tests (pure; the collision rule is
  // unreachable through the API because the DB CHECK forbids it).
  projectRoles
};
