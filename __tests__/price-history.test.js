const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const coinsModel = require('../models/coins.model');
const seed = require('../db/seed');

describe('Price History Redesign (v1 contract)', () => {
  beforeEach(async () => {
    await seed();
  });

  const VALID_RANGES = ['10M', '30M', '1H', '2H', '24H', '7D', '30D'];
  const EXPECTED_RESOLUTIONS = {
    '10M': 'raw',
    '30M': '1m',
    '1H': '1m',
    '2H': '5m',
    '24H': '15m',
    '7D': '1h',
    '30D': '6h'
  };

  const EXPECTED_MAX_POINTS = {
    '10M': 20,
    '30M': 30,
    '1H': 60,
    '2H': 24,
    '24H': 96,
    '7D': 168,
    '30D': 120
  };

  describe('GET /api/coins/:coin_id/price-history?range=...', () => {
    test('returns 200 with new contract shape for valid coin and each range', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];
      expect(coin).toBeDefined();

      for (const range of VALID_RANGES) {
        const res = await request(app)
          .get(`/api/coins/${coin.coin_id}/price-history?range=${range}`)
          .expect(200);

        expect(res.body).toHaveProperty('range');
        expect(res.body.range.requested).toBe(range);
        expect(res.body.resolution).toBe(EXPECTED_RESOLUTIONS[range]);
        expect(res.body).toHaveProperty('serverTime');
        expect(res.body).toHaveProperty('latestValue');
        expect(typeof res.body.latestValue).toBe('number');
        expect(res.body).toHaveProperty('coin');
        expect(res.body.coin.coin_id).toBe(coin.coin_id);
        expect(res.body).toHaveProperty('points');
        expect(Array.isArray(res.body.points)).toBe(true);

        // Cache header
        expect(res.headers['cache-control']).toMatch(/public, max-age=10/);
      }
    });

    test('points are numeric (no GBP strings, no commas) and chronological (time ASC)', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];

      // Controlled inserted test data (ensure assertions run against real data, not empty/vacuous)
      await db.query('DELETE FROM price_history WHERE coin_id = $1', [coin.coin_id]);
      const base = Date.now() - 5 * 60 * 1000;
      const inserts = [
        [coin.coin_id, 100.10, new Date(base - 120000)],
        [coin.coin_id, 100.20, new Date(base - 60000)],
        [coin.coin_id, 100.30, new Date(base)],
      ];
      for (const [cid, pr, ts] of inserts) {
        await db.query(
          'INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, $2, $3)',
          [cid, pr, ts]
        );
      }

      const res = await request(app)
        .get(`/api/coins/${coin.coin_id}/price-history?range=1H`)
        .expect(200);

      const { points, latestValue } = res.body;
      expect(typeof latestValue).toBe('number');
      expect(points.length).toBeGreaterThanOrEqual(3);

      // order assertion always executes
      const times = points.map(p => new Date(p.time).getTime());
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i-1]);
      }

      for (const p of points) {
        expect(typeof p.time).toBe('string');
        expect(typeof p.open).toBe('number');
        expect(typeof p.high).toBe('number');
        expect(typeof p.low).toBe('number');
        expect(typeof p.close).toBe('number');
        expect(typeof p.samples).toBe('number');
        // no string formatting
        expect(String(p.close)).not.toMatch(/[£,]/);
      }
    });

    test('10M uses raw resolution with complete:true for all points', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];

      await db.query('DELETE FROM price_history WHERE coin_id = $1', [coin.coin_id]);
      await db.query(
        'INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, $2, NOW() - INTERVAL \'30 seconds\')',
        [coin.coin_id, 101.25]
      );

      const res = await request(app)
        .get(`/api/coins/${coin.coin_id}/price-history?range=10M`)
        .expect(200);

      expect(res.body.resolution).toBe('raw');
      expect(res.body.points).toHaveLength(1);
      for (const p of res.body.points) {
        expect(p.complete).toBe(true);
      }
    });

    test('bucketed ranges mark completed buckets true and the current bucket false', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];
      const bucketSecondsByRange = {
        '30M': 60,
        '1H': 60,
        '2H': 300,
        '24H': 900,
        '7D': 3600,
        '30D': 21600
      };

      for (const range of ['30M', '1H', '2H', '24H', '7D', '30D']) {
        const bucketSeconds = bucketSecondsByRange[range];
        const currentBucketStartMs = Math.floor(Date.now() / 1000 / bucketSeconds) * bucketSeconds * 1000;
        const completedBucketTime = new Date(currentBucketStartMs - Math.floor(bucketSeconds / 2) * 1000);
        const currentBucketTime = new Date(currentBucketStartMs + 1000);

        await db.query('DELETE FROM price_history WHERE coin_id = $1', [coin.coin_id]);
        await db.query(
          `INSERT INTO price_history (coin_id, price, created_at)
           VALUES ($1, $2, $3), ($1, $4, $5)`,
          [coin.coin_id, 100.00, completedBucketTime, 101.00, currentBucketTime]
        );

        const res = await request(app)
          .get(`/api/coins/${coin.coin_id}/price-history?range=${range}`)
          .expect(200);
        expect(res.body.resolution).toBe(EXPECTED_RESOLUTIONS[range]);
        expect(res.body.points).toHaveLength(2);
        expect(res.body.points[0].complete).toBe(true);
        expect(res.body.points[1].complete).toBe(false);
      }
    });

    test('latestValue matches coins.current_price (numeric freshness)', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];

      // get numeric current directly
      const direct = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coin.coin_id]);
      const directPrice = Number(direct.rows[0].current_price);

      const res = await request(app)
        .get(`/api/coins/${coin.coin_id}/price-history?range=30M`)
        .expect(200);

      expect(res.body.latestValue).toBe(directPrice);
      expect(typeof res.body.latestValue).toBe('number');
    });

    test('invalid range returns 400 with msg', async () => {
      const res = await request(app)
        .get('/api/coins/1/price-history?range=INVALID')
        .expect(400);
      expect(res.body.msg).toMatch(/Invalid range parameter/);
    });

    test('invalid coin_id returns 400', async () => {
      await request(app)
        .get('/api/coins/abc/price-history?range=1H')
        .expect(400);
    });

    test('non-existent coin returns 404', async () => {
      const res = await request(app)
        .get('/api/coins/999999/price-history?range=1H')
        .expect(404);
      expect(res.body.msg).toBe('Coin not found');
    });

    test('point count respects mapping and budget', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];

      for (const range of VALID_RANGES) {
        const res = await request(app)
          .get(`/api/coins/${coin.coin_id}/price-history?range=${range}`)
          .expect(200);
        expect(res.body.points.length).toBeLessThanOrEqual(EXPECTED_MAX_POINTS[range]);
      }
    });

    // --- NEW RANGE TESTS per spec §7 ---
    test('7D returns resolution 1h and <=168 points', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];
      const res = await request(app)
        .get(`/api/coins/${coin.coin_id}/price-history?range=7D`)
        .expect(200);
      expect(res.body.resolution).toBe('1h');
      expect(res.body.points.length).toBeLessThanOrEqual(168);
      expect(Array.isArray(res.body.points)).toBe(true);
      if (res.body.points.length > 0) {
        for (const p of res.body.points) {
          expect(typeof p.open).toBe('number');
          expect(typeof p.high).toBe('number');
        }
      }
    });

    test('30D returns resolution 6h and <=120 points', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];
      const res = await request(app)
        .get(`/api/coins/${coin.coin_id}/price-history?range=30D`)
        .expect(200);
      expect(res.body.resolution).toBe('6h');
      expect(res.body.points.length).toBeLessThanOrEqual(120);
    });

    test('ALL empty history returns 200 points:[] resolution raw from=to=serverTime', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];
      await db.query('DELETE FROM price_history WHERE coin_id = $1', [coin.coin_id]);
      const res = await request(app)
        .get(`/api/coins/${coin.coin_id}/price-history?range=ALL`)
        .expect(200);
      expect(res.body.resolution).toBe('raw');
      expect(res.body.points).toEqual([]);
      expect(res.body.range.from).toBe(res.body.range.to);
      expect(res.body.range.requested).toBe('ALL');
    });

    test('ALL adaptive bucketing <2d -> 15m, 2-7d ->1h, 7-31d ->6h', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];
      const now = Date.now();

      // case a: span < 2d -> 15m
      await db.query('DELETE FROM price_history WHERE coin_id = $1', [coin.coin_id]);
      await db.query(
        'INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, 100, $2), ($1, 101, $3)',
        [coin.coin_id, new Date(now - 12 * 3600 * 1000), new Date(now - 1 * 3600 * 1000)]
      );
      let res = await request(app).get(`/api/coins/${coin.coin_id}/price-history?range=ALL`).expect(200);
      expect(res.body.resolution).toBe('15m');

      // case b: 2-7d span -> 1h
      await db.query('DELETE FROM price_history WHERE coin_id = $1', [coin.coin_id]);
      await db.query(
        'INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, 100, $2), ($1, 101, $3)',
        [coin.coin_id, new Date(now - 5 * 24 * 3600 * 1000), new Date(now - 1 * 3600 * 1000)]
      );
      res = await request(app).get(`/api/coins/${coin.coin_id}/price-history?range=ALL`).expect(200);
      expect(res.body.resolution).toBe('1h');

      // case c: 7-31d span -> 6h
      await db.query('DELETE FROM price_history WHERE coin_id = $1', [coin.coin_id]);
      await db.query(
        'INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, 100, $2), ($1, 101, $3)',
        [coin.coin_id, new Date(now - 10 * 24 * 3600 * 1000), new Date(now - 1 * 3600 * 1000)]
      );
      res = await request(app).get(`/api/coins/${coin.coin_id}/price-history?range=ALL`).expect(200);
      expect(res.body.resolution).toBe('6h');
    });
  });

  describe('Transaction consistency (updateCoinPrice)', () => {
    test('updateCoinPrice uses single client: coin + history row written atomically', async () => {
      const coinsRes = await request(app).get('/api/coins').expect(200);
      const coin = coinsRes.body.coins[0];
      const beforeCountRes = await db.query(
        'SELECT COUNT(*) FROM price_history WHERE coin_id = $1',
        [coin.coin_id]
      );
      const beforeCount = parseInt(beforeCountRes.rows[0].count);

      const newPrice = 123.45;
      const updated = await coinsModel.updateCoinPrice(coin.coin_id, newPrice);
      expect(updated).not.toBeNull();

      // After, history should have +1
      const afterCountRes = await db.query(
        'SELECT COUNT(*) FROM price_history WHERE coin_id = $1',
        [coin.coin_id]
      );
      const afterCount = parseInt(afterCountRes.rows[0].count);
      expect(afterCount).toBe(beforeCount + 1);

      // latest coin price matches
      const coinCheck = await db.query('SELECT current_price FROM coins WHERE coin_id=$1', [coin.coin_id]);
      expect(Number(coinCheck.rows[0].current_price)).toBe(newPrice);
    });
  });
});
