// Milestone 1 hardening: public market start/stop is removed. No legitimate
// consumer exists (the frontend only reads /api/market/status|stats|history;
// there is no admin role anywhere in the app), so an anonymous caller or an
// ordinary authenticated player must NOT be able to control the server-owned
// simulator lifecycle. The lifecycle itself is untouched: app.js still starts
// the simulator in production and server.js still stops it on shutdown.
//
// jest.setup.js reseeds the disposable test database before every test.

const request = require('supertest');
const app = require('../app');
const jwt = require('jsonwebtoken');
const marketSimulator = require('../models/market-simulator');

function playerToken(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET);
}

describe('POST /api/market/start and /stop are removed (no public simulator control)', () => {
  afterEach(() => {
    // The simulator must never be toggled by anything these tests do.
    marketSimulator.stop();
  });

  test('anonymous callers cannot start the market', async () => {
    await request(app).post('/api/market/start').expect(404);
    expect(marketSimulator.getMarketStatus().status).toBe('STOPPED');
  });

  test('anonymous callers cannot stop the market', async () => {
    await request(app).post('/api/market/stop').expect(404);
  });

  test('an authenticated ordinary player cannot start the market', async () => {
    await request(app)
      .post('/api/market/start')
      .set('Authorization', `Bearer ${playerToken(1)}`)
      .expect(404);
    expect(marketSimulator.getMarketStatus().status).toBe('STOPPED');
  });

  test('an authenticated ordinary player cannot stop the market', async () => {
    await request(app)
      .post('/api/market/stop')
      .set('Authorization', `Bearer ${playerToken(1)}`)
      .expect(404);
  });

  test('the server-owned lifecycle hooks are intact and read endpoints still work', async () => {
    // Read-only market surface unaffected.
    await request(app).get('/api/market/status').expect(200);

    // The server (not the API) owns start/stop: they still function when
    // invoked by the process lifecycle itself.
    await marketSimulator.start();
    expect(marketSimulator.getMarketStatus().status).toBe('RUNNING');
    marketSimulator.stop();
    expect(marketSimulator.getMarketStatus().status).toBe('STOPPED');
  });
});
