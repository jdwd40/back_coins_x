const request = require('supertest');
const app = require('../app');
const { db } = require('../db/connection');
const jwt = require('jsonwebtoken');

describe('User Funds Management', () => {
  let testUser;
  let authToken;

  beforeAll(async () => {
    // Create a test user
    const userResult = await db.query(
      'INSERT INTO Users (username, email, password_hash, funds) VALUES ($1, $2, $3, $4) RETURNING *',
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
    // Clean up test user
    await db.query('DELETE FROM Users WHERE user_id = $1', [testUser.user_id]);
    await db.end();
  });

  describe('PATCH /api/users/:user_id/funds', () => {
    test('should successfully add funds to user account', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ amount: 500 });

      expect(response.status).toBe(200);
      expect(response.body.funds).toBe('1500.00');
      expect(response.body.user_id).toBe(testUser.user_id);
    });

    test('should successfully subtract funds from user account', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ amount: -200 });

      expect(response.status).toBe(200);
      expect(response.body.funds).toBe('1300.00');
    });

    test('should not allow funds to go below 0', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ amount: -2000 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Insufficient funds');
    });

    test('should reject invalid amount formats', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ amount: 'invalid' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid amount provided');
    });

    test('should require authentication', async () => {
      const response = await request(app)
        .patch(`/api/users/${testUser.user_id}/funds`)
        .send({ amount: 100 });

      expect(response.status).toBe(401);
    });
  });
});
