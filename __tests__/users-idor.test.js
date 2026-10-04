// Regression suite for issue #48 (HIGH): IDOR on /api/users/:user_id.
// getUserProfile / updateUserProfile / deleteUser previously never compared
// the authenticated token's user_id against :user_id, so any authenticated
// user could read, modify (including password), or delete ANY account.
// Each handler must now reject cross-account access with 403
// { success: false, msg: 'Forbidden' } while still allowing self-access.
//
// jest.setup.js reseeds the disposable test database before every test;
// seeded users are ids 1 (john_doe) and 2 (jane_smith).

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET);
}

async function passwordHashOf(userId) {
  const { rows } = await db.query('SELECT password_hash FROM users WHERE user_id = $1', [userId]);
  return rows.length ? rows[0].password_hash : null;
}

async function userExists(userId) {
  const { rows } = await db.query('SELECT 1 FROM users WHERE user_id = $1', [userId]);
  return rows.length > 0;
}

describe('IDOR protection on /api/users/:user_id (issue #48)', () => {
  test('the sibling transaction detail route denies cross-owner reads but permits the owner', async () => {
    const { rows } = await db.query(
      `INSERT INTO transactions (user_id, coin_id, type, quantity, price, total_amount)
       VALUES (2, 1, 'BUY', 1, 10, 10) RETURNING transaction_id`
    );
    const url = `/api/transactions/${rows[0].transaction_id}`;
    await request(app).get(url).set('Authorization', `Bearer ${tokenFor(1)}`).expect(403, { msg: 'Forbidden' });
    const own = await request(app).get(url).set('Authorization', `Bearer ${tokenFor(2)}`).expect(200);
    expect(own.body.user_id).toBe(2);
  });

  test('the retired funds shim denies both self and cross-user writes without changing funds', async () => {
    const before = (await db.query('SELECT user_id, funds FROM users ORDER BY user_id')).rows;
    for (const id of [1, 2]) {
      await request(app).patch(`/api/users/${id}/funds`).set('Authorization', `Bearer ${tokenFor(1)}`).send({ amount: 500 }).expect(403);
    }
    expect((await db.query('SELECT user_id, funds FROM users ORDER BY user_id')).rows).toEqual(before);
  });
  describe('GET /api/users/:user_id', () => {
    test('an authenticated user cannot read another user\'s profile (403)', async () => {
      const response = await request(app)
        .get('/api/users/2')
        .set('Authorization', `Bearer ${tokenFor(1)}`);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ success: false, msg: 'Forbidden' });
    });

    test('an authenticated user can still read their own profile (200)', async () => {
      const response = await request(app)
        .get('/api/users/1')
        .set('Authorization', `Bearer ${tokenFor(1)}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.user_id).toBe(1);
      expect(response.body.user.username).toBe('john_doe');
    });
  });

  describe('PUT /api/users/:user_id', () => {
    test('an authenticated user cannot update another user\'s profile (403) and the target is untouched', async () => {
      const response = await request(app)
        .put('/api/users/2')
        .set('Authorization', `Bearer ${tokenFor(1)}`)
        .send({ username: 'pwned_jane' });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ success: false, msg: 'Forbidden' });

      const { rows } = await db.query('SELECT username FROM users WHERE user_id = 2');
      expect(rows[0].username).toBe('jane_smith');
    });

    test('a PUT to another user\'s password does not change it', async () => {
      // Real bcrypt verification, independent of the test password123 bypass.
      const originalPassword = 'victim-original-password';
      await db.query('UPDATE users SET password_hash = $1 WHERE user_id = 2', [await bcrypt.hash(originalPassword, 10)]);
      const hashBefore = await passwordHashOf(2);

      const response = await request(app)
        .put('/api/users/2')
        .set('Authorization', `Bearer ${tokenFor(1)}`)
        .send({ password: 'attacker-controlled-password' });

      expect(await bcrypt.compare(originalPassword, await passwordHashOf(2))).toBe(true);
      expect(await bcrypt.compare('attacker-controlled-password', await passwordHashOf(2))).toBe(false);
      expect(await passwordHashOf(2)).toBe(hashBefore);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ success: false, msg: 'Forbidden' });
    });

    test('an authenticated user can still update their own profile (200)', async () => {
      const response = await request(app)
        .put('/api/users/1')
        .set('Authorization', `Bearer ${tokenFor(1)}`)
        .send({ username: 'john_doe_updated' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.username).toBe('john_doe_updated');
    });
  });

  describe('DELETE /api/users/:user_id', () => {
    test('an authenticated user cannot delete another user\'s account (403) and the target survives', async () => {
      const response = await request(app)
        .delete('/api/users/2')
        .set('Authorization', `Bearer ${tokenFor(1)}`);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ success: false, msg: 'Forbidden' });
      expect(await userExists(2)).toBe(true);
    });

    test('an authenticated user can still delete their own account (200)', async () => {
      // Register a throwaway account and delete it with its own token, so the
      // seeded fixture users (referenced by other seeded rows) stay intact.
      const register = await request(app)
        .post('/api/users/register')
        .send({ username: 'self_delete_user', email: 'selfdelete@example.com', password: 'secure123' })
        .expect(201);
      const newUserId = register.body.user.user_id;

      const response = await request(app)
        .delete(`/api/users/${newUserId}`)
        .set('Authorization', `Bearer ${tokenFor(newUserId)}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(await userExists(newUserId)).toBe(false);
    });
  });
});
