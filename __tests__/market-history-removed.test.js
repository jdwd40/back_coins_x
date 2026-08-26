// V2 legacy cleanup (#22): GET /api/market/history is removed. It had no
// current frontend consumer (verified against deployed frontend master
// 79b599d3) and its controller called a getMarketHistory model function that
// coins.model.js never exported, so the route could only ever respond 500.
// The consumed aggregate drill-down GET /api/market/price-history and the
// market_history table itself (written by the server-owned simulator, read
// by /api/market/stats) are deliberately untouched.

const request = require('supertest');
const app = require('../app');

describe('GET /api/market/history is removed (dead route, no consumer)', () => {
  test('anonymous callers receive 404, not the old 500 from the missing model function', async () => {
    await request(app).get('/api/market/history').expect(404);
    await request(app).get('/api/market/history?timeRange=1H').expect(404);
  });

  test('the consumed aggregate market price-history endpoint remains available', async () => {
    const { body } = await request(app)
      .get('/api/market/price-history')
      .expect(200);
    expect(Array.isArray(body.history)).toBe(true);
  });

  test('market status and stats reads remain available', async () => {
    await request(app).get('/api/market/status').expect(200);
    await request(app).get('/api/market/stats').expect(200);
  });
});
