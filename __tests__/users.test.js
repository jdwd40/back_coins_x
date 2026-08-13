const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const seed = require('../db/seed');
const jwt = require('jsonwebtoken');

describe('Users API', () => {
  let testUserToken;

  beforeEach(async () => {
    await seed();
    // Create a token for test user
    testUserToken = jwt.sign(
      { user_id: 1 }, // john_doe's user_id
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  // Remove afterAll since it's handled in setup.js

  describe('POST /api/users/register', () => {
    test('201: creates a new user and returns user data', () => {
      const newUser = {
        username: 'test_user',
        email: 'test@example.com',
        password: 'secure123'
      };

      return request(app)
        .post('/api/users/register')
        .send(newUser)
        .expect(201)
        .then(({ body }) => {
          expect(body.user).toMatchObject({
            user_id: expect.any(Number),
            username: newUser.username,
            email: newUser.email,
            created_at: expect.any(String)
          });
          expect(body.user.password_hash).toBeUndefined();
        });
    });

    test('409: returns error when username already exists', () => {
      const newUser = {
        username: 'john_doe',  // Existing username from seed data
        email: 'new@example.com',
        password: 'secure123'
      };

      return request(app)
        .post('/api/users/register')
        .send(newUser)
        .expect(409)
        .then(({ body }) => {
          expect(body.msg).toBe('Username already exists');
        });
    });

    test('400: returns error when required fields are missing', () => {
      const invalidUser = {
        username: 'test_user'
        // missing email and password
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.msg).toBe('Missing required fields');
        });
    });

    test('400: returns validation error when password field is missing from JSON object', () => {
      const invalidUser = {
        username: 'test_user',
        email: 'test@example.com'
        // missing password field
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.success).toBe(false);
          expect(body.msg).toBe('Missing required fields');
          expect(body.details.password).toBe('Password is required');
        });
    });

    test('400: returns validation error when password field is explicitly null', () => {
      const invalidUser = {
        username: 'test_user',
        email: 'test@example.com',
        password: null
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.success).toBe(false);
          expect(body.msg).toBe('Missing required fields');
          expect(body.details.password).toBe('Password is required');
        });
    });

    test('400: returns validation error when password field is undefined', () => {
      const invalidUser = {
        username: 'test_user',
        email: 'test@example.com',
        password: undefined
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.success).toBe(false);
          expect(body.msg).toBe('Missing required fields');
          expect(body.details.password).toBe('Password is required');
        });
    });

    test('400: returns validation error when password field is empty string', () => {
      const invalidUser = {
        username: 'test_user',
        email: 'test@example.com',
        password: ''
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.success).toBe(false);
          expect(body.msg).toBe('Missing required fields');
          expect(body.details.password).toBe('Password is required');
        });
    });

    test('400: returns validation error when password field is too short', () => {
      const invalidUser = {
        username: 'test_user',
        email: 'test@example.com',
        password: '12345' // less than 6 characters
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.success).toBe(false);
          expect(body.msg).toBe('Validation failed');
          expect(body.details).toBe('Password must be at least 6 characters long');
        });
    });

    test('400: returns validation error when password field is a number', () => {
      const invalidUser = {
        username: 'test_user',
        email: 'test@example.com',
        password: 123456
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.success).toBe(false);
          expect(body.msg).toBe('Validation failed');
          expect(body.details).toBe('Password must be at least 6 characters long');
        });
    });

    test('400: returns validation error when password field is an object', () => {
      const invalidUser = {
        username: 'test_user',
        email: 'test@example.com',
        password: { someKey: 'someValue' }
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.success).toBe(false);
          expect(body.msg).toBe('Validation failed');
          expect(body.details).toBe('Password must be at least 6 characters long');
        });
    });

    test('400: returns validation error when password field is an array', () => {
      const invalidUser = {
        username: 'test_user',
        email: 'test@example.com',
        password: ['password1', 'password2']
      };

      return request(app)
        .post('/api/users/register')
        .send(invalidUser)
        .expect(400)
        .then(({ body }) => {
          expect(body.success).toBe(false);
          expect(body.msg).toBe('Validation failed');
          expect(body.details).toBe('Password must be at least 6 characters long');
        });
    });
  });

  describe('POST /api/users/login', () => {
    test('200: returns user data and token for valid credentials', () => {
      const credentials = {
        email: 'john@example.com',
        password: 'password123'
      };

      return request(app)
        .post('/api/users/login')
        .send(credentials)
        .expect(200)
        .then(({ body }) => {
          expect(body.user).toMatchObject({
            user_id: expect.any(Number),
            username: 'john_doe',
            email: credentials.email
          });
          expect(body.token).toBeDefined();
          expect(typeof body.token).toBe('string');
          expect(body.user.password_hash).toBeUndefined();
        });
    });

    test('401: returns error for invalid credentials', () => {
      const invalidCredentials = {
        email: 'john@example.com',
        password: 'wrongpassword'
      };

      return request(app)
        .post('/api/users/login')
        .send(invalidCredentials)
        .expect(401)
        .then(({ body }) => {
          expect(body.msg).toBe('Invalid email or password');
        });
    });
  });

  // Regression test for token contract per K3 auth repair.
  // Proves: token from normal login (authenticateUser sign) succeeds on protected (200)
  // and garbage token remains 401. This will fail (red) if sign/verify secrets diverge.
  describe('Token contract regression (login token end-to-end)', () => {
    test('login returned token must access protected route (200); garbage token must 401', async () => {
      const loginRes = await request(app)
        .post('/api/users/login')
        .send({ email: 'john@example.com', password: 'password123' });

      expect(loginRes.status).toBe(200);
      const token = loginRes.body.token;
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(10);

      // Valid token from authenticateUser must succeed on protected route
      const protectedRes = await request(app)
        .get('/api/users/1')
        .set('Authorization', `Bearer ${token}`);
      expect(protectedRes.status).toBe(200);
      expect(protectedRes.body.success).toBe(true);
      expect(protectedRes.body.user).toMatchObject({
        user_id: 1,
        username: 'john_doe'
      });

      // Garbage token must remain 401
      const garbageRes = await request(app)
        .get('/api/users/1')
        .set('Authorization', 'Bearer this-token-is-garbage-and-will-not-verify');
      expect(garbageRes.status).toBe(401);
      expect(garbageRes.body.msg).toBe('Invalid token');
    });
  });

  describe('Protected Routes', () => {
    describe('GET /api/users/:user_id', () => {
      test('200: returns user profile when authenticated', () => {
        return request(app)
          .get('/api/users/1')
          .set('Authorization', `Bearer ${testUserToken}`)
          .expect(200)
          .then(({ body }) => {
            expect(body.user).toMatchObject({
              user_id: 1,
              username: 'john_doe',
              email: 'john@example.com',
              created_at: expect.any(String)
            });
            expect(body.user.password_hash).toBeUndefined();
          });
      });

      test('401: returns unauthorized when no token provided', () => {
        return request(app)
          .get('/api/users/1')
          .expect(401)
          .then(({ body }) => {
            expect(body.msg).toBe('Authentication required');
          });
      });

      test('401: returns unauthorized for invalid token', () => {
        return request(app)
          .get('/api/users/1')
          .set('Authorization', 'Bearer invalid-token')
          .expect(401)
          .then(({ body }) => {
            expect(body.msg).toBe('Invalid token');
          });
      });

      test('404: returns not found for non-existent user_id', () => {
        return request(app)
          .get('/api/users/999')
          .set('Authorization', `Bearer ${testUserToken}`)
          .expect(404)
          .then(({ body }) => {
            expect(body.msg).toBe('User not found');
          });
      });
    });

    describe('PUT /api/users/:user_id', () => {
      test('200: updates user profile when authenticated as self', () => {
        const updates = {
          username: 'john_updated',
          email: 'john_updated@example.com'
        };

        return request(app)
          .put('/api/users/1')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send(updates)
          .expect(200)
          .then(({ body }) => {
            expect(body.user).toMatchObject({
              user_id: 1,
              username: updates.username,
              email: updates.email,
              updated_at: expect.any(String)
            });
          });
      });

      test('401: returns unauthorized when no token provided', () => {
        return request(app)
          .put('/api/users/1')
          .send({ username: 'new_name' })
          .expect(401)
          .then(({ body }) => {
            expect(body.msg).toBe('Authentication required');
          });
      });

      test('403: rejects cross-user password change (cannot takeover admin/other accounts)', async () => {
        // user 1 (john) must not change user 2 (jane) password — regression for price-admin bypass
        const before = await db.query(
          'SELECT password_hash FROM users WHERE user_id = $1',
          [2]
        );
        const beforeHash = before.rows[0].password_hash;

        const response = await request(app)
          .put('/api/users/2')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({ password: 'hacked-password-999' })
          .expect(403);

        expect(response.body.msg).toMatch(/own account/i);

        const after = await db.query(
          'SELECT password_hash FROM users WHERE user_id = $1',
          [2]
        );
        expect(after.rows[0].password_hash).toBe(beforeHash);

        // Victim can still authenticate with original seed password path: hash unchanged
        // (login uses bcrypt compare against seed hash; we only assert no mutation here)
      });

      test('403: rejects cross-user profile field updates', async () => {
        const response = await request(app)
          .put('/api/users/2')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({ username: 'hijacked_jane' })
          .expect(403);

        expect(response.body.success).toBe(false);
        expect(response.body.msg).toMatch(/own account/i);

        const jane = await db.query(
          'SELECT username FROM users WHERE user_id = $1',
          [2]
        );
        expect(jane.rows[0].username).toBe('jane_smith');
      });
    });

    describe('DELETE /api/users/:user_id', () => {
      test('204: deletes user when authenticated', () => {
        return request(app)
          .delete('/api/users/1')
          .set('Authorization', `Bearer ${testUserToken}`)
          .expect(200);
      });

      test('401: returns unauthorized when no token provided', () => {
        return request(app)
          .delete('/api/users/1')
          .expect(401)
          .then(({ body }) => {
            expect(body.msg).toBe('Authentication required');
          });
      });
    });
  });
});
