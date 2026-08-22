// Core 3: permanent coin collapse — persisted per-cycle collapse schedule.
//
// Every apocalypse cycle gets exactly one deterministic schedule: each
// eligible coin is assigned a unique collapse rank and a scheduled collapse
// timestamp inside the final window of the cycle. The schedule is derived
// from the cycle's persisted Core 1 seed, persisted atomically at schedule
// creation, and never rerolled — reconciliation observes and reuses existing
// rows, so restarts, late wakeups, and concurrent processes all converge on
// the same stored plan. Execution state (executed_at) is stored explicitly on
// the durable row; death is never inferred from current_price === 0 and never
// held in an in-memory set.
//
// Lifecycle functions here accept an existing Core 1 transaction client: all
// schedule generation, collapse execution, baseline restoration and cycle
// rollover run inside the single Core 1 advisory-locked transaction
// (lock key 727001), which is what makes the whole lifecycle atomic and
// serialised across Node/PM2 processes. This module never requires
// gameCycleService (no circular requires) and owns no timers — timers in the
// worker/simulator are wakeups only, never the source of timing.

const crypto = require('crypto');
const db = require('../db/connection');
const logger = require('../utils/logger');

// The collapse window opens at 70% of the cycle: the first scheduled collapse
// happens exactly at cycleStart + cycleDuration * 0.70 and the last exactly at
// cycleEnd. This is a fixed game-design constant — deliberately NOT
// configurable via environment variables or any other runtime configuration.
const COLLAPSE_WINDOW_START_PERCENT = 70;

// ---------------------------------------------------------------------------
// Pure, testable schedule mathematics (no database, no clock, no globals).
// ---------------------------------------------------------------------------

// Compute the scheduled collapse timestamp for every rank in a cycle.
//   * N === 0 -> no collapses.
//   * N === 1 -> the sole collapse is exactly at cycle end.
//   * N > 1  -> rank 0 exactly at the 70% window start, rank N-1 exactly at
//     cycle end, intermediate ranks evenly spaced by (end - windowStart)/(N-1).
// Timestamps are integer-millisecond Dates (TIMESTAMPTZ storage precision is
// finer, but the application contract is millisecond-exact).
function computeScheduleTimes({ startTime, endTime, coinCount }) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error(`collapse schedule requires endTime after startTime; received ${startTime} .. ${endTime}`);
  }
  if (!Number.isInteger(coinCount) || coinCount < 0) {
    throw new Error(`collapse schedule coinCount must be a non-negative integer; received ${coinCount}`);
  }
  if (coinCount === 0) return [];
  if (coinCount === 1) return [new Date(endMs)];

  const windowStartMs = Math.round(startMs + (endMs - startMs) * (COLLAPSE_WINDOW_START_PERCENT / 100));
  const spacing = (endMs - windowStartMs) / (coinCount - 1);
  const times = [];
  for (let rank = 0; rank < coinCount; rank++) {
    if (rank === 0) times.push(new Date(windowStartMs));
    else if (rank === coinCount - 1) times.push(new Date(endMs));
    else times.push(new Date(Math.round(windowStartMs + spacing * rank)));
  }
  return times;
}

// Deterministic injectable random source: SHA-256 counter mode keyed by the
// cycle seed. Same seed -> identical stream, in every process, forever.
// Unit tests inject their own `random` to control the shuffle exactly.
function createSeededRandom(seed) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error(`collapse schedule seed must be a non-empty string; received ${typeof seed === 'string' ? JSON.stringify(seed) : String(seed)}`);
  }
  let counter = 0;
  return function seededRandom() {
    const digest = crypto.createHash('sha256').update(`${seed}:${counter}`).digest();
    counter += 1;
    return digest.readUInt32BE(0) / 0x100000000; // [0, 1)
  };
}

// Fisher-Yates with an injected random source. Never uses Math.random().
function deterministicShuffle(items, random) {
  const shuffled = items.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return shuffled;
}

