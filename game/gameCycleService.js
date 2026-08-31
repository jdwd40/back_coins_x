const crypto = require('crypto');
const db = require('../db/connection');
// SIM-13/14: the dynamic collapse engine is the SINGLE coin-death
// authority. The retired fixed scheduled-collapse controller
// (collapseScheduleService) no longer exists — no normal path can call
// both controllers. Baseline restoration still happens exactly once per
// new-cycle boundary; death records live in apocalypse_coin_collapses.
const dynamicCollapseService = require('./dynamicCollapseService');
// Core 6: settlement phases (freeze/settle). gameSettlementService owns the
// Core 4 participant finalization hook now (it requires gameRoundService);
// neither it nor gameRoundService requires this module at the top level
// (joinRound lazy-requires reconcileCycle only), so there is no circular
// import. Successor creation stays here so a failed settlement durably
// blocks the next round.
const settlementService = require('./gameSettlementService');
// Issue #17: continuous automatic participation. Every cycle start (and
// every recovery of a pre-existing ACTIVE cycle) initializes one £10,000
// participant row per registered user via gameRoundService. Load order is
// safe: gameRoundService never requires this module at the top level (its
// one joinRound retry requires it lazily), exactly like the settlement
// chain above.
const gameRoundService = require('./gameRoundService');
// Issue #18: passive economic pressure. Every cycle start (and every
// recovery of a pre-existing ACTIVE cycle) persists the cycle's
// deterministic Apocalypse event schedule via economyService. Load order is
// safe: economyService never requires this module at the top level (its
// pass/player-view entry points require it lazily), exactly like the
// settlement chain above.
const economyService = require('./economyService');
// Wave 1 (SIM-03/04/05): every cycle start (and every recovery of a
// pre-existing ACTIVE cycle) extends the cycle's deterministic coin-event
// streams and its persisted primary market-phase chain to cover `now`.
// Load order is safe: neither engine requires this module at any
// level, exactly like the economy chain above. Both run inside the same
// Core 1 advisory-locked transaction; both observe persisted rows and
// never reroll them.
const coinEventEngine = require('./coinEventEngine');
const marketPhaseEngine = require('./marketPhaseEngine');
// Wave 2 (SIM-06/07): every cycle start (and every recovery of a
// pre-existing live ACTIVE cycle) creates/advances the cycle's durable
// market state — the deterministic market index, the monotonic persisted
// peak, drawdown, recent momentum, the hidden lifecycle state, and the
// per-cycle generated plateau target. Load order is safe: the engine never
// requires this module at any level, exactly like the Wave 1 engines
// above. It runs inside the same Core 1 advisory-locked transaction,
// observes the persisted row, never rerolls the target, and never writes
// coin prices. The live lifecycle state feeds new market-phase draws only;
// persisted phase rows stay authoritative.
const marketStateEngine = require('./marketStateEngine');

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

