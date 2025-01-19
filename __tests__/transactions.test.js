const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const seed = require('../db/seed');
const jwt = require('jsonwebtoken');

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

  describe('POST /api/transactions', () => {
    test('201: creates a new buy transaction', () => {
      const newTransaction = {
        user_id: 1,
        coin_id: 1,
        type: 'BUY',
        amount: 0.5,
        price_at_transaction: 50000.00
      };

      return request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(newTransaction)
        .expect(201)
        .then(({ body }) => {
          expect(body.transaction).toMatchObject({
            transaction_id: expect.any(Number),
            user_id: 1,
            coin_id: 1,
            type: 'BUY',
            quantity: '0.50',
            price: '50000.00',
            total_amount: '25000.00',
            created_at: expect.any(String)
          });
        });
    });

    test('201: creates a new sell transaction', () => {
      // First create a buy transaction
      const buyTransaction = {
        user_id: 1,
        coin_id: 1,
        type: 'BUY',
        amount: 1.0,
        price_at_transaction: 50000.00
      };

      return request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(buyTransaction)
        .then(() => {
          // Then create a sell transaction
          const sellTransaction = {
            user_id: 1,
            coin_id: 1,
            type: 'SELL',
            amount: 0.5,
            price_at_transaction: 55000.00
          };

          return request(app)
            .post('/api/transactions')
            .set('Authorization', `Bearer ${testUserToken}`)
            .send(sellTransaction)
            .expect(201)
            .then(({ body }) => {
              expect(body.transaction).toMatchObject({
                transaction_id: expect.any(Number),
                user_id: 1,
                coin_id: 1,
                type: 'SELL',
                quantity: '0.50',
                price: '55000.00',
                total_amount: '27500.00',
                created_at: expect.any(String)
              });
            });
        });
    });

    test('400: returns error when trying to sell more than owned', () => {
      const sellTransaction = {
        user_id: 1,
        coin_id: 1,
        type: 'SELL',
        amount: 1.0,
        price_at_transaction: 50000.00
      };

      return request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(sellTransaction)
        .expect(400)
        .then(({ body }) => {
          expect(body.msg).toBe('Insufficient balance for this transaction');
        });
    });

    test('400: returns error when required fields are missing', () => {
      const invalidTransaction = {
        user_id: 1,
        coin_id: 1
        // missing type, amount, and price
      };

      return request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(invalidTransaction)
        .expect(400)
        .then(({ body }) => {
          expect(body.msg).toBe('Missing required fields');
        });
    });

    test('401: returns unauthorized when no token provided', () => {
      const transaction = {
        user_id: 1,
        coin_id: 1,
        type: 'BUY',
        amount: 0.5,
        price_at_transaction: 50000.00
      };

      return request(app)
        .post('/api/transactions')
        .send(transaction)
        .expect(401)
        .then(({ body }) => {
          expect(body.msg).toBe('Authentication required');
        });
    });
  });

  describe('GET /api/transactions/user/:user_id', () => {
    test('200: returns all transactions for a user', async () => {
      // First create some transactions
      const transaction1 = {
        user_id: 1,
        coin_id: 1,
        type: 'BUY',
        amount: 1.0,
        price_at_transaction: 50000.00
      };

      await request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(transaction1);

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
      // First create some transactions
      const transaction1 = {
        user_id: 1,
        coin_id: 1,
        type: 'BUY',
        amount: 1.0,
        price_at_transaction: 50000.00
      };

      await request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send(transaction1);

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
