const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const { updateAllCoinPrices } = require('../models/coins.model');
const seed = require('../db/seed');

describe('Price History', () => {
  beforeAll(async () => {
    await seed();
  });

  describe('Automatic Price Updates', () => {
    test('should record price history for all coins', async () => {
      // Get all coins first
      const coinsResponse = await request(app)
        .get('/api/coins')
        .expect(200);
      const coins = coinsResponse.body.coins;

      // Get initial price histories
      const initialHistories = await Promise.all(
        coins.map(coin => 
          request(app)
            .get(`/api/coins/${coin.coin_id}/price-history`)
            .expect(200)
            .then(res => ({
              coinId: coin.coin_id,
              history: res.body.priceHistory
            }))
        )
      );

      // Do one price update
      await updateAllCoinPrices();

      // Check updated histories
      for (const { coinId, history: initialHistory } of initialHistories) {
        const response = await request(app)
          .get(`/api/coins/${coinId}/price-history`)
          .expect(200);
        
        const updatedHistory = response.body.priceHistory;
        
        // Should have one more record
        expect(updatedHistory.length).toBe(initialHistory.length + 1);
        
        // New price should be different from old price
        const newPrice = parseFloat(updatedHistory[0].price);
        const oldPrice = parseFloat(initialHistory[0].price);
        expect(newPrice).not.toBe(oldPrice);
        
        // Records should be ordered by time (newest first)
        const timestamps = updatedHistory.map(record => new Date(record.timestamp).getTime());
        expect(timestamps[0]).toBeGreaterThan(timestamps[1]);
      }
    });

    test('404: returns not found for non-existent coin price history', () => {
      return request(app)
        .get('/api/coins/999/price-history')
        .expect(404)
        .then(({ body }) => {
          expect(body.error).toBe('Coin not found');
        });
    });
  });
});
