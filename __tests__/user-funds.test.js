// Persistent-market product rule: ordinary-player self-funding is retired.
// This suite pins the retired behaviour of PATCH /api/users/:user_id/funds:
// authentication is still required, and every authenticated ordinary player
// (owner included) receives a uniform 403 with legacy funds untouched.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const jwt = require('jsonwebtoken');
const seed = require('../db/seed');

describe('User Funds Management (self-funding retired)', () => {
  let testUser;
  let authToken;

  beforeEach(async () => {
    // Create a test user (jest.setup.js seeds before each test)
    const userResult = await db.query(
      'INSERT INTO users (username, email, password_hash, funds) VALUES ($1, $2, $3, $4) RETURNING *',
      ['testuser', 'test@example.com', 'hashedpassword', 1000.00]
    );
    testUser = userResult.rows[0];

    // Create auth token for the test user
    authToken = jwt.sign(
      { user_id: testUser.user_id, username: testUser.username },
      process.env.JWT_SECRET
    );
  });

  afterAll(async () => {
    await db.end();
  });

  describe('PATCH /api/users/:user_id/funds', () => {
    test('rejects a credit attempt with 403 and leaves funds unchanged', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ amount: 500 });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.msg).toBe('Self-funding is retired: funds are managed by the game economy');

      const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [testUser.user_id]);
      expect(parseFloat(rows[0].funds)).toBe(1000.00);
    });

    test('rejects a debit attempt with 403 and leaves funds unchanged', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ amount: -200 });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);

      const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [testUser.user_id]);
      expect(parseFloat(rows[0].funds)).toBe(1000.00);
    });

    test('rejects invalid amount formats with the same retired-product 403', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ amount: 'invalid' });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    test('rejects an invalid user id with 400', async () => {
      const response = await request(app)
        .patch('/api/users/not-a-number/funds')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ amount: 100 });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.msg).toBe('Invalid user ID');
    });

    test('should require authentication', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .send({ amount: 100 });

      expect(response.status).toBe(401);
    });
  });
});
