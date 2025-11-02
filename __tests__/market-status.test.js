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

      // Helper function to convert HH:MM:SS to seconds
      const timeToSeconds = (timeStr) => {
        const [hours, minutes, seconds] = timeStr.split(':').map(Number);
        return hours * 3600 + minutes * 60 + seconds;
      };

      // Verify time remaining has decreased
      const time1 = timeToSeconds(response1.body.currentCycle.timeRemaining);
      const time2 = timeToSeconds(response2.body.currentCycle.timeRemaining);
      expect(time2).toBeLessThan(time1);

      // Check events time remaining
      const event1 = response1.body.events[0];
      const event2 = response2.body.events.find(e => e.coinId === event1.coinId);
      if (event2) { // Same event might still be active
        const eventTime1 = timeToSeconds(event1.timeRemaining);
        const eventTime2 = timeToSeconds(event2.timeRemaining);
        expect(eventTime2).toBeLessThan(eventTime1);
      }
    });
  });
});
