const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');

describe('Coins API', () => {
  describe('GET /api/coins', () => {
    test('200: returns an array of all coins', () => {
      return request(app)
        .get('/api/coins')
        .expect(200)
        .then(({ body }) => {
          expect(Array.isArray(body.coins)).toBe(true);
          expect(body.coins).toHaveLength(2);
          body.coins.forEach((coin) => {
            expect(coin).toMatchObject({
              coin_id: expect.any(Number),
              name: expect.any(String),
              symbol: expect.any(String),
              current_price: expect.any(String),
              market_cap: expect.any(String),
              volume_24h: expect.any(String),
              price_change_24h: expect.any(String)
            });
          });
        });
    });
  });

  describe('GET /api/coins/:coin_id', () => {
    test('200: returns a single coin by ID', () => {
      return request(app)
        .get('/api/coins/1')
        .expect(200)
        .then(({ body }) => {
          expect(body.coin).toMatchObject({
            coin_id: 1,
            name: 'Bitcoin',
            symbol: 'BTC',
            current_price: expect.any(String),
            market_cap: expect.any(String),
            volume_24h: expect.any(String),
            price_change_24h: expect.any(String)
          });
        });
    });

    test('404: returns not found for non-existent coin_id', () => {
      return request(app)
        .get('/api/coins/999')
        .expect(404)
        .then(({ body }) => {
          expect(body.error).toBe('Coin not found');
        });
    });

    test('400: returns bad request for invalid coin_id', () => {
      return request(app)
        .get('/api/coins/not-a-number')
        .expect(400)
        .then(({ body }) => {
          expect(body.error).toBe('Invalid coin ID');
        });
    });
  });
});
