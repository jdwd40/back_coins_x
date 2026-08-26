const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const seed = require('../db/seed');
const jwt = require('jsonwebtoken');

// V2 legacy cleanup (#22): the root POST /api/transactions mutation is
// removed. It trusted caller-supplied price_at_transaction and inserted a
// ledger row with no authoritative funds/portfolio mutation, so an
// authenticated caller could create phantom financial state. These suites
// assert the route is unavailable and seed the useful read/portfolio
// endpoints through explicit isolated SQL fixtures (the only legitimate
// write paths that remain are the atomic /buy and /sell endpoints).

describe('Transactions API', () => {
  let testUserToken;
  let testUser2Token;

  beforeEach(async () => {
    await seed();
    // Create tokens for test users
    testUserToken = jwt.sign(
      { user_id: 1 }, // john_doe's user_id
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    testUser2Token = jwt.sign(
      { user_id: 2 }, // jane_smith's user_id
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  describe('POST /api/transactions (legacy root mutation removed)', () => {
    const legacyBuyPayload = {
      user_id: 1,
      coin_id: 1,
      type: 'BUY',
      amount: 0.5,
      price_at_transaction: 50000.00
    };

    test('404: an authenticated caller cannot create a transaction through the removed root mutation', async () => {
      const before = await db.query('SELECT count(*)::int AS n FROM transactions');

      await request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(legacyBuyPayload)
        .expect(404);

      const after = await db.query('SELECT count(*)::int AS n FROM transactions');
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    test('404: a caller-priced SELL attempt against the removed route also fails and writes nothing', async () => {
      const before = await db.query('SELECT count(*)::int AS n FROM transactions');

      await request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          user_id: 1,
          coin_id: 1,
          type: 'SELL',
          amount: 0.5,
          price_at_transaction: 55000.00
        })
        .expect(404);

      const after = await db.query('SELECT count(*)::int AS n FROM transactions');
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    test('401: anonymous callers are still rejected at the router boundary', () => {
      return request(app)
        .post('/api/transactions')
        .send(legacyBuyPayload)
        .expect(401)
        .then(({ body }) => {
          expect(body.msg).toBe('Authentication required');
        });
    });
  });

  describe('GET /api/transactions/user/:user_id', () => {
    test('200: returns all transactions for a user', async () => {
      // Seed via an explicit isolated fixture row (the legacy public root
      // mutation that used to seed this test no longer exists).
      await db.query(
        `INSERT INTO transactions (user_id, coin_id, type, quantity, price, total_amount)
         VALUES ($1, $2, 'BUY', $3, $4, $5)`,
        [1, 1, 1.0, 50000, 50000]
      );

      return request(app)
        .get('/api/transactions/user/1')
        .set('Authorization', `Bearer ${testUserToken}`)
        .expect(200)
        .then(({ body }) => {
          expect(Array.isArray(body.transactions)).toBe(true);
          expect(body.transactions.length).toBeGreaterThan(0);
          expect(body.transactions[0]).toMatchObject({
            transaction_id: expect.any(Number),
            user_id: 1,
            coin_id: expect.any(Number),
            type: expect.any(String),
            quantity: expect.any(String),
            price: expect.any(String),
            total_amount: expect.any(String),
            created_at: expect.any(String),
            coin_name: expect.any(String),
            symbol: expect.any(String)
          });
        });
    });

    test('401: returns unauthorized when trying to view another user\'s transactions', () => {
      return request(app)
        .get('/api/transactions/user/2')
        .set('Authorization', `Bearer ${testUserToken}`)
        .expect(401)
        .then(({ body }) => {
          expect(body.msg).toBe('Unauthorized');
        });
    });
  });

  describe('GET /api/transactions/portfolio/:user_id', () => {
    test('200: returns user portfolio', async () => {
      // Explicit isolated fixture row, as above.
      await db.query(
        `INSERT INTO transactions (user_id, coin_id, type, quantity, price, total_amount)
         VALUES ($1, $2, 'BUY', $3, $4, $5)`,
        [1, 1, 1.0, 50000, 50000]
      );

      return request(app)
        .get('/api/transactions/portfolio/1')
        .set('Authorization', `Bearer ${testUserToken}`)
        .expect(200)
        .then(({ body }) => {
          expect(Array.isArray(body.portfolio)).toBe(true);
          expect(body.portfolio.length).toBeGreaterThan(0);
          expect(body.portfolio[0]).toMatchObject({
            coin_id: expect.any(Number),
            name: expect.any(String),
            symbol: expect.any(String),
            current_price: expect.any(String),
            total_amount: expect.any(String),
            total_invested: expect.any(String)
          });
        });
    });

    test('401: returns unauthorized when trying to view another user\'s portfolio', () => {
      return request(app)
        .get('/api/transactions/portfolio/2')
        .set('Authorization', `Bearer ${testUserToken}`)
        .expect(401)
        .then(({ body }) => {
          expect(body.msg).toBe('Unauthorized');
        });
    });
  });
});
