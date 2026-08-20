// Core 3 trade guard: the existing buy/sell path gets one narrow protection —
// a new purchase of a currently dead (collapsed) coin is rejected with a clear
// domain error — and a sale of a dead holding can never create cash, because
// the dead coin's live price is exactly £0. Everything else about the
// transaction/portfolio behaviour is unchanged.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');

const DURATION_MS = 30 * 60 * 1000;
const WINDOW_START_MS = new Date('2026-08-20T10:00:00.000Z').getTime() + DURATION_MS * 0.70;

async function userFunds(userId) {
  const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [userId]);
  return parseFloat(rows[0].funds);
}

// Create the cycle, identify the first scheduled coin, and collapse it for real.
async function collapseFirstCoin() {
  const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
  const { rows } = await db.query(
    'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
    [cycle.cycle_id]
  );
  await reconcileCycle({ now: new Date(WINDOW_START_MS) });
  return rows[0].coin_id;
}

describe('Core 3: collapsed-coin trade guard', () => {
  let token;

  beforeEach(() => {
    token = jwt.sign({ user_id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  test('POST /api/transactions/buy rejects purchasing a collapsed coin with a clear domain error', async () => {
    const deadCoinId = await collapseFirstCoin();
    const fundsBefore = await userFunds(1);

    const response = await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: 1, coin_id: deadCoinId, amount: 1 })
      .expect(400);

    expect(response.body.status).toBe('error');
    expect(response.body.message).toMatch(/collapsed to £0/);

    // No transaction recorded, no funds moved, no portfolio entry created.
    const { rows: txs } = await db.query(
      'SELECT count(*)::int AS n FROM transactions WHERE user_id = 1 AND coin_id = $1',
      [deadCoinId]
    );
    expect(txs[0].n).toBe(0);
    expect(await userFunds(1)).toBe(fundsBefore);
    const { rows: pf } = await db.query(
      'SELECT count(*)::int AS n FROM portfolios WHERE user_id = 1 AND coin_id = $1',
      [deadCoinId]
    );
    expect(pf[0].n).toBe(0);
  });

  test('POST /api/transactions/buy still works for a surviving coin (regression)', async () => {
    const deadCoinId = await collapseFirstCoin();
    const { rows } = await db.query('SELECT coin_id FROM coins WHERE coin_id <> $1 ORDER BY coin_id LIMIT 1', [deadCoinId]);
    const liveCoinId = rows[0].coin_id;
    const fundsBefore = await userFunds(1);

    const response = await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: 1, coin_id: liveCoinId, amount: 0.5 })
      .expect(201);

    expect(response.body.status).toBe('success');
    expect(await userFunds(1)).toBeLessThan(fundsBefore);
  });

  test('selling a dead holding cannot create cash: the £0 sale moves exactly £0', async () => {
    // Buy the coin while it is alive.
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    const { rows } = await db.query(
      'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
      [cycle.cycle_id]
    );
    const coinId = rows[0].coin_id;

    await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: 1, coin_id: coinId, amount: 2 })
      .expect(201);

    // The coin collapses while held.
    await reconcileCycle({ now: new Date(WINDOW_START_MS) });
    const fundsAfterCollapse = await userFunds(1);

    const response = await request(app)
      .post('/api/transactions/sell')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: 1, coin_id: coinId, amount: 2 })
      .expect(201);

    expect(response.body.status).toBe('success');
    expect(response.body.data.total_amount).toBe('0.00');
    // Funds are exactly unchanged by the sale: no cash was created.
    expect(await userFunds(1)).toBe(fundsAfterCollapse);
  });

  test('selling a live holding still credits funds normally (regression)', async () => {
    const { rows } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id LIMIT 1');
    const coin = rows[0];

    await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: 1, coin_id: coin.coin_id, amount: 1 })
      .expect(201);
    const fundsAfterBuy = await userFunds(1);

    const response = await request(app)
      .post('/api/transactions/sell')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: 1, coin_id: coin.coin_id, amount: 1 })
      .expect(201);

    expect(response.body.status).toBe('success');
    expect(parseFloat(response.body.data.total_amount)).toBeCloseTo(parseFloat(coin.current_price), 2);
    expect(await userFunds(1)).toBeCloseTo(fundsAfterBuy + parseFloat(coin.current_price), 2);
  });
});