// Transactionally ensure an ACTIVE cycle exists and return it. Caller's
// reconcile loop decides whether it is live or needs freezing. A brand-new
// database gets the aligned initial cycle; a database whose latest cycle is
// COMPLETED gets exactly one chained successor starting at the predecessor's
// end. Recovery of a pre-existing active cycle observes persisted state
// without resetting live prices, and a live cycle's dynamic collapse
// evaluation runs at `now`. Everything runs inside the same advisory-locked
// Core 1 transaction shape as before, so concurrent processes can never
// create overlapping active cycles (the partial unique index is the
// backstop).
async function ensureActiveCycle({ now, durationMs, generateSeed }) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [GAME_CYCLE_ADVISORY_LOCK_KEY]);

    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    const { rows } = await client.query(
      `SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE' LIMIT 1 FOR UPDATE`
    );
    let active = rows[0];
    if (!active) {
      // Chain off the most recent COMPLETED predecessor so windows never gap
      // or overlap; with no history at all, start the aligned initial cycle.
      const { rows: prev } = await client.query(
        `SELECT end_time FROM apocalypse_cycles
         WHERE status = 'COMPLETED'
         ORDER BY end_time DESC, cycle_id DESC
         LIMIT 1`
      );
      const startTime = prev[0] ? new Date(prev[0].end_time) : alignStartTime(now, durationMs);
      active = await insertCycle(client, { startTime, durationMs, seed: generateSeed() });
      // New cycle boundary: restore the persisted baseline exactly once —
      // atomically with the cycle insert, so a previous cycle's £0 can
      // never leak forward. There is no collapse schedule to create: the
      // dynamic engine (SIM-13/14) writes death records only at the moment
      // of death, so no future timing/order is ever persisted.
      await dynamicCollapseService.restoreBaselinePrices(client);
      // Issue #17: every registered human and configured bot starts this
      // Apocalypse with exactly the authoritative starting cash — no JOIN
      // step, no human online required. Set-based and idempotent.
      await gameRoundService.initializeCycleParticipants(client, active.cycle_id);
      // Issue #18: persist this cycle's deterministic Apocalypse event
      // schedule atomically with the cycle start — derived from the cycle's
      // persisted seed, so restarts observe it and never reroll it.
      await economyService.ensureCycleEconomy(client, active);
      // Wave 1: persist this cycle's coin-event streams and the start of
      // its primary market-phase chain atomically with the cycle start —
      // both derived from the cycle's persisted seed, so restarts observe
      // them and never reroll them. Coin events extend only up to `now`
      // (rolling coverage: cycle creation cost does not scale with the
      // cycle length).
      await coinEventEngine.ensureCoinEventCoverage(client, active, new Date(nowMs));
      // Wave 2: open the cycle's durable market state atomically with the
      // cycle start — the starting index from the canonical surviving coin
      // state (prices were just restored to baseline above), the plateau
      // target drawn once from the persisted seed. New phase draws record
      // the (opening GROWTH) lifecycle state.
      const openingState = await marketStateEngine.ensureMarketState(client, active, new Date(nowMs));
      await marketPhaseEngine.ensureMarketPhaseCoverage(client, active, new Date(nowMs), { lifecycleState: openingState.lifecycle_state });
    } else {
      // Recovery path: a pre-existing active cycle is simply observed — no
      // baseline reset mid-cycle, and no collapse schedule to recover (the
      // dynamic engine persists deaths only at the moment of death).
      // Issue #17: ensure the live cycle's participant set is complete —
      // covers users registered mid-cycle and cycles created before
      // automatic participation existed. ON CONFLICT DO NOTHING makes this
      // a no-op for everyone already initialized; nobody is ever reset.
      await gameRoundService.initializeCycleParticipants(client, active.cycle_id);
      // Issue #18: ensure the live cycle's persisted event schedule exists —
      // covers cycles created before the economy engine shipped. ON
      // CONFLICT DO NOTHING: the persisted schedule is never rerolled.
      await economyService.ensureCycleEconomy(client, active);
      // Wave 1: extend the live cycle's coin-event streams and primary
      // market-phase chain to cover `now` — deterministic continuation,
      // observing persisted rows, never rerolling, never overlapping.
      await coinEventEngine.ensureCoinEventCoverage(client, active, new Date(nowMs));
      // While the cycle is live, run the dynamic collapse evaluation
      // (SIM-13/14: market-reactive deaths from the persisted authorities,
      // inside this advisory-locked transaction), then advance the durable
      // market state AFTER it so the market index reflects just-executed
      // deaths (Wave 2). An expired cycle's remaining deaths execute at
      // exactly cycle end during settlement (the final safety rule), not
      // here; an expired cycle's market state is no longer evaluated, but
      // its persisted lifecycle state still informs any trailing draws.
      let lifecycleState = 'GROWTH';
      if (new Date(active.end_time).getTime() > nowMs) {
        await dynamicCollapseService.evaluateAndExecuteCollapses(client, active, new Date(nowMs));
        const marketState = await marketStateEngine.ensureMarketState(client, active, new Date(nowMs));
        lifecycleState = marketState.lifecycle_state;
      } else {
        const persistedState = await marketStateEngine.getCycleMarketState(client, active.cycle_id);
        if (persistedState) lifecycleState = persistedState.lifecycle_state;
      }
      // Wave 2: the phase chain extends with the CURRENT hidden lifecycle
      // state (SIM-07); persisted phase rows stay authoritative history.
      await marketPhaseEngine.ensureMarketPhaseCoverage(client, active, new Date(nowMs), { lifecycleState });
    }

    await client.query('COMMIT');
    return active;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Bound on reconcile loop passes. Every non-returning pass makes one durable
// lifecycle advance (a freeze, a settlement, or a successor creation), so
// the loop always converges; the bound only guards against a pathological
// state looping forever.
const MAX_LIFECYCLE_PASSES = 10000;

// Transactionally create or recover the current global active cycle.
// Idempotent: an existing unexpired active cycle is returned unchanged.
//
// Core 6 lifecycle: ACTIVE -> SETTLING -> COMPLETED. Each reconcile call
// walks the same deterministic phase loop, each phase in its own
// advisory-locked transaction:
//   1. FREEZE: an expired ACTIVE cycle commits to durable SETTLING first.
//      From that commit, all trades against the cycle are rejected.
//   2. SETTLE: a durable SETTLING cycle is settled to completion — every
//      remaining coin forced to exactly £0 at cycle end (the dynamic
//      collapse engine's final safety rule), Core 4 participants
//      finalized,
//      the immutable ranked apocalypse_results snapshot written exactly
//      once, then the predecessor marked COMPLETED. A settlement failure
//      leaves SETTLING committed (observable via settlement_started_at with
//      settled_at NULL) and blocks any successor; the next call resumes it
//      safely — replays can never duplicate results, cash, collapses, or
//      successors.
//   3. ENSURE ACTIVE: with no SETTLING cycle outstanding, exactly one
//      successor is created, chained at the predecessor's end (Core 1
//      no-overlap). Long downtime chains one freeze/settle/successor pass
//      per elapsed cycle, preserving full history.
// Reconciliation observes and reuses persisted rows — it never rerolls.
async function reconcileCycle({ now = new Date(), durationMs, generateSeed = defaultGenerateSeed } = {}) {
  const duration = resolveDurationMs(durationMs);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();

  for (let pass = 0; pass < MAX_LIFECYCLE_PASSES; pass++) {
    // Phase 1: freeze an expired ACTIVE cycle into durable SETTLING.
    if (await settlementService.freezeExpiredActiveCycle({ nowMs })) continue;
    // Phase 2: complete any durable SETTLING cycle (results + COMPLETED).
    if (await settlementService.settleSettlingCycle()) continue;
    // Phase 3: ensure an ACTIVE cycle exists; return it when it is live.
    const active = await ensureActiveCycle({ now: nowDate, durationMs: duration, generateSeed });
    if (new Date(active.end_time).getTime() > nowMs) return active;
    // A chained successor that is itself already expired (long downtime):
    // loop to freeze and settle it in turn.
  }
  throw new Error('reconcileCycle: game lifecycle failed to converge');
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
//
// Milestone 1: the cycle seed is deliberately NOT part of the public
// contract. It deterministically drives the dynamic collapse rolls (SIM-13)
// and Core 5 bot randomness, so publishing it would let anyone precompute
// each coin's per-bucket death rolls. The seed stays persisted and
// internal-only.
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
