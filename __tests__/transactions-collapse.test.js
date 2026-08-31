// SIM-13/14 trade guard (adapted from the retired fixed schedule's Core 3
// suite): the existing buy/sell path gets one narrow protection — a new
// purchase of a currently dead (collapsed) coin is rejected with a clear
// domain error — and a sale of a dead holding can never create cash,
// because the dead coin's live price is exactly £0. Everything else about
// the transaction/portfolio behaviour is unchanged. Deaths are produced
// for real by the dynamic collapse engine through the Core 1 lifecycle.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');

jest.setTimeout(30000);

const CYCLE_START = new Date('2026-08-20T10:00:00.000Z');
const DURATION_MS = 30 * 60 * 1000;

function at(fraction) {
  return new Date(CYCLE_START.getTime() + DURATION_MS * fraction);
}

async function userFunds(userId) {
  const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [userId]);
  return parseFloat(rows[0].funds);
}

// Create the cycle, crash the market, and reconcile until the dynamic
// engine has executed at least one death for real.
async function collapseOneCoin() {
  const cycle = await reconcileCycle({ now: at(0.05), durationMs: DURATION_MS, generateSeed: () => 'trade-guard-collapse-seed' });
  await db.query('UPDATE coins SET current_price = GREATEST(0.0001, current_price * 0.0001)');
  await reconcileCycle({ now: at(0.56) });
  await reconcileCycle({ now: at(0.71) });
  await reconcileCycle({ now: at(0.72) });
  for (let p = 0.73; p < 1; p += 0.02) {
    await reconcileCycle({ now: at(p) });
    const { rows } = await db.query(
      'SELECT coin_id FROM apocalypse_coin_collapses WHERE cycle_id = $1 ORDER BY collapse_rank LIMIT 1',
      [cycle.cycle_id]
    );
    if (rows.length > 0) return rows[0].coin_id;
  }
  throw new Error('dynamic collapse engine produced no deaths for a crashed market');
}

describe('SIM-13/14: collapsed-coin trade guard (dynamic collapse)', () => {
  let token;

  beforeEach(() => {
    token = jwt.sign({ user_id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  test('POST /api/transactions/buy rejects purchasing a collapsed coin with a clear domain error', async () => {
    const deadCoinId = await collapseOneCoin();
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
    const deadCoinId = await collapseOneCoin();
    const { rows } = await db.query('SELECT coin_id FROM coins WHERE coin_id <> $1 ORDER BY coin_id LIMIT 1', [deadCoinId]);
    const liveCoinId = rows[0].coin_id;
    // Give the survivor a sane price (the crash took it to fractions of a
    // penny; the regression is about the buy path, not the price level).
    await db.query('UPDATE coins SET current_price = 10.00 WHERE coin_id = $1', [liveCoinId]);
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
    // Buy a small amount of every coin while everything is alive, so
    // whichever coin the dynamic engine kills first is held.
    const cycle = await reconcileCycle({ now: at(0.05), durationMs: DURATION_MS, generateSeed: () => 'trade-guard-collapse-seed' });
    const { rows: allCoins } = await db.query('SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id');
    for (const coin of allCoins) {
      await request(app)
        .post('/api/transactions/buy')
        .set('Authorization', `Bearer ${token}`)
        .send({ user_id: 1, coin_id: coin.coin_id, amount: 0.5 })
        .expect(201);
    }

    // The market crashes and the dynamic engine executes a real death.
    await db.query('UPDATE coins SET current_price = GREATEST(0.0001, current_price * 0.0001)');
    await reconcileCycle({ now: at(0.56) });
    await reconcileCycle({ now: at(0.71) });
    await reconcileCycle({ now: at(0.72) });
    let coinId = null;
    for (let p = 0.73; p < 1 && coinId === null; p += 0.02) {
      await reconcileCycle({ now: at(p) });
      const { rows } = await db.query(
        'SELECT coin_id FROM apocalypse_coin_collapses WHERE cycle_id = $1 ORDER BY collapse_rank LIMIT 1',
        [cycle.cycle_id]
      );
      if (rows.length > 0) coinId = rows[0].coin_id;
    }
    expect(coinId).not.toBeNull();
    const fundsAfterCollapse = await userFunds(1);

    const response = await request(app)
      .post('/api/transactions/sell')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: 1, coin_id: coinId, amount: 0.5 })
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
