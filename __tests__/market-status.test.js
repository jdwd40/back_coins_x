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
      expect(response.body).toMatchObject({
        status: 'RUNNING',
        currentCycle: expect.objectContaining({
          type: expect.any(String),
          timeRemaining: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/)
        })
      });
      
      // Events should be an array (may be empty if no events triggered yet)
      expect(Array.isArray(response.body.events)).toBe(true);

      // Verify time remaining is in correct format and reasonable
      expect(response.body.currentCycle.timeRemaining).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      
      // Verify events (may be empty if no events triggered yet)
      if (response.body.events.length > 0) {
        response.body.events.forEach(event => {
          expect(event.timeRemaining).toMatch(/^\d{2}:\d{2}:\d{2}$/);
        });
      }
    });

    test('time remaining reflects the writer cadence while running', async () => {
      // V2-1: the cyclical domain holds no in-memory cycles; the status
      // reports the writer's own update cadence (time until the next batch),
      // bounded by the configured interval.
      marketSimulator.priceUpdateInterval = 1000;
      marketSimulator.start();

      // Wait for simulator to initialize and complete a batch
      await new Promise(resolve => setTimeout(resolve, 1500));

      const response = await request(app)
        .get('/api/market/status')
        .expect(200);

      expect(response.body.status).toBe('RUNNING');
      expect(response.body.currentCycle.timeRemaining).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      const [hours, minutes, seconds] = response.body.currentCycle.timeRemaining.split(':').map(Number);
      const totalSeconds = hours * 3600 + minutes * 60 + seconds;
      expect(totalSeconds).toBeLessThanOrEqual(1); // within the 1s test cadence
      expect(response.body.events).toEqual([]); // V2-1: random coin events removed
    });
  });
});
