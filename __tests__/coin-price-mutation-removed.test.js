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
const dynamicCollapseService = require('../game/dynamicCollapseService');

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
    // Drive a real Core 1/dynamic-collapse death to execution: cycle
    // created, then the market crashed and reconciled until the engine
    // kills a coin inside the lifecycle transaction.
    const start = new Date(Date.now() - 25 * 60 * 1000);
    const durationMs = 30 * 60 * 1000;
    const cycle = await reconcileCycle({ now: start, durationMs, generateSeed: () => 'm1-collapse-seed' });
    await db.query('UPDATE coins SET current_price = GREATEST(0.0001, current_price * 0.0001)');
    // Fractions of the PERSISTED window (creation may have aligned the
    // start to a half-hour boundary).
    const startMs = new Date(cycle.start_time).getTime();
    const endMs = new Date(cycle.end_time).getTime();
    const at = (fraction) => new Date(startMs + (endMs - startMs) * fraction);
    await reconcileCycle({ now: at(0.56) });
    await reconcileCycle({ now: at(0.71) });
    await reconcileCycle({ now: at(0.72) });
    let victim = null;
    for (let p = 0.73; p < 1 && victim === null; p += 0.02) {
      await reconcileCycle({ now: at(p) });
      const { rows } = await db.query(
        'SELECT coin_id FROM apocalypse_coin_collapses WHERE cycle_id = $1 ORDER BY collapse_rank LIMIT 1',
        [cycle.cycle_id]
      );
      if (rows.length > 0) victim = rows[0].coin_id;
    }
    expect(victim).not.toBeNull();
    expect(await livePrice(victim)).toBe(0);
    expect(await dynamicCollapseService.isCoinCollapsed(victim)).toBe(true);

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
