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

  describe('PATCH /api/coins/:coin_id/price', () => {
    test('200: successfully updates coin price with GBP string', async () => {
      const response = await request(app)
        .patch('/api/coins/1/price')
        .send({ current_price: "£150.00" })
        .expect(200);

      expect(response.body.coin).toMatchObject({
        coin_id: 1,
        current_price: "£150.00",
        price_change_24h: expect.any(Number)
      });
    });

    test('200: successfully updates coin price with numeric string', async () => {
      const response = await request(app)
        .patch('/api/coins/1/price')
        .send({ current_price: "150.00" })
        .expect(200);

      expect(response.body.coin).toMatchObject({
        coin_id: 1,
        current_price: "£150.00",
      });
    });

    test('200: successfully updates coin price with number', async () => {
      const response = await request(app)
        .patch('/api/coins/1/price')
        .send({ current_price: 150.00 })
        .expect(200);

      expect(response.body.coin).toMatchObject({
        coin_id: 1,
        current_price: "£150.00",
      });
    });

    test('200: successfully updates coin price with formatted number string', async () => {
      const response = await request(app)
        .patch('/api/coins/1/price')
        .send({ current_price: "1,150.00" })
        .expect(200);

      expect(response.body.coin).toMatchObject({
        coin_id: 1,
        current_price: "£1,150.00",
      });
    });

    test('400: returns bad request when price is missing', async () => {
      const response = await request(app)
        .patch('/api/coins/1/price')
        .send({})
        .expect(400);

      expect(response.body.msg).toBe('Price is required in request body as either "price" or "current_price" - must be a number or GBP string (e.g., 150.00 or £150.00)');
    });

    test('400: returns bad request when price is invalid string', async () => {
      const response = await request(app)
        .patch('/api/coins/1/price')
        .send({ current_price: 'invalid' })
        .expect(400);

      expect(response.body.msg).toBe('Invalid price format - must be a valid number or GBP amount');
    });

    test('400: returns bad request when price is negative', async () => {
      const response = await request(app)
        .patch('/api/coins/1/price')
        .send({ current_price: -150.00 })
        .expect(400);

      expect(response.body.msg).toBe('Invalid price format - must be a positive number');
    });

    test('404: returns not found for non-existent coin_id', async () => {
      const response = await request(app)
        .patch('/api/coins/999/price')
        .send({ current_price: "£150.00" })
        .expect(404);

      expect(response.body.msg).toBe('Coin with ID 999 not found');
    });

    test('400: returns bad request for invalid coin_id', async () => {
      const response = await request(app)
        .patch('/api/coins/not-a-number/price')
        .send({ current_price: "£150.00" })
        .expect(400);

      expect(response.body.msg).toBe('Invalid coin ID - must be a positive integer');
    });
  });
});
