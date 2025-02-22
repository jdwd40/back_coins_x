const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');

describe('API Endpoints', () => {
  describe('GET /api/coins', () => {
    test('200: responds with an array of coins', () => {
      return request(app)
        .get('/api/coins')
        .expect(200)
        .then(({ body }) => {
          expect(Array.isArray(body.coins)).toBe(true);
          expect(body.coins).toHaveLength(13);
        });
    });
  });
});
