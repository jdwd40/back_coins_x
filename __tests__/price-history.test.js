const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const coinsModel = require('../models/coins.model');
const seed = require('../db/seed');

describe('Price History', () => {
  beforeEach(async () => {
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
              history: res.body.data || []
            }))
        )
      );

      // Do one price update for each coin
      await Promise.all(
        coins.map(async (coin) => {
          // Get current price and update with a small change
          const currentPrice = parseFloat(coin.current_price.replace(/[£,]/g, ''));
          const newPrice = currentPrice * 1.01; // 1% increase
          return coinsModel.updateCoinPrice(coin.coin_id, newPrice);
        })
      );

      // Check updated histories
      for (const { coinId, history: initialHistory } of initialHistories) {
        const response = await request(app)
          .get(`/api/coins/${coinId}/price-history`)
          .expect(200);
        
        const updatedHistory = response.body.data || [];
        
        // Should have one more record
        expect(updatedHistory.length).toBe(initialHistory.length + 1);
        
        // Records should be ordered by time (newest first) - only check if we have 2+ records
        if (updatedHistory.length >= 2) {
          const timestamps = updatedHistory.map(record => new Date(record.created_at).getTime());
          expect(timestamps[0]).toBeGreaterThan(timestamps[1]);
        }
      }
    });

    test('404: returns not found for non-existent coin price history', () => {
      return request(app)
        .get('/api/coins/999/price-history')
        .expect(404)
        .then(({ body }) => {
          expect(body.msg).toBe('Coin not found');
        });
    });
  });
});
