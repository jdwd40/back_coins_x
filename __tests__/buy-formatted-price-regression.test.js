const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const seed = require('../db/seed');
const jwt = require('jsonwebtoken');
const coinsModel = require('../models/coins.model');

// Regression: the public coin payload formats current_price as a GBP
// display string (e.g. '£10,140.30'). The buy/sell flow must not feed
// that display string into numeric SQL parameters (PostgreSQL 22P02
// invalid input syntax) and must reject non-numeric amounts deliberately.
describe('POST /api/transactions/buy with formatted coin prices', () => {
  let testUserToken;

  beforeEach(async () => {
    await seed();
    testUserToken = jwt.sign(
      { user_id: 1 },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  afterAll(() => db.end());

  test('public coin payload formats current_price as a GBP display string (API contract)', async () => {
    const { body } = await request(app).get('/api/coins/1').expect(200);
    const coin = body.coin || body;
    expect(typeof coin.current_price).toBe('string');
    expect(coin.current_price).toMatch(/^£/);
  });

  test('model exposes an unformatted numeric coin row for transactional use', async () => {
    const raw = await coinsModel.selectCoinRawById(1);
    expect(raw).not.toBeNull();
    expect(raw.current_price).not.toMatch(/£/);
    expect(Number.isFinite(Number(raw.current_price))).toBe(true);
  });

  test('201: valid buy succeeds, debits funds and records numeric price', async () => {
    const raw = await coinsModel.selectCoinRawById(1);
    const price = Number(raw.current_price);
    const amount = 0.5;

    const fundsBefore = await db.query('SELECT funds FROM users WHERE user_id = 1');
    const before = Number(fundsBefore.rows[0].funds);

    const { body } = await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${testUserToken}`)
      .send({ user_id: 1, coin_id: 1, amount })
      .expect(201);

    expect(body.status).toBe('success');
    const tx = body.data;
    expect(tx.type).toBe('BUY');
    expect(Number(tx.quantity)).toBeCloseTo(amount, 6);
    expect(Number(tx.price)).toBeCloseTo(price, 2);
    expect(String(tx.price)).not.toMatch(/£/);
    expect(Number(tx.total_amount)).toBeCloseTo(amount * price, 2);

    const fundsAfter = await db.query('SELECT funds FROM users WHERE user_id = 1');
    expect(Number(fundsAfter.rows[0].funds)).toBeCloseTo(before - amount * price, 2);

    const portfolio = await db.query(
      'SELECT quantity FROM portfolios WHERE user_id = 1 AND coin_id = 1'
    );
    expect(Number(portfolio.rows[0].quantity)).toBeCloseTo(amount, 6);
  });

  test('400: rejects a non-numeric amount deliberately', async () => {
    const { body } = await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${testUserToken}`)
      .send({ user_id: 1, coin_id: 1, amount: 'abc' })
      .expect(400);
    expect(body.status).toBe('error');

    // No side effects: funds unchanged, no transaction recorded
    const funds = await db.query('SELECT funds FROM users WHERE user_id = 1');
    expect(Number(funds.rows[0].funds)).toBeCloseTo(1000.0, 2);
    const txs = await db.query('SELECT * FROM transactions WHERE user_id = 1');
    expect(txs.rows).toHaveLength(0);
  });

  test('400: rejects a negative amount', async () => {
    await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${testUserToken}`)
      .send({ user_id: 1, coin_id: 1, amount: -5 })
      .expect(400);
  });

  test('201 then 201: sell flow also uses the numeric price', async () => {
    await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${testUserToken}`)
      .send({ user_id: 1, coin_id: 1, amount: 0.5 })
      .expect(201);

    const { body } = await request(app)
      .post('/api/transactions/sell')
      .set('Authorization', `Bearer ${testUserToken}`)
      .send({ user_id: 1, coin_id: 1, amount: 0.2 })
      .expect(201);
    expect(body.status).toBe('success');
    expect(String(body.data.price)).not.toMatch(/£/);
  });
});
