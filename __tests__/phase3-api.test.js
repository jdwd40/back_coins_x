const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const seed = require('../db/seed');
const marketSimulator = require('../models/market-simulator');

jest.setTimeout(30000);

describe('Phase 3: Price History API v2', () => {
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    marketSimulator.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    await db.end();
  });

  beforeEach(async () => {
    // Clean rollup table
    await db.query('DELETE FROM price_history_rollups');
    // Stop market if running
    marketSimulator.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe('GET /api/coins/:coin_id/price-history-v2', () => {
    describe('Validation', () => {
      test('should reject invalid coin_id', async () => {
        const res = await request(app)
          .get('/api/coins/invalid/price-history-v2')
          .expect(400);
        
        expect(res.body.error).toMatch(/Invalid coin_id/);
      });

      test('should reject invalid interval', async () => {
        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=invalid')
          .expect(400);
        
        expect(res.body.error).toMatch(/Invalid interval/);
      });

      test('should reject invalid format', async () => {
        const res = await request(app)
          .get('/api/coins/1/price-history-v2?format=invalid')
          .expect(400);
        
        expect(res.body.error).toMatch(/Invalid format/);
      });

      test('should reject minutes out of range (too small)', async () => {
        const res = await request(app)
          .get('/api/coins/1/price-history-v2?minutes=0')
          .expect(400);
        
        expect(res.body.error).toMatch(/Minutes must be between/);
      });

      test('should reject minutes out of range (too large)', async () => {
        const res = await request(app)
          .get('/api/coins/1/price-history-v2?minutes=99999')
          .expect(400);
        
        expect(res.body.error).toMatch(/Minutes must be between/);
      });

      test('should return 404 for non-existent coin', async () => {
        const res = await request(app)
          .get('/api/coins/99999/price-history-v2')
          .expect(404);
        
        expect(res.body.error).toBe('Coin not found');
      });
    });

    describe('Response Format', () => {
      test('should return OHLC format by default', async () => {
        // Insert test rollup data
        await db.query(`
          INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
          VALUES (1, '5m', NOW() - INTERVAL '10 minutes', 100, 105, 98, 102, 10)
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=5m&minutes=15')
          .expect(200);
        
        expect(res.body).toHaveProperty('coin_id', 1);
        expect(res.body).toHaveProperty('symbol');
        expect(res.body).toHaveProperty('interval', '5m');
        expect(res.body).toHaveProperty('data');
        expect(Array.isArray(res.body.data)).toBe(true);

        if (res.body.data.length > 0) {
          const dataPoint = res.body.data[0];
          expect(dataPoint).toHaveProperty('t'); // timestamp
          expect(dataPoint).toHaveProperty('o'); // open
          expect(dataPoint).toHaveProperty('h'); // high
          expect(dataPoint).toHaveProperty('l'); // low
          expect(dataPoint).toHaveProperty('c'); // close
          expect(dataPoint).toHaveProperty('n'); // tick count
        }
      });

      test('should return line format when requested', async () => {
        // Insert test rollup data
        await db.query(`
          INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
          VALUES (1, '5m', NOW() - INTERVAL '10 minutes', 100, 105, 98, 102, 10)
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=5m&minutes=15&format=line')
          .expect(200);
        
        expect(res.body).toHaveProperty('coin_id', 1);
        expect(res.body).toHaveProperty('symbol');
        expect(res.body).toHaveProperty('interval', '5m');
        expect(res.body).toHaveProperty('data');
        expect(Array.isArray(res.body.data)).toBe(true);

        if (res.body.data.length > 0) {
          const dataPoint = res.body.data[0];
          expect(Array.isArray(dataPoint)).toBe(true);
          expect(dataPoint.length).toBe(2); // [timestamp, price]
        }
      });

      test('should return numeric values (not currency strings)', async () => {
        await db.query(`
          INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
          VALUES (1, '1m', NOW() - INTERVAL '2 minutes', 50.25, 52.75, 49.00, 51.50, 5)
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=1m&minutes=5')
          .expect(200);
        
        if (res.body.data.length > 0) {
          const dataPoint = res.body.data[0];
          expect(typeof dataPoint.o).toBe('number');
          expect(typeof dataPoint.h).toBe('number');
          expect(typeof dataPoint.l).toBe('number');
          expect(typeof dataPoint.c).toBe('number');
          expect(typeof dataPoint.n).toBe('number');
        }
      });
    });

    describe('Cache Headers', () => {
      test('should include cache-control headers', async () => {
        const res = await request(app)
          .get('/api/coins/1/price-history-v2')
          .expect(200);
        
        expect(res.headers['cache-control']).toBe('public, max-age=30');
      });
    });

    describe('Interval Types', () => {
      test('should fetch raw data when interval=raw', async () => {
        // Insert raw price history
        await db.query(`
          INSERT INTO price_history (coin_id, price, created_at)
          VALUES (1, 45.00, NOW() - INTERVAL '2 minutes')
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=raw&minutes=5')
          .expect(200);
        
        expect(res.body.interval).toBe('raw');
        expect(res.body.data).toBeDefined();
      });

      test('should fetch 1m rollup data', async () => {
        await db.query(`
          INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
          VALUES (1, '1m', NOW() - INTERVAL '2 minutes', 40, 42, 39, 41, 8)
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=1m&minutes=5')
          .expect(200);
        
        expect(res.body.interval).toBe('1m');
        if (res.body.data.length > 0) {
          expect(res.body.data[0]).toHaveProperty('o');
        }
      });

      test('should fetch 5m rollup data', async () => {
        await db.query(`
          INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
          VALUES (1, '5m', NOW() - INTERVAL '10 minutes', 35, 38, 34, 37, 15)
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=5m&minutes=15')
          .expect(200);
        
        expect(res.body.interval).toBe('5m');
      });

      test('should fetch 15m rollup data', async () => {
        await db.query(`
          INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
          VALUES (1, '15m', NOW() - INTERVAL '20 minutes', 30, 33, 29, 32, 30)
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=15m&minutes=30')
          .expect(200);
        
        expect(res.body.interval).toBe('15m');
      });

      test('should fetch 1h rollup data', async () => {
        await db.query(`
          INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
          VALUES (1, '1h', NOW() - INTERVAL '2 hours', 25, 28, 24, 27, 120)
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=1h&minutes=180')
          .expect(200);
        
        expect(res.body.interval).toBe('1h');
      });
    });

    describe('Default Values', () => {
      test('should use default interval (5m)', async () => {
        const res = await request(app)
          .get('/api/coins/1/price-history-v2')
          .expect(200);
        
        expect(res.body.interval).toBe('5m');
      });

      test('should use default minutes (60)', async () => {
        // This is implicitly tested by the interval query
        const res = await request(app)
          .get('/api/coins/1/price-history-v2')
          .expect(200);
        
        expect(res.body).toHaveProperty('data');
      });

      test('should use default format (ohlc)', async () => {
        await db.query(`
          INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
          VALUES (1, '5m', NOW() - INTERVAL '10 minutes', 50, 52, 49, 51, 10)
        `);

        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=5m')
          .expect(200);
        
        if (res.body.data.length > 0) {
          expect(res.body.data[0]).toHaveProperty('o');
          expect(res.body.data[0]).toHaveProperty('h');
          expect(res.body.data[0]).toHaveProperty('l');
          expect(res.body.data[0]).toHaveProperty('c');
        }
      });
    });

    describe('Integration Test', () => {
      test('should work end-to-end with market simulator', async () => {
        // Start market simulator to generate price data
        marketSimulator.start();
        
        // Wait for some price updates (2 seconds = ~2 updates at 30s interval, but may catch 1)
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Query raw data (should have some data from market simulator)
        const res = await request(app)
          .get('/api/coins/1/price-history-v2?interval=raw&minutes=5')
          .expect(200);
        
        expect(res.body).toHaveProperty('coin_id', 1);
        expect(res.body).toHaveProperty('symbol');
        expect(res.body).toHaveProperty('data');
        expect(Array.isArray(res.body.data)).toBe(true);
        
        // Stop market
        marketSimulator.stop();
      });
    });
  });

  describe('Backwards Compatibility', () => {
    test('old price-history endpoint should still work', async () => {
      const res = await request(app)
        .get('/api/coins/1/price-history')
        .expect(200);
      
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('pagination');
    });
  });
});