// Build the full schedule row set for a cycle from its persisted seed and the
// eligible coins read once at creation time.
//   coins: [{ coin_id, baseline_price }] — input order is irrelevant: the set
//   is canonicalised by coin_id before the seed decides the collapse order,
//   so the same seed + same coin set always produces the same schedule.
//   Returns rows with collapse_rank/scheduled_at.
function buildSchedule({ seed, coins, startTime, endTime, random }) {
  if (!Array.isArray(coins)) {
    throw new Error('collapse schedule coins must be an array');
  }
  const canonical = coins.slice().sort((a, b) => a.coin_id - b.coin_id);
  const rng = random || createSeededRandom(seed);
  const ordered = deterministicShuffle(canonical, rng);
  const times = computeScheduleTimes({ startTime, endTime, coinCount: ordered.length });
  return ordered.map((coin, rank) => ({
    coin_id: coin.coin_id,
    collapse_rank: rank,
    scheduled_at: times[rank],
    baseline_price: coin.baseline_price
  }));
}

// ---------------------------------------------------------------------------
// Database-backed lifecycle. Every function takes the caller's transaction
// client so schedule generation, execution and rollover share one atomic,
// advisory-locked Core 1 transaction.
// ---------------------------------------------------------------------------

async function getScheduleForCycle(client, cycleId) {
  const { rows } = await client.query(
    `SELECT schedule_id, cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price, executed_at
     FROM coin_collapse_schedule
     WHERE cycle_id = $1
     ORDER BY collapse_rank`,
    [cycleId]
  );
  return rows;
}

// Create the cycle's schedule exactly once. If rows already exist they are
// authoritative and are returned unchanged — reconciliation never overwrites
// or chooses again. Eligible coins are read once, under row locks, inside the
// caller's transaction; the entire order/times persist atomically.
async function createScheduleForCycle(client, cycle) {
  const existing = await getScheduleForCycle(client, cycle.cycle_id);
  if (existing.length > 0) return existing;

  const { rows: coins } = await client.query(
    // Migration 014: retired coins are preserved history, not catalogue —
    // new cycles schedule collapses only across the active catalogue.
    `SELECT coin_id, current_price FROM coins WHERE retired = FALSE ORDER BY coin_id FOR UPDATE`
  );
  const schedule = buildSchedule({
    seed: cycle.seed,
    coins: coins.map((c) => ({ coin_id: c.coin_id, baseline_price: c.current_price })),
    startTime: cycle.start_time,
    endTime: cycle.end_time
  });
  if (schedule.length === 0) return [];

  await client.query(
    `INSERT INTO coin_collapse_schedule (cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price)
     SELECT $1, t.coin_id, t.collapse_rank, t.scheduled_at, t.baseline_price
     FROM unnest($2::integer[], $3::integer[], $4::timestamptz[], $5::numeric[])
       AS t(coin_id, collapse_rank, scheduled_at, baseline_price)`,
    [
      cycle.cycle_id,
      schedule.map((r) => r.coin_id),
      schedule.map((r) => r.collapse_rank),
      schedule.map((r) => r.scheduled_at.toISOString()),
      schedule.map((r) => r.baseline_price)
    ]
  );
  return getScheduleForCycle(client, cycle.cycle_id);
}

// Restore every coin's live price from its explicit persisted baseline. Runs
// only at a new cycle boundary, before that cycle's schedule is created, so a
// previous cycle's £0 collapse can never leak into the next cycle.
async function restoreBaselinePrices(client) {
  await client.query(`UPDATE coins SET current_price = cycle_baseline_price`);
}

// New-cycle boundary: restore the explicit persisted baseline, then create
// the new cycle's schedule — all inside the caller's transaction. Idempotent:
// if the schedule already exists this is a pure read (no restore, no reroll),
// so repeated reconciliation of the same cycle can never undo its collapses.
async function startCycle(client, cycle) {
  const existing = await getScheduleForCycle(client, cycle.cycle_id);
  if (existing.length > 0) return existing;
  await restoreBaselinePrices(client);
  return createScheduleForCycle(client, cycle);
}

