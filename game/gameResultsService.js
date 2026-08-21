// Crypto Chaos Core 6: public read APIs for leaderboards and completed
// results.
//
//   * getLiveLeaderboard — the CURRENT active cycle, reconcile-then-read
//     (same convention as GET /api/game/state). Live wealth uses the Core 4
//     semantics exactly: current_cash + live value of current-round
//     holdings, with collapsed holdings at £0 (their live price IS £0).
//     Sorted wealth DESC, participant_id ASC; the position in that order is
//     the live rank. Informational only — the FINAL result is the immutable
//     apocalypse_results snapshot, which can differ.
//
//   * getCycleResults — a COMPLETED cycle's immutable snapshot rows, sorted
//     by rank. Non-COMPLETED cycles are clearly rejected (409); unknown ids
//     are 404. Rows are READ from apocalypse_results — never dynamically
//     recalculated from mutable participant/holding state.
//
//   * getRecentLeaderboards — the most recent COMPLETED cycles with their
//     immutable snapshots, bounded by a validated/clamped limit. The limit
//     only bounds the READ; historical rows are never deleted.
//
// Nothing here ever exposes the cycle seed or any scheduled-but-unexecuted
// (future) collapse data. The bot personality IS public game data by Core 6
// design (it appears on both the live leaderboard and final results).

const db = require('../db/connection');
const { reconcileCycle, deriveProgress } = require('./gameCycleService');

// Canonical public cycle identifier (Core 1): e.g. 'APOC-0001'.
const APOCALYPSE_ID_PATTERN = /^APOC-\d{4,}$/;

// Bounds for GET /api/game/leaderboards/recent?limit=. Game-design
// constants, deliberately not configurable.
const DEFAULT_RECENT_LEADERBOARDS_LIMIT = 5;
const MAX_RECENT_LEADERBOARDS_LIMIT = 25;

// Domain error carrying an HTTP status for the controller layer. Unknown
// errors still fall through to the generic 500 handler.
class GameResultsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GameResultsError';
    this.status = status;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Validate the recent-leaderboards limit: absent -> default; a present value
// must be an integer (numeric string accepted) and is clamped into
// 1..MAX. Non-numeric input is a 400, never silently coerced.
function resolveRecentLimit(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return DEFAULT_RECENT_LEADERBOARDS_LIMIT;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof trimmed === 'string' && !/^[+-]?\d+$/.test(trimmed)) {
    throw new GameResultsError(
      `Invalid limit. Please provide a positive integer no greater than ${MAX_RECENT_LEADERBOARDS_LIMIT}.`,
      400
    );
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value)) {
    throw new GameResultsError(
      `Invalid limit. Please provide a positive integer no greater than ${MAX_RECENT_LEADERBOARDS_LIMIT}.`,
      400
    );
  }
  return Math.min(MAX_RECENT_LEADERBOARDS_LIMIT, Math.max(1, value));
}

// ---------------------------------------------------------------------------
// Live leaderboard for the current ACTIVE cycle.
// ---------------------------------------------------------------------------
async function getLiveLeaderboard({ now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);

  // Reconcile-then-read: reading recovers any pending rollover/settlement,
  // exactly like GET /api/game/state. A settlement that is failing leaves its
  // cycle durably SETTLING — surface that clearly (409) instead of an opaque
  // 500; any non-settlement failure still propagates untouched.
  try {
    await reconcileCycle({ now: nowDate });
  } catch (err) {
    const { rows: stuck } = await db.query(
      `SELECT 1 FROM apocalypse_cycles WHERE status = 'SETTLING' LIMIT 1`
    );
    if (stuck.length > 0) {
      throw new GameResultsError(
        `No live apocalypse cycle is currently available: the previous round is still settling (${err.message}). Retry shortly; if this persists, the stuck SETTLING cycle needs operator attention.`,
        409
      );
    }
    throw err;
  }

  const { rows: cycleRows } = await db.query(
    `SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE' LIMIT 1`
  );
  const cycle = cycleRows[0];
  if (!cycle) {
    // The only way reconcile leaves no ACTIVE cycle is a settlement that is
    // failing repeatedly (the predecessor stays observably SETTLING). Say so
    // clearly instead of serving a stale or fabricated board.
    throw new GameResultsError(
      'No live apocalypse cycle is currently available: the previous round is still settling. Retry shortly; if this persists, the stuck SETTLING cycle needs operator attention.',
      409
    );
  }

  const { rows } = await db.query(
    `SELECT p.participant_id, p.user_id, u.username, u.is_bot,
            b.strategy AS personality,
            p.joined_at, p.current_cash, p.peak_wealth,
            p.current_cash + COALESCE(SUM(h.quantity * c.current_price), 0) AS wealth
     FROM apocalypse_participants p
     JOIN users u ON u.user_id = p.user_id
     LEFT JOIN apocalypse_bots b ON b.user_id = p.user_id
     LEFT JOIN apocalypse_holdings h ON h.participant_id = p.participant_id
     LEFT JOIN coins c ON c.coin_id = h.coin_id
     WHERE p.cycle_id = $1 AND p.status = 'ACTIVE'
     GROUP BY p.participant_id, u.username, u.is_bot, b.strategy
     ORDER BY wealth DESC, p.participant_id ASC`,
    [cycle.cycle_id]
  );

  const { remainingMs, apocalypsePercent } = deriveProgress({
    startTime: cycle.start_time,
    endTime: cycle.end_time,
    durationMs: cycle.duration_ms,
    now: nowDate
  });

  return {
    cycleId: cycle.apocalypse_id,
    status: cycle.status,
    startTime: new Date(cycle.start_time).toISOString(),
    endTime: new Date(cycle.end_time).toISOString(),
    apocalypsePercent,
    remainingMs,
    serverTime: nowDate.toISOString(),
    entries: rows.map((row, index) => {
      const currentCash = parseFloat(row.current_cash);
      return {
        rank: index + 1, // live rank: wealth DESC, participant_id ASC
        participantId: row.participant_id,
        userId: row.user_id,
        username: row.username,
        isBot: row.is_bot === true,
        personality: row.personality || null,
        joinedAt: new Date(row.joined_at).toISOString(),
        currentCash,
        currentWealth: round2(parseFloat(row.wealth)),
        peakWealth: parseFloat(row.peak_wealth)
      };
    })
  };
}

