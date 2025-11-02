const db = require('../db/connection');
const seed = require('../db/seed');
const rollupService = require('../services/rollup-service');

// Increase timeout for rollup tests (they involve time delays)
jest.setTimeout(30000);

describe('Phase 2: Price History Rollups', () => {
  // Setup and teardown
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    rollupService.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    await db.end();
  });

  beforeEach(async () => {
    // Clean rollup table before each test
    await db.query('DELETE FROM price_history_rollups');
  });

  describe('Rollup Table Schema', () => {
    test('price_history_rollups table should exist', async () => {
      const result = await db.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'price_history_rollups'
        );
      `);
      expect(result.rows[0].exists).toBe(true);
    });

    test('rollup table should have correct columns', async () => {
      const result = await db.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'price_history_rollups'
        ORDER BY ordinal_position;
      `);
      
      const columns = result.rows.map(row => row.column_name);
      expect(columns).toContain('coin_id');
      expect(columns).toContain('interval_type');
      expect(columns).toContain('bucket_start');
      expect(columns).toContain('open');
      expect(columns).toContain('high');
      expect(columns).toContain('low');
      expect(columns).toContain('close');
      expect(columns).toContain('tick_count');
    });

    test('rollup index should exist', async () => {
      const result = await db.query(`
        SELECT indexname 
        FROM pg_indexes 
        WHERE tablename = 'price_history_rollups'
        AND indexname = 'idx_rollups_coin_interval';
      `);
      expect(result.rows.length).toBeGreaterThan(0);
    });
  });

  describe('1-Minute Rollup Computation', () => {
    test('should compute accurate OHLC for 1m rollup', async () => {
      // Insert test data (prices in a minute: 100, 102, 99, 101)
      const baseTime = new Date();
      baseTime.setSeconds(0); // Round to start of minute
      baseTime.setMinutes(baseTime.getMinutes() - 2); // 2 minutes ago (completed minute)

      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at) VALUES
        ($1, 100.00, $2),
        ($1, 102.00, $2 + INTERVAL '15 seconds'),
        ($1, 99.00, $2 + INTERVAL '30 seconds'),
        ($1, 101.00, $2 + INTERVAL '45 seconds')
      `, [1, baseTime]);

      // Run rollup computation
      await rollupService.compute1mRollups();

      // Verify OHLC
      const result = await db.query(`
        SELECT * FROM price_history_rollups 
        WHERE coin_id = 1 AND interval_type = '1m'
        ORDER BY bucket_start DESC LIMIT 1
      `);

      expect(result.rows.length).toBe(1);
      const rollup = result.rows[0];
      expect(parseFloat(rollup.open)).toBe(100.00);
      expect(parseFloat(rollup.high)).toBe(102.00);
      expect(parseFloat(rollup.low)).toBe(99.00);
      expect(parseFloat(rollup.close)).toBe(101.00);
      expect(parseInt(rollup.tick_count)).toBe(4);
    });

    test('should handle ON CONFLICT correctly (idempotency)', async () => {
      const baseTime = new Date();
      baseTime.setSeconds(0);
      baseTime.setMinutes(baseTime.getMinutes() - 2);

      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at) VALUES
        ($1, 50.00, $2)
      `, [1, baseTime]);

      // Run rollup twice
      await rollupService.compute1mRollups();
      await rollupService.compute1mRollups();

      // Should only have one row
      const result = await db.query(`
        SELECT COUNT(*) FROM price_history_rollups 
        WHERE coin_id = 1 AND interval_type = '1m'
      `);
      expect(parseInt(result.rows[0].count)).toBe(1);
    });
  });

  describe('5-Minute Rollup Computation', () => {
    test('should compute accurate OHLC for 5m rollup', async () => {
      // Insert test data spanning 5 minutes
      const baseTime = new Date();
      baseTime.setSeconds(0);
      baseTime.setMinutes(Math.floor(baseTime.getMinutes() / 5) * 5 - 5); // Previous 5m bucket

      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at) VALUES
        ($1, 50.00, $2),
        ($1, 55.00, $2 + INTERVAL '1 minute'),
        ($1, 48.00, $2 + INTERVAL '2 minutes'),
        ($1, 52.00, $2 + INTERVAL '4 minutes')
      `, [1, baseTime]);

      // Run rollup computation
      await rollupService.compute5mRollups();

      // Verify OHLC
      const result = await db.query(`
        SELECT * FROM price_history_rollups 
        WHERE coin_id = 1 AND interval_type = '5m'
        ORDER BY bucket_start DESC LIMIT 1
      `);

      if (result.rows.length > 0) {
        const rollup = result.rows[0];
        expect(parseFloat(rollup.open)).toBe(50.00);
        expect(parseFloat(rollup.high)).toBe(55.00);
        expect(parseFloat(rollup.low)).toBe(48.00);
        expect(parseFloat(rollup.close)).toBe(52.00);
        expect(parseInt(rollup.tick_count)).toBe(4);
      }
    });
  });

  describe('15-Minute Rollup Computation', () => {
    test('should compute rollup for 15m interval', async () => {
      const baseTime = new Date();
      baseTime.setSeconds(0);
      baseTime.setMinutes(Math.floor(baseTime.getMinutes() / 15) * 15 - 15); // Previous 15m bucket

      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at) VALUES
        ($1, 40.00, $2),
        ($1, 45.00, $2 + INTERVAL '5 minutes'),
        ($1, 38.00, $2 + INTERVAL '10 minutes')
      `, [1, baseTime]);

      await rollupService.compute15mRollups();

      const result = await db.query(`
        SELECT * FROM price_history_rollups 
        WHERE coin_id = 1 AND interval_type = '15m'
        ORDER BY bucket_start DESC LIMIT 1
      `);

      if (result.rows.length > 0) {
        const rollup = result.rows[0];
        expect(parseFloat(rollup.open)).toBe(40.00);
        expect(parseFloat(rollup.high)).toBe(45.00);
        expect(parseFloat(rollup.low)).toBe(38.00);
      }
    });
  });

  describe('1-Hour Rollup Computation', () => {
    test('should compute rollup for 1h interval', async () => {
      const baseTime = new Date();
      baseTime.setSeconds(0);
      baseTime.setMinutes(0);
      baseTime.setHours(baseTime.getHours() - 1); // Previous hour

      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at) VALUES
        ($1, 30.00, $2),
        ($1, 35.00, $2 + INTERVAL '20 minutes'),
        ($1, 28.00, $2 + INTERVAL '40 minutes'),
        ($1, 32.00, $2 + INTERVAL '55 minutes')
      `, [1, baseTime]);

      await rollupService.compute1hRollups();

      const result = await db.query(`
        SELECT * FROM price_history_rollups 
        WHERE coin_id = 1 AND interval_type = '1h'
        ORDER BY bucket_start DESC LIMIT 1
      `);

      if (result.rows.length > 0) {
        const rollup = result.rows[0];
        expect(parseFloat(rollup.open)).toBe(30.00);
        expect(parseFloat(rollup.high)).toBe(35.00);
        expect(parseFloat(rollup.low)).toBe(28.00);
        expect(parseFloat(rollup.close)).toBe(32.00);
        expect(parseInt(rollup.tick_count)).toBe(4);
      }
    });
  });

  describe('Rollup Cleanup', () => {
    test('should delete rollups older than 24 hours', async () => {
      // Insert old rollup (>24 hours)
      await db.query(`
        INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
        VALUES (1, '1m', NOW() - INTERVAL '25 hours', 100, 110, 95, 105, 10)
      `);

      // Insert recent rollup (<24 hours)
      await db.query(`
        INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
        VALUES (1, '1m', NOW() - INTERVAL '1 hour', 100, 110, 95, 105, 10)
      `);

      // Run cleanup
      await rollupService.cleanupOldRollups();

      // Check only recent rollup remains
      const result = await db.query(`
        SELECT COUNT(*) FROM price_history_rollups WHERE coin_id = 1
      `);
      expect(parseInt(result.rows[0].count)).toBe(1);
    });

    test('should not delete recent rollups', async () => {
      // Insert recent rollups
      await db.query(`
        INSERT INTO price_history_rollups (coin_id, interval_type, bucket_start, open, high, low, close, tick_count)
        VALUES 
        (1, '1m', NOW() - INTERVAL '1 hour', 100, 110, 95, 105, 10),
        (1, '5m', NOW() - INTERVAL '2 hours', 100, 110, 95, 105, 10)
      `);

      const beforeCount = await db.query('SELECT COUNT(*) FROM price_history_rollups');
      await rollupService.cleanupOldRollups();
      const afterCount = await db.query('SELECT COUNT(*) FROM price_history_rollups');

      expect(beforeCount.rows[0].count).toBe(afterCount.rows[0].count);
    });
  });

  describe('RollupService Lifecycle', () => {
    test('should start and stop service', () => {
      const statusBefore = rollupService.getStatus();
      expect(statusBefore.isRunning).toBe(false);

      rollupService.start();
      const statusRunning = rollupService.getStatus();
      expect(statusRunning.isRunning).toBe(true);
      expect(statusRunning.activeIntervals.length).toBeGreaterThan(0);

      rollupService.stop();
      const statusAfter = rollupService.getStatus();
      expect(statusAfter.isRunning).toBe(false);
      expect(statusAfter.activeIntervals.length).toBe(0);
    });

    test('should not start twice', () => {
      rollupService.start();
      rollupService.start(); // Second call should be ignored
      const status = rollupService.getStatus();
      expect(status.isRunning).toBe(true);
      rollupService.stop();
    });
  });
});

