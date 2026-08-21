const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const seed = require('../db/seed');
const { CurrencyFormatter } = require('../utils/currency-formatter');

// Ensure test environment
process.env.NODE_ENV = 'test';

// Setup and teardown
beforeAll(async () => {
  // Test database connection
  await db.query('SELECT NOW()');
});

beforeEach(async () => {
  await seed(false);
});

afterAll(async () => {
  await db.end();
});

describe('Coins API', () => {
  describe('GET /api/coins', () => {
    test('200: returns an array of all coins', async () => {
      const response = await request(app)
        .get('/api/coins')
        .expect(200);

      expect(Array.isArray(response.body.coins)).toBe(true);
      expect(response.body.coins).toHaveLength(13);

      // Test the first coin (BitBerto) specifically
      const bitBerto = response.body.coins.find(coin => coin.name === 'BitBerto');
      expect(bitBerto).toMatchObject({
        coin_id: 1,
        name: 'BitBerto',
        symbol: 'BTB',
        current_price: '£0.10',
        market_cap: '£30,000.00',
        circulating_supply: 2500,
        price_change_24h: null,
        founder: 'Roberto'
      });

      // Test the structure of all coins
      response.body.coins.forEach((coin) => {
        expect(coin).toMatchObject({
          coin_id: expect.any(Number),
          name: expect.any(String),
          symbol: expect.any(String),
          current_price: expect.stringMatching(/^£\d+(\.\d{2})?$/),
          market_cap: expect.stringMatching(/^£\d+(,\d{3})*(\.\d{2})?$/),
          circulating_supply: expect.any(Number),
          price_change_24h: null,
          founder: expect.any(String)
        });
      });
    });
  });

  describe('GET /api/coins/:coin_id', () => {
    test('200: returns a single coin by ID', async () => {
      const { body } = await request(app)
        .get('/api/coins/1')
        .expect(200);

      expect(body.coin).toEqual({
        coin_id: 1,
        name: 'BitBerto',
        symbol: 'BTB',
        current_price: CurrencyFormatter.formatGBP(0.10),
        market_cap: CurrencyFormatter.formatGBP(30000.00),
        circulating_supply: 2500,
        price_change_24h: null,
        founder: 'Roberto'
      });
    });

    test('404: returns not found for non-existent coin_id', async () => {
      // Act
      const response = await request(app)
        .get('/api/coins/999')
        .expect(404);

      // Assert
      expect(response.body.msg).toBe('Coin not found');
    });

    test('400: returns bad request for invalid coin_id', async () => {
      // Act
      const response = await request(app)
        .get('/api/coins/not-a-number')
        .expect(400);

      // Assert
      expect(response.body.msg).toBe('Bad request');
    });
  });
});