// ---------------------------------------------------------------------------
// Immutable results for one COMPLETED cycle, read straight from the
// snapshot. Never derived from mutable state at request time.
// ---------------------------------------------------------------------------
function validateApocalypseId(raw) {
  if (typeof raw !== 'string' || !APOCALYPSE_ID_PATTERN.test(raw)) {
    throw new GameResultsError('Invalid cycleId. Please provide an apocalypse identifier (e.g. APOC-0001).', 400);
  }
  return raw;
}

function publicResultRow(row) {
  return {
    rank: row.rank,
    participantId: row.participant_id,
    cycleId: row.apocalypse_id,
    userId: row.user_id,
    username: row.username,
    isBot: row.is_bot === true,
    personality: row.bot_personality || null,
    finalCash: parseFloat(row.final_cash),
    peakWealth: parseFloat(row.peak_wealth),
    startingCash: parseFloat(row.starting_cash),
    netProfit: parseFloat(row.net_profit),
    joinedAt: new Date(row.joined_at).toISOString(),
    tradeCount: row.trade_count,
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    settledAt: new Date(row.created_at).toISOString()
  };
}

async function getCycleResults(rawCycleId) {
  const cycleId = validateApocalypseId(rawCycleId);

  const { rows: cycleRows } = await db.query(
    `SELECT * FROM apocalypse_cycles WHERE apocalypse_id = $1`,
    [cycleId]
  );
  const cycle = cycleRows[0];
  if (!cycle) {
    throw new GameResultsError(`Unknown apocalypse cycle ${cycleId}.`, 404);
  }
  if (cycle.status !== 'COMPLETED') {
    throw new GameResultsError(
      `Apocalypse cycle ${cycleId} is ${cycle.status}, not COMPLETED. Final results exist only for completed cycles; use GET /api/game/leaderboard for the live round.`,
      409
    );
  }

  const { rows } = await db.query(
    `SELECT * FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank ASC`,
    [cycle.cycle_id]
  );

  return {
    cycleId: cycle.apocalypse_id,
    status: cycle.status,
    startTime: new Date(cycle.start_time).toISOString(),
    endTime: new Date(cycle.end_time).toISOString(),
    settledAt: cycle.settled_at ? new Date(cycle.settled_at).toISOString() : null,
    resultCount: rows.length,
    results: rows.map(publicResultRow)
  };
}

// ---------------------------------------------------------------------------
// Recent completed cycles with their immutable snapshots. The limit bounds
// the READ only — historical rows are never deleted to satisfy it.
// ---------------------------------------------------------------------------
async function getRecentLeaderboards({ limit: rawLimit } = {}) {
  const limit = resolveRecentLimit(rawLimit);

  const { rows: cycles } = await db.query(
    `SELECT * FROM apocalypse_cycles
     WHERE status = 'COMPLETED'
     ORDER BY end_time DESC, cycle_id DESC
     LIMIT $1`,
    [limit]
  );

  const leaderboards = [];
  for (const cycle of cycles) {
    const { rows } = await db.query(
      `SELECT * FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank ASC`,
      [cycle.cycle_id]
    );
    leaderboards.push({
      cycleId: cycle.apocalypse_id,
      status: cycle.status,
      startTime: new Date(cycle.start_time).toISOString(),
      endTime: new Date(cycle.end_time).toISOString(),
      settledAt: cycle.settled_at ? new Date(cycle.settled_at).toISOString() : null,
      resultCount: rows.length,
      results: rows.map(publicResultRow)
    });
  }

  return { limit, count: leaderboards.length, leaderboards };
}

module.exports = {
  DEFAULT_RECENT_LEADERBOARDS_LIMIT,
  MAX_RECENT_LEADERBOARDS_LIMIT,
  GameResultsError,
  resolveRecentLimit,
  getLiveLeaderboard,
  getCycleResults,
  getRecentLeaderboards
};
