const marketSimulator = require('../models/market-simulator');
const db = require('../db/connection');
const seed = require('../db/seed');

// Increase timeout for market simulator tests
jest.setTimeout(10000);

describe('Market Simulator', () => {
  // Run once before all tests
  beforeAll(async () => {
    await seed();
  });

  // Run before each test
  beforeEach(async () => {
    // Ensure simulator is stopped
    marketSimulator.stop();
    // Reseed database
    await seed();
  });

  // Run after each test
  afterEach(async () => {
    // Stop simulator
    marketSimulator.stop();
    // Wait a moment to ensure all DB operations complete
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  // Run once after all tests
  afterAll(async () => {
    marketSimulator.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    await db.end();
  });

  test('should update prices when simulation starts', async () => {
    // Get initial prices
    const initialResult = await db.query('SELECT coin_id, current_price FROM coins');
    const initialPrices = new Map(
      initialResult.rows.map(row => [row.coin_id, parseFloat(row.current_price)])
    );

    // Start simulation with faster updates for testing
    marketSimulator.priceUpdateInterval = 1000; // Override for testing
    marketSimulator.start();

    // Wait for a price update cycle
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get updated prices
    const updatedResult = await db.query('SELECT coin_id, current_price FROM coins');
    const updatedPrices = new Map(
      updatedResult.rows.map(row => [row.coin_id, parseFloat(row.current_price)])
    );

    // Check that prices have changed
    let pricesChanged = false;
    for (const [coinId, initialPrice] of initialPrices) {
      const updatedPrice = updatedPrices.get(coinId);
      if (updatedPrice !== initialPrice) {
        pricesChanged = true;
        break;
      }
    }
    expect(pricesChanged).toBe(true);
  });

  test('should record price history during simulation', async () => {
    // Get initial price history count
    const initialResult = await db.query('SELECT COUNT(*) FROM price_history');
    const initialCount = parseInt(initialResult.rows[0].count);

    // Start simulation with faster updates for testing
    marketSimulator.priceUpdateInterval = 1000; // Override for testing
    marketSimulator.start();

    // Wait for a price update cycle
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get updated price history count
    const updatedResult = await db.query('SELECT COUNT(*) FROM price_history');
    const updatedCount = parseInt(updatedResult.rows[0].count);

    // Should have more price history records
    expect(updatedCount).toBeGreaterThan(initialCount);
  });

  test('should stop updating prices when simulation stops', async () => {
    // Start simulation with faster updates for testing
    marketSimulator.priceUpdateInterval = 1000; // Override for testing
    marketSimulator.start();

    // Wait for first update
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get prices after first update
    const firstResult = await db.query('SELECT coin_id, current_price FROM coins');
    const firstPrices = new Map(
      firstResult.rows.map(row => [row.coin_id, parseFloat(row.current_price)])
    );

    // Stop simulation
    marketSimulator.stop();

    // Wait what would be another update cycle
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get prices after waiting
    const secondResult = await db.query('SELECT coin_id, current_price FROM coins');
    const secondPrices = new Map(
      secondResult.rows.map(row => [row.coin_id, parseFloat(row.current_price)])
    );

    // Prices should not have changed after stopping
    for (const [coinId, firstPrice] of firstPrices) {
      const secondPrice = secondPrices.get(coinId);
      expect(secondPrice).toBe(firstPrice);
    }
  });
});
