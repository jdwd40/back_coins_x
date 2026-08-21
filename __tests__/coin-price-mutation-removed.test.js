// Milestone 1 hardening: the public app must not allow arbitrary manual
// current-price mutation. PATCH /api/coins/:coin_id/price had no legitimate
// consumer (the frontend never calls it; the market simulator and the game
// lifecycle are the only legitimate writers) so the route is REMOVED, not
// merely guarded: every caller — anonymous or authenticated ordinary player —
// gets the same 404 as any other unrouted path, and no caller-supplied price
// can ever reach the coins table. In particular a Core-3 collapsed coin can
// never be revived through the API: its £0 is written only by the game's
// collapse execution.
//
// jest.setup.js reseeds the disposable test database before every test.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const jwt = require('jsonwebtoken');
const { reconcileCycle } = require('../game/gameCycleService');
const collapseSchedule = require('../game/collapseScheduleService');

function playerToken(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET);
}

async function livePrice(coinId) {
  const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
  return parseFloat(rows[0].current_price);
}

describe('PATCH /api/coins/:coin_id/price is removed (no manual price mutation)', () => {
  test('anonymous callers get 404 and the price is untouched', async () => {
    const before = await livePrice(1);

    await request(app)
      .patch('/api/coins/1/price')
      .send({ current_price: 999999 })
      .expect(404);

    expect(await livePrice(1)).toBe(before);
  });

  test('an authenticated ordinary player gets 404 and the price is untouched', async () => {
    const before = await livePrice(1);

    await request(app)
      .patch('/api/coins/1/price')
      .set('Authorization', `Bearer ${playerToken(1)}`)
      .send({ current_price: 999999 })
      .expect(404);

    expect(await livePrice(1)).toBe(before);
  });

  test('a coin collapsed in the active cycle cannot be revived through the API', async () => {
    // Drive a real Core 1/3 collapse to execution: cycle created with the
    // window already inside the collapse schedule, then every due collapse
    // executed inside the lifecycle transaction.
    const start = new Date(Date.now() - 25 * 60 * 1000);
    await reconcileCycle({ now: start, durationMs: 30 * 60 * 1000, generateSeed: () => 'm1-collapse-seed' });
    const { rows } = await db.query(
      `SELECT coin_id FROM coin_collapse_schedule cs
       JOIN apocalypse_cycles ac ON ac.cycle_id = cs.cycle_id
       WHERE ac.status = 'ACTIVE'
       ORDER BY cs.collapse_rank
       LIMIT 1`
    );
    const victim = rows[0].coin_id;
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Execute exactly this coin's collapse the way Core 3 does.
      await client.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [victim]);
      await client.query(
        `UPDATE coin_collapse_schedule cs SET executed_at = now()
         FROM apocalypse_cycles ac
         WHERE ac.cycle_id = cs.cycle_id AND ac.status = 'ACTIVE'
           AND cs.coin_id = $1 AND cs.executed_at IS NULL`,
        [victim]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    expect(await livePrice(victim)).toBe(0);
    expect(await collapseSchedule.isCoinCollapsed(victim)).toBe(true);

    // Revival attempt via the removed endpoint — anonymous and authenticated.
    await request(app).patch(`/api/coins/${victim}/price`).send({ price: 500 }).expect(404);
    await request(app)
      .patch(`/api/coins/${victim}/price`)
      .set('Authorization', `Bearer ${playerToken(1)}`)
      .send({ price: 500 })
      .expect(404);

    expect(await livePrice(victim)).toBe(0);
  });

  test('game/simulator pricing stays authoritative: no other coins route accepts a price write', async () => {
    // Every mutating verb shaped like a price write is unrouted.
    await request(app).post('/api/coins/1/price').send({ price: 1 }).expect(404);
    await request(app).put('/api/coins/1/price').send({ price: 1 }).expect(404);
    await request(app).patch('/api/coins/1').send({ current_price: 1 }).expect(404);
    // The read model still serves the database price unchanged.
    const before = await livePrice(2);
    const res = await request(app).get('/api/coins/2').expect(200);
    expect(res.body.coin.current_price).toBe(`£${before.toFixed(2)}`);
  });
});
