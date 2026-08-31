// Crypto Chaos Core 6: public leaderboard / results APIs.
//
//   GET /api/game/leaderboard          — live active-cycle board (public)
//   GET /api/game/results/:cycleId     — immutable completed-cycle snapshot
//   GET /api/game/leaderboards/recent  — recent completed cycles (bounded)
//
// Proves: public read access (no token), reconcile-then-read, Core 4 live
// wealth semantics (cash + live holdings value, collapsed holdings £0), the
// documented sort (wealth DESC, participant_id ASC) with live ranks, no
// seed/future-collapse leakage, clear 404/400/409 rejections for the results
// endpoint, snapshot reads that never recalculate from mutable state, and
// limit validation/clamping that never deletes history.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');
const settlementService = require('../game/gameSettlementService');
const botService = require('../game/botService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

// API tests run at the real wall clock, which may sit inside the collapse
// window of a default 30-minute cycle. A 7-day cycle keeps every coin alive.
const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const SHORT_DURATION_MS = 60 * 1000;

async function liveCycle() {
  return reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
}

// Settle the CURRENT active cycle completely: create (or adopt) it at the
// real now, let the given users join, optionally set per-user current cash
// (issue #19: profitability decides leaderboard presence), shift its window
// into the past (the end_time > start_time CHECK still holds), then
// reconcile at the real now to settle it and chain a long-lived successor.
async function completedCycle({ join = [], setCash = {} } = {}) {
  const now = new Date();
  const cycle = await reconcileCycle({ now, durationMs: SHORT_DURATION_MS });
  for (const userId of join) {
    await gameRoundService.joinRound({ userId, now });
  }
  for (const [userId, cash] of Object.entries(setCash)) {
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
}

describe('Core 6: leaderboard and results APIs', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  describe('GET /api/game/leaderboard', () => {
    test('is public and reports the live active cycle with Core 4 wealth semantics and live ranks', async () => {
      const cycle = await liveCycle();
      await gameRoundService.joinRound({ userId: 1, now: new Date() });
      await gameRoundService.joinRound({ userId: 2, now: new Date() });

      const { rows: coinRows } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id LIMIT 1');
      const coin = coinRows[0];
      const price = parseFloat(coin.current_price);
      await gameRoundService.buyRoundTrade({
        userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 10, now: new Date()
      });

      const response = await request(app).get('/api/game/leaderboard').expect(200);
      const board = response.body.data;
      expect(board.cycleId).toBe(cycle.apocalypse_id);
      expect(board.status).toBe('ACTIVE');
      expect(typeof board.apocalypsePercent).toBe('number');
      expect(board.entries).toHaveLength(2);

      // Both entries carry the full public field set.
      for (const entry of board.entries) {
        expect(entry).toMatchObject({
          rank: expect.any(Number),
          participantId: expect.any(Number),
          username: expect.any(String),
          isBot: expect.any(Boolean),
          joinedAt: expect.any(String),
          currentCash: expect.any(Number),
          currentWealth: expect.any(Number),
          peakWealth: expect.any(Number)
        });
        expect('personality' in entry).toBe(true);
      }

      // Live wealth = cash + live holdings value (buy moved cash into coin).
      const buyer = board.entries.find((e) => e.username === 'john_doe');
      const holder = board.entries.find((e) => e.username === 'jane_smith');
      expect(buyer.currentCash).toBeCloseTo(10000 - Math.round(10 * price * 100) / 100, 2);
      expect(buyer.currentWealth).toBeCloseTo(10000, 2);
      expect(holder.currentWealth).toBe(10000);

      // Tie on wealth: participant_id ASC decides; ranks are 1,2.
      expect(board.entries.map((e) => e.rank)).toEqual([1, 2]);
      expect(board.entries[0].participantId).toBeLessThan(board.entries[1].participantId);

      // No private/forward-looking data: no seed, no collapse schedule.
      expect(JSON.stringify(response.body)).not.toMatch(/seed|scheduled_at|collapse_rank/i);
    });

    test('collapsed holdings contribute exactly £0 to live wealth', async () => {
      const cycle = await liveCycle();
      await gameRoundService.joinRound({ userId: 1, now: new Date() });
      const { rows: coinRows } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id LIMIT 1');
      const coin = coinRows[0];
      await gameRoundService.buyRoundTrade({
        userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 10, now: new Date()
      });

      // A persisted dynamic collapse execution makes the coin publicly dead
      // and its authoritative live price exactly £0.
      await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [coin.coin_id]);
      await db.query(
        `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
         VALUES ($1, $2, 0, now())`,
        [cycle.cycle_id, coin.coin_id]
      );

      const response = await request(app).get('/api/game/leaderboard').expect(200);
      const entry = response.body.data.entries.find((e) => e.username === 'john_doe');
      expect(entry.currentWealth).toBeCloseTo(entry.currentCash, 2);
      expect(entry.currentWealth).toBeLessThan(10000);
    });

    test('bots appear with isBot and personality on the live board', async () => {
      await liveCycle();
      const roster = await botService.ensureBotsProvisioned();
      await gameRoundService.joinRound({ userId: roster[0].userId, now: new Date() });

      const response = await request(app).get('/api/game/leaderboard').expect(200);
      const botEntry = response.body.data.entries.find((e) => e.isBot === true);
      expect(botEntry).toBeTruthy();
      expect(botEntry.personality).toBe(roster[0].strategy);
    });

    test('a failing settlement leaves no live board (409) and recovery restores it', async () => {
      const cycle = await liveCycle();
      await gameRoundService.joinRound({ userId: 1, now: new Date() });

      // Expire the cycle (shift the whole window into the past so the
      // end_time > start_time CHECK still holds), then freeze into SETTLING.
      await db.query(
        `UPDATE apocalypse_cycles
         SET start_time = now() - interval '2 minutes', end_time = now() - interval '1 second'
         WHERE cycle_id = $1`,
        [cycle.cycle_id]
      );
      await settlementService.freezeExpiredActiveCycle({ nowMs: Date.now() });

      // Settlement keeps failing: the board must clearly say so, never serve
      // stale data, and the cycle must stay observably SETTLING.
      const spy = jest.spyOn(settlementService, 'settleSettlingCycle')
        .mockRejectedValue(new Error('injected settlement failure'));
      try {
        const response = await request(app).get('/api/game/leaderboard').expect(409);
        expect(response.body.message).toMatch(/settling/i);
        const { rows } = await db.query(`SELECT status FROM apocalypse_cycles WHERE cycle_id = $1`, [cycle.cycle_id]);
        expect(rows[0].status).toBe('SETTLING');
      } finally {
        spy.mockRestore();
      }

      // Recovery: the next read settles and serves the successor's board.
      const recovered = await request(app).get('/api/game/leaderboard').expect(200);
      expect(recovered.body.data.status).toBe('ACTIVE');
      expect(recovered.body.data.cycleId).not.toBe(cycle.apocalypse_id);
    });
  });

  describe('GET /api/game/results/:cycleId', () => {
    test('serves the immutable snapshot sorted by rank for a completed cycle', async () => {
      const cycle = await completedCycle({ join: [1, 2] });

      const response = await request(app).get(`/api/game/results/${cycle.apocalypse_id}`).expect(200);
      const data = response.body.data;
      expect(data.cycleId).toBe(cycle.apocalypse_id);
      expect(data.status).toBe('COMPLETED');
      expect(data.settledAt).not.toBeNull();
      expect(data.resultCount).toBe(2);
      expect(data.results.map((r) => r.rank)).toEqual([1, 2]);
      for (const row of data.results) {
        expect(row).toMatchObject({
          participantId: expect.any(Number),
          username: expect.any(String),
          isBot: expect.any(Boolean),
          finalCash: expect.any(Number),
          peakWealth: expect.any(Number),
          startingCash: 10000,
          netProfit: expect.any(Number),
          joinedAt: expect.any(String),
          tradeCount: expect.any(Number),
          buyCount: expect.any(Number),
          sellCount: expect.any(Number)
        });
        expect(row.netProfit).toBeCloseTo(row.finalCash - row.startingCash, 2);
      }
      expect(JSON.stringify(response.body)).not.toMatch(/seed|scheduled_at|collapse_rank/i);
    });

    test('never recalculates from mutable state: later participant edits cannot change served results', async () => {
      const cycle = await completedCycle({ join: [1] });
      const before = (await request(app).get(`/api/game/results/${cycle.apocalypse_id}`).expect(200)).body.data;

      // Tamper with the mutable participant row after completion.
      await db.query(
        `UPDATE apocalypse_participants SET current_cash = 0.01, peak_wealth = 0.01 WHERE cycle_id = $1`,
        [cycle.cycle_id]
      );

      const after = (await request(app).get(`/api/game/results/${cycle.apocalypse_id}`).expect(200)).body.data;
      expect(after.results[0].finalCash).toBe(before.results[0].finalCash);
      expect(after.results[0].peakWealth).toBe(before.results[0].peakWealth);
      expect(after.results[0].finalCash).toBe(10000);
    });

    test('clearly rejects ACTIVE and SETTLING cycles (409), unknown (404) and malformed (400) ids', async () => {
      const active = await liveCycle();

      const activeRes = await request(app).get(`/api/game/results/${active.apocalypse_id}`).expect(409);
      expect(activeRes.body.message).toMatch(/not COMPLETED/);

      // Freeze it into SETTLING: still a clear 409, never a fabricated result.
      await db.query(
        `UPDATE apocalypse_cycles
         SET start_time = now() - interval '2 minutes', end_time = now() - interval '1 second'
         WHERE cycle_id = $1`,
        [active.cycle_id]
      );
      await settlementService.freezeExpiredActiveCycle({ nowMs: Date.now() });
      const settlingRes = await request(app).get(`/api/game/results/${active.apocalypse_id}`).expect(409);
      expect(settlingRes.body.message).toMatch(/SETTLING/);

      await request(app).get('/api/game/results/APOC-9999').expect(404);
      await request(app).get('/api/game/results/not-a-cycle').expect(400);
    });
  });

  describe('GET /api/game/leaderboards/recent', () => {
    test('returns recent completed cycles newest-first with PROFITABLE-ONLY snapshots, bounded by the default limit', async () => {
      // Issue #19: only finishes above the £10,000 starting cash appear.
      // Cycle 1: john_doe profits (£10,500); jane_smith breaks even.
      // Cycle 2: jane_smith profits (£12,000); john_doe loses.
      const first = await completedCycle({ join: [1], setCash: { 1: 10500 } });
      const second = await completedCycle({ join: [2], setCash: { 2: 12000 } });

      const response = await request(app).get('/api/game/leaderboards/recent').expect(200);
      const data = response.body.data;
      expect(data.limit).toBe(5); // documented default
      expect(data.count).toBe(2);
      expect(data.leaderboards.map((b) => b.cycleId)).toEqual([second.apocalypse_id, first.apocalypse_id]);
      // Each board shows only its qualifying player, ranked 1, while the
      // full participant count stays visible via totalResultCount.
      expect(data.leaderboards[0].resultCount).toBe(1);
      expect(data.leaderboards[0].totalResultCount).toBe(2);
      expect(data.leaderboards[0].results[0]).toMatchObject({ rank: 1, username: 'jane_smith', finalCash: 12000, leaderboardEligible: true });
      expect(data.leaderboards[1].results[0]).toMatchObject({ rank: 1, username: 'john_doe', finalCash: 10500, leaderboardEligible: true });
    });

    test('limit is validated and clamped, and never deletes history', async () => {
      await completedCycle({ join: [1] });
      await completedCycle({ join: [] });

      await request(app).get('/api/game/leaderboards/recent?limit=abc').expect(400);

      const clampedLow = await request(app).get('/api/game/leaderboards/recent?limit=0').expect(200);
      expect(clampedLow.body.data.limit).toBe(1);
      expect(clampedLow.body.data.count).toBe(1);

      const clampedHigh = await request(app).get('/api/game/leaderboards/recent?limit=999').expect(200);
      expect(clampedHigh.body.data.limit).toBe(25);
      expect(clampedHigh.body.data.count).toBe(2);

      // The limit bounded the READ only: both completed cycles persist.
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'COMPLETED'`);
      expect(rows[0].n).toBe(2);
    });

    test('completed cycles with no qualifying players appear with an empty snapshot', async () => {
      // Issue #19: everyone settled at exactly the £10,000 break-even —
      // nobody qualifies, and an empty leaderboard is a legitimate result.
      await completedCycle({ join: [] });
      const response = await request(app).get('/api/game/leaderboards/recent').expect(200);
      expect(response.body.data.count).toBe(1);
      expect(response.body.data.leaderboards[0].resultCount).toBe(0);
      expect(response.body.data.leaderboards[0].totalResultCount).toBe(2); // both auto-initialized users preserved
      expect(response.body.data.leaderboards[0].results).toEqual([]);
    });
  });
});
