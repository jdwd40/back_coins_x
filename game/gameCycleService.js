const crypto = require('crypto');
const db = require('../db/connection');
const collapseSchedule = require('./collapseScheduleService');
// Core 4: round-state finalization hook. This module requires
// gameRoundService at load time; gameRoundService never requires this module
// at the top level (it lazy-requires reconcileCycle inside joinRound only),
// so there is no circular import.
const gameRoundService = require('./gameRoundService');

// Default global apocalypse cycle length: 30 minutes.
const DEFAULT_GAME_CYCLE_DURATION_MS = 30 * 60 * 1000;

// Explicit bounds for an operator-configured cycle duration. Anything outside
// this range is a configuration error, not a value to silently clamp.
const MIN_GAME_CYCLE_DURATION_MS = 60 * 1000; // 1 minute
const MAX_GAME_CYCLE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Transaction-scoped advisory lock serialises cycle creation/rollover across
// all processes sharing the database, so concurrent startups cannot create
// overlapping active cycles.
const GAME_CYCLE_ADVISORY_LOCK_KEY = 727001;

// Validate a configured cycle duration. Absent (undefined / empty string)
// means "not configured" and yields the default. Any present-but-invalid
// value — fractional, zero, negative, NaN, Infinity, non-numeric, below the
// minimum or above the maximum — throws a clear error immediately, before any
// database row can be created. Malformed values are never coerced or floored.
function validateGameCycleDurationMs(raw) {
  if (raw === undefined || raw === null) return DEFAULT_GAME_CYCLE_DURATION_MS;

  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return DEFAULT_GAME_CYCLE_DURATION_MS;
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(
        `GAME_CYCLE_DURATION_MS must be an integer number of milliseconds; received ${JSON.stringify(raw)}`
      );
    }
    value = Number(trimmed);
  }

  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(
      `GAME_CYCLE_DURATION_MS must be a number of milliseconds; received ${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)}`
    );
  }
  if (!Number.isFinite(value)) {
    throw new Error(`GAME_CYCLE_DURATION_MS must be finite; received ${String(raw)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`GAME_CYCLE_DURATION_MS must be an integer; received ${String(raw)}`);
  }
  if (value <= 0) {
    throw new Error(`GAME_CYCLE_DURATION_MS must be positive; received ${value}`);
  }
  if (value < MIN_GAME_CYCLE_DURATION_MS) {
    throw new Error(
      `GAME_CYCLE_DURATION_MS ${value} is below the minimum of ${MIN_GAME_CYCLE_DURATION_MS}ms`
    );
  }
  if (value > MAX_GAME_CYCLE_DURATION_MS) {
    throw new Error(
      `GAME_CYCLE_DURATION_MS ${value} exceeds the maximum of ${MAX_GAME_CYCLE_DURATION_MS}ms`
    );
  }
  return value;
}

// Resolve the effective duration for a new cycle: an explicit per-call value
// wins, otherwise GAME_CYCLE_DURATION_MS, otherwise the 30 minute default.
// Validation runs on every resolution, so a bad config throws before any
// invalid row is created — including at rollover time for the successor.
function resolveDurationMs(raw) {
  const value = raw !== undefined ? raw : process.env.GAME_CYCLE_DURATION_MS;
  return validateGameCycleDurationMs(value);
}

// Seed is obtained server-side; clients can never supply it.
function defaultGenerateSeed() {
  return crypto.randomBytes(16).toString('hex');
}

// Newly created normal-duration (30 minute) rounds align to predictable
// half-hour UTC boundaries: the start is floored to the containing :00/:30
// boundary so both start and end land on boundaries. Custom-duration rounds
// start exactly at `now` (alignment is not practical for them).
function alignStartTime(now, durationMs) {
  const start = now instanceof Date ? now : new Date(now);
  if (durationMs !== DEFAULT_GAME_CYCLE_DURATION_MS) return start;
  return new Date(Math.floor(start.getTime() / DEFAULT_GAME_CYCLE_DURATION_MS) * DEFAULT_GAME_CYCLE_DURATION_MS);
}

async function insertCycle(client, { startTime, durationMs, seed }) {
  const start = startTime instanceof Date ? startTime : new Date(startTime);
  const end = new Date(start.getTime() + durationMs);
  const inserted = await client.query(
    `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
     VALUES ('PENDING', $1, $2, $3, $4, 'ACTIVE')
     RETURNING cycle_id`,
    [seed, start.toISOString(), end.toISOString(), durationMs]
  );
  const cycleId = inserted.rows[0].cycle_id;
  const { rows } = await client.query(
    `UPDATE apocalypse_cycles
       SET apocalypse_id = 'APOC-' || lpad(cycle_id::text, 4, '0')
     WHERE cycle_id = $1
     RETURNING *`,
    [cycleId]
  );
  return rows[0];
}

// Transactionally create or recover the current global active cycle.
// Idempotent: an existing unexpired active cycle is returned unchanged.
// Expired cycles are completed and rolled into exactly one chained successor
// at a time until the active window contains `now` (multi-cycle downtime
// recovery). The advisory lock serialises this across processes; the partial
// unique index on status='ACTIVE' is the database-enforced backstop.
//
// Core 3 runs inside this same advisory-locked transaction:
//   * a newly created cycle restores coin prices from the explicit persisted
//     baseline and gets its deterministic collapse schedule generated once;
//   * a pre-existing active cycle missing its schedule (e.g. created before
//     Core 3 existed) has it recovered WITHOUT resetting live prices;
//   * before an expired cycle is marked COMPLETED, its persisted schedule is
//     reconciled through its END time, so the final scheduled coin collapses
//     to exactly £0 at the cycle end even if the app/worker was offline
//     across the boundary;
//   * the now-active cycle's due collapse rows are executed at `now`.
// Reconciliation observes and reuses persisted rows — it never rerolls.
async function reconcileCycle({ now = new Date(), durationMs, generateSeed = defaultGenerateSeed } = {}) {
  const duration = resolveDurationMs(durationMs);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [GAME_CYCLE_ADVISORY_LOCK_KEY]);

    let { rows } = await client.query(
      `SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE' LIMIT 1`
    );

    let active = rows[0];
    if (!active) {
      active = await insertCycle(client, { startTime: alignStartTime(now, duration), durationMs: duration, seed: generateSeed() });
      // New cycle boundary: restore the persisted baseline, then create this
      // cycle's schedule once — atomically with the cycle insert.
      await collapseSchedule.startCycle(client, active);
    } else {
      // Recovery path: a pre-existing active cycle gets its schedule created
      // if (and only if) it is missing. No baseline reset mid-cycle.
      await collapseSchedule.createScheduleForCycle(client, active);
    }

    // Complete expired round(s) and roll into exactly one successor each,
    // chaining start = predecessor end so windows never gap or overlap.
    while (new Date(active.end_time).getTime() <= nowMs) {
      // Reconcile the expiring cycle through its end time BEFORE it is
      // completed, so no scheduled collapse (including the final one,
      // scheduled exactly at cycle end) is lost to downtime.
      await collapseSchedule.executeDueCollapses(client, active.cycle_id, new Date(active.end_time));
      // Core 4: with the final £0 collapses persisted, finalize every active
      // participant of the expiring cycle — status FINALIZED, final_cash
      // from authoritative current_cash — inside this same advisory-locked
      // transaction, before the cycle becomes COMPLETED and its successor
      // exists. Nothing transfers to the successor; a join there starts
      // fresh at the game starting cash. The hook is idempotent.
      await gameRoundService.finalizeCycleParticipants(client, active.cycle_id);
      await client.query(
        `UPDATE apocalypse_cycles SET status = 'COMPLETED', updated_at = $2 WHERE cycle_id = $1`,
        [active.cycle_id, new Date(nowMs).toISOString()]
      );
      active = await insertCycle(client, {
        startTime: new Date(active.end_time),
        durationMs: duration,
        seed: generateSeed()
      });
      await collapseSchedule.startCycle(client, active);
    }

    // While an active cycle exists, reconcile its persisted due collapse rows.
    await collapseSchedule.executeDueCollapses(client, active.cycle_id, new Date(nowMs));

    await client.query('COMMIT');
    return active;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Derive countdown figures from the persisted window. apocalypsePercent is
// clamped to 0..100 and remainingMs never goes negative.
function deriveProgress({ startTime, endTime, durationMs, now }) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const duration = Number(durationMs);

  const remainingMs = Math.max(0, endMs - nowMs);
  const rawPercent = ((nowMs - startMs) / duration) * 100;
  const apocalypsePercent = Math.min(100, Math.max(0, rawPercent));
  return { remainingMs, apocalypsePercent };
}

// Maintenance + read: reconcile the active cycle (creating/recovering or
// rolling over as needed) and return the public state contract.
async function getGameState({ now = new Date(), durationMs, generateSeed } = {}) {
  const cycle = await reconcileCycle({ now, durationMs, generateSeed });
  const { remainingMs, apocalypsePercent } = deriveProgress({
    startTime: cycle.start_time,
    endTime: cycle.end_time,
    durationMs: cycle.duration_ms,
    now
  });

  return {
    apocalypseId: cycle.apocalypse_id,
    status: cycle.status,
    startTime: new Date(cycle.start_time).toISOString(),
    endTime: new Date(cycle.end_time).toISOString(),
    durationMs: Number(cycle.duration_ms),
    remainingMs,
    apocalypsePercent,
    seed: cycle.seed,
    serverTime: (now instanceof Date ? now : new Date(now)).toISOString()
  };
}

module.exports = {
  DEFAULT_GAME_CYCLE_DURATION_MS,
  MIN_GAME_CYCLE_DURATION_MS,
  MAX_GAME_CYCLE_DURATION_MS,
  validateGameCycleDurationMs,
  resolveDurationMs,
  deriveProgress,
  reconcileCycle,
  getGameState
};
