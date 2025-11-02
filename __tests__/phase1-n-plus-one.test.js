const db = require('../db/connection');
const seed = require('../db/seed');
const coinsModel = require('../models/coins.model');

describe('Phase 1: N+1 Query Fix', () => {
  beforeEach(async () => {
    await seed();
  });

  describe('selectAllCoins() query optimization', () => {
    let originalQuery;
    let queryCount;
    let queries;

    beforeEach(() => {
      // Setup query counter
      queryCount = 0;
      queries = [];
      originalQuery = db.query;
      
      // Mock db.query to count queries
      db.query = jest.fn(async (...args) => {
        queryCount++;
        queries.push(args[0]);
        return originalQuery.apply(db, args);
      });
    });

    afterEach(() => {
      // Restore original query function
      db.query = originalQuery;
    });

    test('selectAllCoins should make minimal database queries', async () => {
      // Insert price history for testing
      const coins = await originalQuery('SELECT coin_id FROM coins ORDER BY coin_id ASC LIMIT 5');
      
      for (const coin of coins.rows) {
        // Add some price history
        await originalQuery(`
          INSERT INTO price_history (coin_id, price, created_at)
          VALUES 
            ($1, 100.00, NOW() - INTERVAL '25 hours'),
            ($1, 105.00, NOW() - INTERVAL '12 hours'),
            ($1, 110.00, NOW() - INTERVAL '1 hour')
        `, [coin.coin_id]);
      }

      // Reset counter
      queryCount = 0;
      queries = [];

      // Call selectAllCoins
      const result = await coinsModel.selectAllCoins();

      // Should make very few queries (ideally 1-2 max)
      // Currently it makes 1 + (N * 3) queries which is the N+1 problem
      // After fix, should be 1-2 queries total
      console.log(`Query count: ${queryCount}`);
      console.log('Queries:', queries.map(q => 
        typeof q === 'string' ? q.substring(0, 100) : 'non-string query'
      ));
      
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // After optimization, this should be <= 2 queries
      // Before fix: 1 + (5 coins × 3 queries each) = 16 queries
      // After fix: 1 query for everything
      expect(queryCount).toBeLessThanOrEqual(2);
    });

    test('selectAllCoins should return correct price_change_24h', async () => {
      // Get a coin to test with
      const coinResult = await originalQuery('SELECT coin_id FROM coins LIMIT 1');
      const testCoinId = coinResult.rows[0].coin_id;

      // Insert known price history
      await originalQuery(`
        INSERT INTO price_history (coin_id, price, created_at)
        VALUES 
          ($1, 100.00, NOW() - INTERVAL '25 hours'),
          ($1, 120.00, NOW() - INTERVAL '1 hour')
      `, [testCoinId]);

      // Call selectAllCoins
      const result = await coinsModel.selectAllCoins();
      
      // Find our test coin
      const testCoin = result.find(c => c.coin_id === testCoinId);
      
      expect(testCoin).toBeDefined();
      expect(testCoin.price_change_24h).toBeDefined();
      
      // Price went from 100 to 120 = 20% increase
      // Should be approximately 20
      const priceChange = typeof testCoin.price_change_24h === 'string' 
        ? parseFloat(testCoin.price_change_24h) 
        : testCoin.price_change_24h;
      
      expect(Math.abs(priceChange - 20)).toBeLessThan(1);
    });

    test('selectAllCoins should handle coins with no price history', async () => {
      // Clear all price history
      await originalQuery('DELETE FROM price_history');

      // Call selectAllCoins
      const result = await coinsModel.selectAllCoins();
      
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      
      // All coins should have price_change_24h of null (no history)
      result.forEach(coin => {
        expect(coin.price_change_24h).toBe(null);
      });
    });

    test('selectAllCoins should handle coins with only recent price history', async () => {
      // Get a coin to test with
      const coinResult = await originalQuery('SELECT coin_id FROM coins LIMIT 1');
      const testCoinId = coinResult.rows[0].coin_id;

      // Clear existing history for this coin
      await originalQuery('DELETE FROM price_history WHERE coin_id = $1', [testCoinId]);

      // Insert only recent prices (no 24h old data)
      await originalQuery(`
        INSERT INTO price_history (coin_id, price, created_at)
        VALUES 
          ($1, 100.00, NOW() - INTERVAL '2 hours'),
          ($1, 105.00, NOW() - INTERVAL '1 hour')
      `, [testCoinId]);

      // Call selectAllCoins
      const result = await coinsModel.selectAllCoins();
      
      // Find our test coin
      const testCoin = result.find(c => c.coin_id === testCoinId);
      
      expect(testCoin).toBeDefined();
      expect(testCoin.price_change_24h).toBeDefined();
      
      // Should calculate from earliest available price
      const priceChange = typeof testCoin.price_change_24h === 'string' 
        ? parseFloat(testCoin.price_change_24h) 
        : testCoin.price_change_24h;
      
      // Price went from 100 to 105 = 5% increase
      expect(Math.abs(priceChange - 5)).toBeLessThan(1);
    });

    test('selectAllCoins optimized query should return same data structure', async () => {
      // Get reference data using current implementation
      const result = await coinsModel.selectAllCoins();
      
      // Verify structure
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      
      result.forEach(coin => {
        expect(coin).toHaveProperty('coin_id');
        expect(coin).toHaveProperty('name');
        expect(coin).toHaveProperty('symbol');
        expect(coin).toHaveProperty('current_price');
        expect(coin).toHaveProperty('market_cap');
        expect(coin).toHaveProperty('circulating_supply');
        expect(coin).toHaveProperty('price_change_24h');
        expect(coin).toHaveProperty('founder');
        
        // Prices should be formatted as currency strings
        expect(typeof coin.current_price).toBe('string');
        expect(coin.current_price).toMatch(/[£$€]/);
      });
    });
  });

  describe('selectCoinById() should also be efficient', () => {
    test('selectCoinById should make minimal queries', async () => {
      // Get a test coin
      const coinResult = await db.query('SELECT coin_id FROM coins LIMIT 1');
      const testCoinId = coinResult.rows[0].coin_id;

      // Add price history
      await db.query(`
        INSERT INTO price_history (coin_id, price, created_at)
        VALUES 
          ($1, 100.00, NOW() - INTERVAL '25 hours'),
          ($1, 110.00, NOW() - INTERVAL '1 hour')
      `, [testCoinId]);

      // Count queries
      let queryCount = 0;
      const originalQuery = db.query;
      db.query = jest.fn(async (...args) => {
        queryCount++;
        return originalQuery.apply(db, args);
      });

      // Call selectCoinById
      const result = await coinsModel.selectCoinById(testCoinId);

      // Restore
      db.query = originalQuery;

      expect(result).toBeDefined();
      expect(result.coin_id).toBe(testCoinId);
      
      // Should make minimal queries (2-3 max)
      expect(queryCount).toBeLessThanOrEqual(4);
    });
  });
});

