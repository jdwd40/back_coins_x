// Coin retirement (migration 014) behavioural coverage.
//
// A retired coin is preserved history, not catalogue: it must disappear
// from the player-facing catalogue, new-cycle collapse schedules, bot
// market state and every buy path — while its row, detail endpoint, price
// history and any existing holdings stay readable and sellable.
//
// The seeded disposable database carries only the canonical active 10, so
// each test materialises its own retired row (coin_id 100) plus an active
// non-canonical control (coin_id 101) where needed.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { createScheduleForCycle } = require('../game/collapseScheduleService');
const { buildPublicMarketState } = require('../game/botService');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound, buyRoundTrade } = require('../game/gameRoundService');

const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function insertRetiredCoin() {
  await db.query(
    `INSERT INTO coins (coin_id, name, symbol, current_price, market_cap, circulating_supply, founder, cycle_baseline_price, retired)
     VALUES (100, 'HashAd', 'HAD', 50.00, 500000.00, 10000, 'Legacy Founder', 50.00, TRUE)`
  );
  await db.query(
    `INSERT INTO price_history (coin_id, price, created_at) VALUES (100, 49.50, now() - interval '5 minutes')`
  );
}

describe('coin retirement (migration 014)', () => {
  test('GET /api/coins excludes retired coins and still exposes exactly the canonical 10', async () => {
    await insertRetiredCoin();
    const res = await request(app).get('/api/coins');
    expect(res.status).toBe(200);
    const coins = res.body.coins;
    expect(coins).toHaveLength(10);
    expect(coins.some((c) => c.symbol === 'HAD' || c.coin_id === 100)).toBe(false);
    expect(coins.find((c) => c.coin_id === 8)).toMatchObject({ name: 'JD Coin', symbol: 'JDC' });
  });

  test('GET /api/coins/:coin_id still resolves a retired coin (history stays readable)', async () => {
    await insertRetiredCoin();
    const res = await request(app).get('/api/coins/100');
    expect(res.status).toBe(200);
    expect(res.body.coin).toMatchObject({ coin_id: 100, name: 'HashAd', symbol: 'HAD', retired: true });
  });

  test('legacy buy of a retired coin is rejected with 400', async () => {
    await insertRetiredCoin();
    const res = await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ user_id: 1, coin_id: 100, amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/retired/i);
  });

  test('game buy of a retired coin is rejected; the buy is never written', async () => {
    await insertRetiredCoin();
    const cycle = await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
    const participant = await joinRound({ userId: 1, now: new Date() });

    await expect(
      buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 100, quantity: 1, now: new Date() })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/retired/i) });

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1',
      [participant.participantId]
    );
    expect(rows[0].n).toBe(0);
  });

  test('a new cycle collapse schedule covers only the active catalogue', async () => {
    await insertRetiredCoin();
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
         VALUES ('APOC-9001', 'retirement-schedule-seed', now(), now() + interval '7 days', $1, 'ACTIVE')`,
        [LONG_DURATION_MS]
      );
      const { rows: cycleRows } = await client.query(
        `SELECT cycle_id, seed, start_time, end_time FROM apocalypse_cycles WHERE apocalypse_id = 'APOC-9001'`
      );
      const schedule = await createScheduleForCycle(client, cycleRows[0]);
      await client.query('COMMIT');

      expect(schedule).toHaveLength(10);
      expect(schedule.some((r) => r.coin_id === 100)).toBe(false);
    } finally {
      client.release();
    }
  });

  test('bot public market state excludes retired coins', async () => {
    await insertRetiredCoin();
    const state = await buildPublicMarketState({
      cycle: {
        cycle_id: 0, // no schedule rows: nothing reads as collapsed
        start_time: new Date(Date.now() - 60000),
        end_time: new Date(Date.now() + LONG_DURATION_MS),
        duration_ms: LONG_DURATION_MS
      },
      participant: { currentCash: 1000, holdings: [] }
    });
    expect(state.coins).toHaveLength(10);
    expect(state.coins.some((c) => c.coinId === 100)).toBe(false);
  });

  test('verifier tolerates retired extras but flags a non-retired extra as player-facing', async () => {
    await insertRetiredCoin();
    const clean = await verifyGameSchema();
    expect(clean.problems).toEqual([]);

    await db.query(
      `INSERT INTO coins (coin_id, name, symbol, current_price, market_cap, circulating_supply, founder, cycle_baseline_price, retired)
       VALUES (101, 'StowawayCoin', 'STW', 10.00, 100000.00, 10000, 'Mystery', 10.00, FALSE)`
    );
    const flagged = await verifyGameSchema();
    expect(flagged.ok).toBe(false);
    expect(flagged.problems.join(' ')).toMatch(/non-canonical coin row\(s\) are not retired/);
    expect(flagged.problems.join(' ')).toMatch(/101:StowawayCoin\/STW/);
  });
});
