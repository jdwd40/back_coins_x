const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');

describe('API Endpoints', () => {
  describe('GET /api/coins', () => {
    test('responds with an array of coins', () => {
      return request(app)
        .get('/api/coins')
        .expect(200)
        .then(({ body }) => {
          expect(Array.isArray(body.coins)).toBe(true);
          expect(body.coins.length).toBe(2); // We have 2 coins in our test data
          body.coins.forEach((coin) => {
            expect(coin).toHaveProperty('coin_id');
            expect(coin).toHaveProperty('name');
            expect(coin).toHaveProperty('symbol');
            expect(coin).toHaveProperty('current_price');
          });
        });
    });
  });
});