// Execute every persisted unexecuted schedule row due at or before `now`.
// Each execution locks the durable schedule row (FOR UPDATE) and the coin row
// (via the UPDATE), sets the price to exactly numeric 0, appends the actual
// £0 transition to price_history, and stamps executed_at — all in the
// caller's transaction. Replay is idempotent: only executed_at IS NULL rows
// are ever selected, so a replay finds nothing to do and cannot duplicate
// state or £0 history rows. Earlier history is never touched and coins are
// never deleted.
async function executeDueCollapses(client, cycleId, now) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const { rows: due } = await client.query(
    `SELECT schedule_id, coin_id, collapse_rank, scheduled_at
     FROM coin_collapse_schedule
     WHERE cycle_id = $1 AND executed_at IS NULL AND scheduled_at <= $2
     ORDER BY collapse_rank
     FOR UPDATE`,
    [cycleId, nowDate.toISOString()]
  );

  const executed = [];
  for (const row of due) {
    await client.query(
      `UPDATE coins SET current_price = 0 WHERE coin_id = $1`,
      [row.coin_id]
    );
    await client.query(
      `INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, 0, $2)`,
      [row.coin_id, nowDate.toISOString()]
    );
    const { rowCount } = await client.query(
      `UPDATE coin_collapse_schedule SET executed_at = $1
       WHERE schedule_id = $2 AND executed_at IS NULL`,
      [nowDate.toISOString(), row.schedule_id]
    );
    if (rowCount !== 1) {
      // The row was locked FOR UPDATE by us and selected as unexecuted; a
      // zero update means inconsistent persisted state — fail the whole
      // lifecycle transaction rather than corrupt collapse state.
      throw new Error(`collapse schedule row ${row.schedule_id} changed under execution; aborting lifecycle transaction`);
    }
    executed.push(row);
    // Only past (executed) events are logged; future ordering/times are never
    // logged or exposed through normal endpoints.
    logger.log(`[GAME] Executed scheduled collapse: coin_id ${row.coin_id} (rank ${row.collapse_rank}, cycle ${cycleId})`);
  }
  return executed;
}

// Read-only helpers for the market simulator and the narrow trade guard.
// Death is read from the persisted execution state of the live cycle only —
// a collapse in a COMPLETED cycle must never make a new cycle's coins dead.
// Core 6: the SETTLING cycle counts as live here, so a coin collapsed at the
// end of a round stays dead through settlement (the freeze window has no
// ACTIVE cycle); the successor's baseline restoration revives prices only
// once the next cycle is ACTIVE.
async function getCollapsedCoinIds(queryable = db) {
  const { rows } = await queryable.query(
    `SELECT cs.coin_id
     FROM coin_collapse_schedule cs
     JOIN apocalypse_cycles ac ON ac.cycle_id = cs.cycle_id
     WHERE ac.status IN ('ACTIVE', 'SETTLING') AND cs.executed_at IS NOT NULL`
  );
  return new Set(rows.map((r) => r.coin_id));
}

async function isCoinCollapsed(coinId, queryable = db) {
  const { rows } = await queryable.query(
    `SELECT 1
     FROM coin_collapse_schedule cs
     JOIN apocalypse_cycles ac ON ac.cycle_id = cs.cycle_id
     WHERE ac.status IN ('ACTIVE', 'SETTLING') AND cs.coin_id = $1 AND cs.executed_at IS NOT NULL`,
    [coinId]
  );
  return rows.length > 0;
}

module.exports = {
  COLLAPSE_WINDOW_START_PERCENT,
  computeScheduleTimes,
  createSeededRandom,
  deterministicShuffle,
  buildSchedule,
  getScheduleForCycle,
  createScheduleForCycle,
  restoreBaselinePrices,
  startCycle,
  executeDueCollapses,
  getCollapsedCoinIds,
  isCoinCollapsed
};
