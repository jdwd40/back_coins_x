const db = require('../db/connection');
const seed = require('../db/seed');

describe('Phase 1: Cleanup and Timestamp Fixes', () => {
  beforeEach(async () => {
    await seed();
  });

  describe('90-day data retention (supports 30D/ALL chart ranges)', () => {
    test('cleanup_price_history should drop data older than 90 days and keep 30D-window data', async () => {
      const testCoinId = 1;

      // Outside retention window
      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at)
        VALUES ($1, 100.00, NOW() - INTERVAL '91 days')
      `, [testCoinId]);

      // Inside 30D / 90D windows (must survive)
      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at)
        VALUES
          ($1, 105.00, NOW() - INTERVAL '29 days'),
          ($1, 110.00, NOW() - INTERVAL '14 days'),
          ($1, 115.00, NOW() - INTERVAL '3 days'),
          ($1, 120.00, NOW() - INTERVAL '1 day')
      `, [testCoinId]);

      const beforeResult = await db.query(`
        SELECT COUNT(*) FROM price_history WHERE coin_id = $1
      `, [testCoinId]);
      expect(parseInt(beforeResult.rows[0].count)).toBeGreaterThanOrEqual(5);

      await db.query('SELECT cleanup_price_history()');

      const oldDataResult = await db.query(`
        SELECT COUNT(*)
        FROM price_history
        WHERE coin_id = $1
          AND created_at < NOW() - INTERVAL '90 days'
      `, [testCoinId]);
      expect(parseInt(oldDataResult.rows[0].count)).toBe(0);

      const recentDataResult = await db.query(`
        SELECT COUNT(*)
        FROM price_history
        WHERE coin_id = $1
          AND created_at >= NOW() - INTERVAL '30 days'
      `, [testCoinId]);
      expect(parseInt(recentDataResult.rows[0].count)).toBeGreaterThanOrEqual(4);
    });

    test('cleanup_price_history should not delete data within 90 days', async () => {
      const testCoinId = 2;

      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at)
        VALUES
          ($1, 100.00, NOW() - INTERVAL '45 days'),
          ($1, 105.00, NOW() - INTERVAL '20 days'),
          ($1, 110.00, NOW() - INTERVAL '1 day'),
          ($1, 115.00, NOW() - INTERVAL '6 hours')
      `, [testCoinId]);

      const beforeResult = await db.query(`
        SELECT COUNT(*) FROM price_history WHERE coin_id = $1
      `, [testCoinId]);
      const beforeCount = parseInt(beforeResult.rows[0].count);

      await db.query('SELECT cleanup_price_history()');

      const afterResult = await db.query(`
        SELECT COUNT(*) FROM price_history WHERE coin_id = $1
      `, [testCoinId]);
      expect(parseInt(afterResult.rows[0].count)).toBe(beforeCount);
    });
  });

  describe('Timestamp column standardization', () => {
    test('should use created_at column (not recorded_at)', async () => {
      // Check column name in schema
      const columnCheck = await db.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'price_history'
        AND column_name = 'created_at'
      `);

      expect(columnCheck.rows.length).toBe(1);
      expect(columnCheck.rows[0].column_name).toBe('created_at');
    });

    test('created_at should be TIMESTAMPTZ type', async () => {
      const columnCheck = await db.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_name = 'price_history'
        AND column_name = 'created_at'
      `);

      expect(columnCheck.rows.length).toBe(1);
      const dataType = columnCheck.rows[0].data_type;
      const udtName = columnCheck.rows[0].udt_name;
      
      // Should be timestamp with time zone
      expect(dataType === 'timestamp with time zone' || udtName === 'timestamptz').toBe(true);
    });

    test('created_at should store timezone information correctly', async () => {
      const testCoinId = 1;
      const testPrice = 123.45;
      
      // Insert a record
      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at)
        VALUES ($1, $2, NOW())
      `, [testCoinId, testPrice]);

      // Retrieve and check timezone is preserved
      const result = await db.query(`
        SELECT created_at, 
               pg_typeof(created_at) as column_type
        FROM price_history
        WHERE coin_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [testCoinId]);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].column_type).toContain('timestamp');
      expect(result.rows[0].created_at).toBeInstanceOf(Date);
    });
  });

  describe('Covering index', () => {
    test('should have covering index on (coin_id, created_at DESC) INCLUDE (price)', async () => {
      // Check if the covering index exists
      const indexCheck = await db.query(`
        SELECT 
          i.indexname,
          i.indexdef
        FROM pg_indexes i
        WHERE i.tablename = 'price_history'
        AND i.indexname = 'idx_price_history_covering'
      `);

      expect(indexCheck.rows.length).toBe(1);
      expect(indexCheck.rows[0].indexdef).toContain('coin_id');
      expect(indexCheck.rows[0].indexdef).toContain('created_at');
      expect(indexCheck.rows[0].indexdef).toContain('price');
    });

    test('queries should use covering index for efficient lookups', async () => {
      // Insert some test data
      const testCoinId = 1;
      for (let i = 0; i < 10; i++) {
        await db.query(`
          INSERT INTO price_history (coin_id, price, created_at)
          VALUES ($1, $2, NOW() - INTERVAL '${i} hours')
        `, [testCoinId, 100 + i]);
      }

      // Explain the query to check index usage
      const explainResult = await db.query(`
        EXPLAIN (FORMAT JSON)
        SELECT created_at, price
        FROM price_history
        WHERE coin_id = $1
        ORDER BY created_at DESC
        LIMIT 10
      `, [testCoinId]);

      const plan = JSON.stringify(explainResult.rows[0]);
      
      // The plan should mention our covering index
      // Note: This test may need adjustment based on actual query planner behavior
      expect(plan).toContain('idx_price_history_covering');
    });
  });
});

