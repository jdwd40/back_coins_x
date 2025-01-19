const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const seed = require('../db/seed');

beforeEach(() => seed());
afterAll(() => db.end());

describe('Coins API', () => {
  describe('GET /api/coins', () => {
    test('200: returns an array of all coins', () => {
      return request(app)
        .get('/api/coins')
        .expect(200)
        .then((response) => {
          expect(Array.isArray(response.body.coins)).toBe(true);
          expect(response.body.coins.length).toBe(10);
          response.body.coins.forEach((coin) => {
            expect(coin).toMatchObject({
              coin_id: expect.any(Number),
              name: expect.any(String),
              symbol: expect.any(String),
              current_price: expect.any(String),
              market_cap: expect.any(String),
              circulating_supply: expect.any(Number),
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
        .then((response) => {
          expect(response.body).toMatchObject({
            coin_id: 1,
            name: expect.any(String),
            symbol: expect.any(String),
            current_price: expect.any(String),
            market_cap: expect.any(String),
            circulating_supply: expect.any(Number),
            price_change_24h: expect.any(String)
          });
        });
    });

    test('404: returns not found for non-existent coin_id', () => {
      return request(app)
        .get('/api/coins/999')
        .expect(404)
        .then((response) => {
          expect(response.body.msg).toBe('Coin not found');
        });
    });

    test('400: returns bad request for invalid coin_id', () => {
      return request(app)
        .get('/api/coins/not-a-number')
        .expect(400)
        .then((response) => {
          expect(response.body.msg).toBe('Invalid coin ID');
        });
    });
  });

  describe('PATCH /api/coins/:coin_id/price', () => {
    test('200: successfully updates coin price', () => {
      return request(app)
        .patch('/api/coins/1/price')
        .send({ current_price: 150.00 })
        .expect(200)
        .then((response) => {
          expect(response.body).toMatchObject({
            coin_id: 1,
            name: expect.any(String),
            symbol: expect.any(String),
            current_price: "150.00",
            market_cap: expect.any(String),
            circulating_supply: expect.any(Number),
            price_change_24h: expect.any(String)
          });
        });
    });

    test('400: returns bad request when price is missing', () => {
      return request(app)
        .patch('/api/coins/1/price')
        .send({})
        .expect(400)
        .then((response) => {
          expect(response.body.msg).toBe('Current price is required');
        });
    });

    test('400: returns bad request when price is invalid', () => {
      return request(app)
        .patch('/api/coins/1/price')
        .send({ current_price: 'invalid' })
        .expect(400)
        .then((response) => {
          expect(response.body.msg).toBe('Invalid price format');
        });
    });

    test('404: returns not found for non-existent coin_id', () => {
      return request(app)
        .patch('/api/coins/999/price')
        .send({ current_price: 150.00 })
        .expect(404)
        .then((response) => {
          expect(response.body.msg).toBe('Coin not found');
        });
    });

    test('400: returns bad request for invalid coin_id', () => {
      return request(app)
        .patch('/api/coins/not-a-number/price')
        .send({ current_price: 150.00 })
        .expect(400)
        .then((response) => {
          expect(response.body.msg).toBe('Invalid coin ID');
        });
    });
  });
});
