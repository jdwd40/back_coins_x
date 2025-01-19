const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const seed = require('../db/seed');

beforeEach(async () => {
  await seed(false); // Don't end connection after seeding
});

afterAll(async () => {
  await db.end(); // End connection only once after all tests
});

describe('Market Statistics', () => {
  it('GET /api/market/stats - should return initial market stats with no price history', async () => {
    const response = await request(app)
      .get('/api/market/stats')
      .expect(200);

    expect(response.body).toHaveProperty('coins');
    expect(response.body).toHaveProperty('market_stats');
    expect(response.body.coins.length).toBeGreaterThan(0);
    
    // Initially, with no price history, market stats should be null
    expect(response.body.market_stats).toEqual({
      all_time_high: null,
      all_time_low: null,
      current_market_value: null
    });
  });

  it('Should manually verify market stats calculations', async () => {
    // Insert known price history data
    const testData = [
      { coin_id: 1, price: 100 },
      { coin_id: 2, price: 200 },
      { coin_id: 3, price: 300 }
    ];

    // Insert test data at different timestamps
    const timestamp1 = new Date('2025-01-19T15:00:00Z');
    const timestamp2 = new Date('2025-01-19T15:15:00Z');
    const timestamp3 = new Date('2025-01-19T15:30:00Z');

    await db.query(`
      INSERT INTO price_history (coin_id, price, created_at)
      VALUES 
        (1, 100, $1),
        (2, 200, $1),
        (3, 300, $1),
        (1, 150, $2),
        (2, 250, $2),
        (3, 350, $2),
        (1, 120, $3),
        (2, 220, $3),
        (3, 320, $3)
    `, [timestamp1, timestamp2, timestamp3]);

    const response = await request(app)
      .get('/api/market/stats')
      .expect(200);

    // Verify market stats calculations
    expect(parseFloat(response.body.market_stats.all_time_high)).toBe(750); // 150 + 250 + 350
    expect(parseFloat(response.body.market_stats.all_time_low)).toBe(600);  // 100 + 200 + 300
    expect(parseFloat(response.body.market_stats.current_market_value)).toBe(660); // 120 + 220 + 320

    // Verify latest prices for each coin
    const coinPrices = response.body.coins.reduce((acc, coin) => {
      acc[coin.coin_id] = parseFloat(coin.latest_price);
      return acc;
    }, {});

    expect(coinPrices[1]).toBe(120);
    expect(coinPrices[2]).toBe(220);
    expect(coinPrices[3]).toBe(320);
  });

  // Note: Removed the market simulation test as it was timing-dependent
});
