// Crypto Chaos issue #19: profitable-only leaderboard qualification.
//
// Canonical rule: a completed-round result qualifies for the public
// leaderboard only when final_cash > that round's authoritative
// starting_cash. Exactly break-even (£10,000.00 under the current
// configuration) does NOT qualify; £9,999.99 does not; £10,000.01 does.
// Humans and bots use the identical rule, leaderboard ranks among
// qualifying entries are gapless 1..M, losing/break-even results remain
// fully preserved via GET /api/game/results/:cycleId, and a cycle with
// zero qualifying players yields a legitimate empty board.
//
// The threshold is derived from each result row's own stored starting_cash
// (the authoritative value snapshotted from gameConstants at participant
// creation) — proven below by running a cycle under an overridden
// GAME_STARTING_CASH: eligibility follows the configured value, never a
// hard-coded 10000 literal.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const botService = require('../game/botService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const SHORT_DURATION_MS = 60 * 1000;

// Build a cycle with the full auto-initialized field (both seeded humans +
// the provisioned bot roster), override each named participant's final cash
// deterministically, then expire and settle it through the REAL lifecycle.
async function settleCycleWithCash({ cashByUserId = {}, startingCashEnv } = {}) {
  const savedEnv = process.env.GAME_STARTING_CASH;
  if (startingCashEnv !== undefined) process.env.GAME_STARTING_CASH = startingCashEnv;
  try {
    const cycle = await reconcileCycle({ now: new Date(), durationMs: SHORT_DURATION_MS });
    await botService.ensureBotsProvisioned();
    await reconcileCycle({ now: new Date(), durationMs: SHORT_DURATION_MS }); // sweep roster in

    for (const [userId, cash] of Object.entries(cashByUserId)) {
      await db.query(
        'UPDATE apocalypse_participants SET current_cash = $1 WHERE cycle_id = $2 AND user_id = $3',
        [cash, cycle.cycle_id, Number(userId)]
      );
    }

    await db.query(
      `UPDATE apocalypse_cycles
       SET start_time = now() - interval '2 minutes', end_time = now() - interval '1 second'
       WHERE cycle_id = $1`,
      [cycle.cycle_id]
    );
    await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });

    const { rows } = await db.query('SELECT * FROM apocalypse_cycles WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(rows[0].status).toBe('COMPLETED');
    return rows[0];
  } finally {
    if (startingCashEnv !== undefined) {
      if (savedEnv === undefined) delete process.env.GAME_STARTING_CASH;
      else process.env.GAME_STARTING_CASH = savedEnv;
    }
  }
}

async function recentBoardFor(cycle) {
  const response = await request(app).get('/api/game/leaderboards/recent').expect(200);
  return response.body.data.leaderboards.find((b) => b.cycleId === cycle.apocalypse_id);
}

