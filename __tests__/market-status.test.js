const request = require('supertest');
const app = require('../app');
const marketSimulator = require('../models/market-simulator');
const seed = require('../db/seed');

describe('Market Status API', () => {
  beforeAll(async () => {
    await seed();
  });

  beforeEach(() => {
    marketSimulator.stop();
  });

  afterEach(() => {
    marketSimulator.stop();
  });

  describe('GET /api/market/status', () => {
    test('returns stopped status when simulator is not running', async () => {
      const response = await request(app)
        .get('/api/market/status')
        .expect(200);

      expect(response.body).toEqual({
        status: 'STOPPED',
        currentCycle: null,
        timeRemaining: 0,
        events: []
      });
    });

    test('returns current market cycle and events when running', async () => {
      // Start simulator with controlled values for testing
      marketSimulator.priceUpdateInterval = 1000;
      marketSimulator.start();

      // Wait for simulator to initialize
      await new Promise(resolve => setTimeout(resolve, 100));

      const response = await request(app)
        .get('/api/market/status')
        .expect(200);

      // Check response structure
      console.log(response.body);
      expect(response.body).toMatchObject({
        status: 'RUNNING',
        currentCycle: expect.objectContaining({
          type: expect.any(String),
          timeRemaining: expect.any(Number)
        }),
        events: expect.arrayContaining([
          expect.objectContaining({
            coinId: expect.any(Number),
            type: expect.any(String),
            timeRemaining: expect.any(Number),
            effect: expect.stringMatching(/^(POSITIVE|NEGATIVE)$/)
          })
        ])
      });

      // Verify time remaining is reasonable
      expect(response.body.currentCycle.timeRemaining).toBeGreaterThan(0);
      expect(response.body.currentCycle.timeRemaining).toBeLessThanOrEqual(120000); // Max 2 minutes

      // Verify events
      expect(response.body.events.length).toBeGreaterThan(0);
      response.body.events.forEach(event => {
        expect(event.timeRemaining).toBeGreaterThan(0);
        expect(event.timeRemaining).toBeLessThanOrEqual(60000); // Max 1 minute
      });
    });

    test('time remaining decreases between requests', async () => {
      // Start simulator
      marketSimulator.priceUpdateInterval = 1000;
      marketSimulator.start();

      // Wait for simulator to initialize
      await new Promise(resolve => setTimeout(resolve, 100));

      // First request
      const response1 = await request(app)
        .get('/api/market/status')
        .expect(200);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Second request
      const response2 = await request(app)
        .get('/api/market/status')
        .expect(200);

      // Verify time remaining has decreased
      expect(response2.body.currentCycle.timeRemaining)
        .toBeLessThan(response1.body.currentCycle.timeRemaining);

      // Check events time remaining
      const event1 = response1.body.events[0];
      const event2 = response2.body.events.find(e => e.coinId === event1.coinId);
      if (event2) { // Same event might still be active
        expect(event2.timeRemaining).toBeLessThan(event1.timeRemaining);
      }
    });
  });
});
