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
      expect(response.body.coins).toHaveLength(10);

      // Test the first coin (FutureCoin) specifically
      const futureCoin = response.body.coins.find(coin => coin.name === 'FutureCoin');
      expect(futureCoin).toMatchObject({
        coin_id: 1,
        name: 'FutureCoin',
        symbol: 'FTR',
        current_price: '£0.10',
        // Derived on read: price x supply (issue #54), not the stored launch value.
        market_cap: '£250.00',
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
        name: 'FutureCoin',
        symbol: 'FTR',
        current_price: CurrencyFormatter.formatGBP(0.10),
        market_cap: CurrencyFormatter.formatGBP(0.10 * 2500),
        circulating_supply: 2500,
        price_change_24h: null,
        founder: 'Roberto',
        retired: false
      });
    });

    test('200: market_cap is price x circulating_supply and moves with the price (issue #54)', async () => {
      await db.query('UPDATE coins SET current_price = 45351.27 WHERE coin_id = 1');

      const { body } = await request(app).get('/api/coins/1').expect(200);
      expect(body.coin.current_price).toBe('£45,351.27');
      expect(body.coin.circulating_supply).toBe(2500);
      expect(body.coin.market_cap).toBe(CurrencyFormatter.formatGBP(45351.27 * 2500));

      const list = await request(app).get('/api/coins').expect(200);
      const listed = list.body.coins.find((c) => c.coin_id === 1);
      expect(listed.market_cap).toBe(body.coin.market_cap);

      // Every live coin: cap == price x supply to within a penny of rounding.
      const { rows } = await db.query('SELECT coin_id, current_price, circulating_supply FROM coins WHERE retired = FALSE');
      for (const row of rows) {
        const coin = list.body.coins.find((c) => c.coin_id === row.coin_id);
        const shownCap = CurrencyFormatter.convertToNumber(coin.market_cap);
        expect(Math.abs(shownCap - Number(row.current_price) * row.circulating_supply)).toBeLessThanOrEqual(0.01);
      }
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