describe('issue #19: profitable-only leaderboard qualification', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('threshold: £9,999.99 and £10,000.00 excluded, £10,000.01 included — identical rule for humans and bots', async () => {
    // users: 1 john_doe, 2 jane_smith; bots: 3..6 (conservative/momentum/dip_buyer/reckless)
    const cycle = await settleCycleWithCash({
      cashByUserId: {
        1: 9999.99,   // human loss — NOT eligible
        2: 10000.00,  // exact break-even — NOT eligible
        3: 10000.01,  // bot penny profit — eligible
        4: 12050.00,  // bot clear profit — eligible
        5: 9950.00,   // bot loss — NOT eligible
        6: 10000.00   // bot break-even — NOT eligible
      }
    });

    // The full immutable snapshot preserves EVERY result with an explicit
    // eligibility flag — history is never hidden.
    const resultsRes = await request(app).get(`/api/game/results/${cycle.apocalypse_id}`).expect(200);
    const results = resultsRes.body.data.results;
    expect(results).toHaveLength(6);
    const byUser = new Map(results.map((r) => [r.userId, r]));
    expect(byUser.get(1)).toMatchObject({ finalCash: 9999.99, leaderboardEligible: false });
    expect(byUser.get(2)).toMatchObject({ finalCash: 10000, leaderboardEligible: false });
    expect(byUser.get(3)).toMatchObject({ finalCash: 10000.01, leaderboardEligible: true, isBot: true });
    expect(byUser.get(4)).toMatchObject({ finalCash: 12050, leaderboardEligible: true, isBot: true });
    expect(byUser.get(5)).toMatchObject({ finalCash: 9950, leaderboardEligible: false, isBot: true });
    expect(byUser.get(6)).toMatchObject({ finalCash: 10000, leaderboardEligible: false, isBot: true });

    // The public completed-round board contains ONLY the two profitable
    // finishes — humans and bots under one rule, gapless ranks 1..2 with
    // the settlement tie-break (final cash DESC).
    const board = await recentBoardFor(cycle);
    expect(board.resultCount).toBe(2);
    expect(board.totalResultCount).toBe(6);
    expect(board.results.map((r) => r.rank)).toEqual([1, 2]);
    expect(board.results[0]).toMatchObject({ userId: 4, isBot: true, finalCash: 12050, leaderboardEligible: true });
    expect(board.results[1]).toMatchObject({ userId: 3, isBot: true, finalCash: 10000.01, leaderboardEligible: true });
  });

  test('a cycle with zero qualifying players is a legitimate empty leaderboard; results stay preserved', async () => {
    const cycle = await settleCycleWithCash({
      cashByUserId: { 1: 10000.00, 2: 8420.50, 3: 10000.00, 4: 7311.00, 5: 10000.00, 6: 10.00 }
    });

    const board = await recentBoardFor(cycle);
    expect(board).toMatchObject({ resultCount: 0, totalResultCount: 6, results: [] });

    const resultsRes = await request(app).get(`/api/game/results/${cycle.apocalypse_id}`).expect(200);
    expect(resultsRes.body.data.resultCount).toBe(6);
    for (const row of resultsRes.body.data.results) {
      expect(row.leaderboardEligible).toBe(false);
    }
  });

  test('tie among qualifying entries breaks by participant_id with gapless ranks; ineligible ties never leave gaps', async () => {
    // Three qualifiers, two tied at the top; three non-qualifiers interleaved
    // in the raw finishing order must NOT leave rank gaps on the board.
    const cycle = await settleCycleWithCash({
      cashByUserId: { 1: 15000.00, 2: 10000.00, 3: 15000.00, 4: 1.00, 5: 10000.01, 6: 9999.99 }
    });

    const board = await recentBoardFor(cycle);
    expect(board.resultCount).toBe(3);
    expect(board.results.map((r) => r.rank)).toEqual([1, 2, 3]);
    // The £15,000 tie: the lower participant_id (auto-init is user_id ASC)
    // wins — human user 1 ahead of bot user 3 under the identical rule.
    expect(board.results.map((r) => r.userId)).toEqual([1, 3, 5]);
    expect(board.results.map((r) => r.leaderboardEligible)).toEqual([true, true, true]);
  });

  test('the configured starting cash is the source of truth — no hard-coded 10000 anywhere in the rule', async () => {
    // A cycle configured (as deployments may) with £5,000 starting cash:
    // £7,500 is a clear profit, £5,000 exactly is not, £10,000.01 vs an
    // imagined hard-coded threshold would give the WRONG answer for £7,500
    // if the code ignored the stored authoritative value.
    const cycle = await settleCycleWithCash({
      startingCashEnv: '5000',
      cashByUserId: { 1: 7500.00, 2: 5000.00, 3: 4999.99, 4: 5000.01, 5: 5000.00, 6: 0.00 }
    });

    const resultsRes = await request(app).get(`/api/game/results/${cycle.apocalypse_id}`).expect(200);
    const byUser = new Map(resultsRes.body.data.results.map((r) => [r.userId, r]));
    expect(byUser.get(1)).toMatchObject({ startingCash: 5000, finalCash: 7500, leaderboardEligible: true });
    expect(byUser.get(2)).toMatchObject({ startingCash: 5000, finalCash: 5000, leaderboardEligible: false });
    expect(byUser.get(3)).toMatchObject({ finalCash: 4999.99, leaderboardEligible: false });
    expect(byUser.get(4)).toMatchObject({ finalCash: 5000.01, leaderboardEligible: true });

    const board = await recentBoardFor(cycle);
    expect(board.results.map((r) => [r.rank, r.userId])).toEqual([[1, 1], [2, 4]]);
  });

  test('historical pre-rule rows get identical threshold semantics (generated column backfill, no rewrite)', async () => {
    // Simulate a pre-#19 completed cycle whose results were snapshotted when
    // starting cash was £1,000: a £1,250 finish was profitable THEN and must
    // be flagged eligible NOW without any historical rewrite.
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status, settled_at, settlement_started_at)
       VALUES ('APOC-LEGACY', 'legacy-seed', now() - interval '2 hours', now() - interval '90 minutes', 1800000, 'COMPLETED', now() - interval '90 minutes', now() - interval '91 minutes')`
    );
    const { rows: [cyc] } = await db.query(`SELECT cycle_id, apocalypse_id FROM apocalypse_cycles WHERE apocalypse_id = 'APOC-LEGACY'`);
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status, final_cash)
       VALUES ($1, 1, 1000.00, 1250.00, 1250.00, 'FINALIZED', 1250.00),
              ($1, 2, 1000.00, 750.00, 1000.00, 'FINALIZED', 750.00)`,
      [cyc.cycle_id]
    );
    const { rows: parts } = await db.query(
      'SELECT participant_id, user_id FROM apocalypse_participants WHERE cycle_id = $1', [cyc.cycle_id]);
    const pid = (u) => parts.find((p) => p.user_id === u).participant_id;
    await db.query(
      `INSERT INTO apocalypse_results
        (cycle_id, participant_id, user_id, apocalypse_id, username, is_bot, bot_personality, rank, final_cash, peak_wealth, starting_cash, net_profit, joined_at, trade_count, buy_count, sell_count)
       VALUES
        ($1, $2, 1, 'APOC-LEGACY', 'john_doe', false, NULL, 1, 1250.00, 1250.00, 1000.00, 250.00, now() - interval '2 hours', 0, 0, 0),
        ($1, $3, 2, 'APOC-LEGACY', 'jane_smith', false, NULL, 2, 750.00, 1000.00, 1000.00, -250.00, now() - interval '2 hours', 0, 0, 0)`,
      [cyc.cycle_id, pid(1), pid(2)]
    );

    const { rows } = await db.query(
      'SELECT user_id, leaderboard_eligible FROM apocalypse_results WHERE cycle_id = $1 ORDER BY user_id',
      [cyc.cycle_id]
    );
    expect(rows).toEqual([
      { user_id: 1, leaderboard_eligible: true },   // 1250 > 1000 under ITS round's rules
      { user_id: 2, leaderboard_eligible: false }
    ]);

    const board = await recentBoardFor(cyc);
    expect(board.resultCount).toBe(1);
    expect(board.results[0]).toMatchObject({ rank: 1, userId: 1, finalCash: 1250, leaderboardEligible: true });
  });

  test('settlement replay keeps eligibility stable — no reroll, no drift', async () => {
    const cycle = await settleCycleWithCash({ cashByUserId: { 1: 10000.01 } });

    const before = await recentBoardFor(cycle);
    // Replay settlement machinery: everything is a no-op on a COMPLETED cycle.
    await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
    await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
    const after = await recentBoardFor(cycle);

    expect(after.results.map((r) => [r.rank, r.userId, r.finalCash, r.leaderboardEligible]))
      .toEqual(before.results.map((r) => [r.rank, r.userId, r.finalCash, r.leaderboardEligible]));
    expect(after.results).toHaveLength(1);
  });
});
