const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const {
  getApocalypseVolatility,
  ABSOLUTE_MAX_APOCALYPSE_FACTOR
} = require('../game/apocalypseVolatility');
const db = require('../db/connection');

jest.setTimeout(15000);

// Core 2 integration: the existing market simulator scales its automatic
// movement amplitude by the authoritative Core 1 apocalypse progress.
describe('Core 2: apocalypse volatility in the market simulator', () => {
  beforeEach(() => {
    marketSimulator.stop();
    marketSimulator.currentCycle = null;
    marketSimulator.coinEvents.clear();
    marketSimulator.coinVolatility.clear();
    marketSimulator.initialPrices.clear();
  });

  afterEach(() => {
    marketSimulator.stop();
  });

  // Deterministic price-calculation fixture: no market cycle, no events, no
  // trend — only the volatility-scaled random component can move the price,
  // and Math.random is injected so direction is fully controlled.
  function setupCoin(coinId, price) {
    marketSimulator.initialPrices.set(coinId, price);
    marketSimulator.coinVolatility.set(coinId, {
      baseVolatility: 0.5,
      lastUpdate: new Date(),
      trendDirection: 1,
      trendStrength: 0,
      trendDuration: 60000,
      trendStartTime: new Date()
    });
  }

  describe('batch state resolution', () => {
    test('updateAllPrices resolves authoritative Core 1 state exactly once per batch, not per coin', async () => {
      const { rows } = await db.query('SELECT coin_id FROM coins');
      expect(rows.length).toBeGreaterThan(1);

      const spy = jest.spyOn(gameCycleService, 'getGameState');
      await marketSimulator.updateAllPrices();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('updateAllPrices applies the Core 2 factor derived from Core 1 progress to every coin calculation', async () => {
      jest.spyOn(gameCycleService, 'getGameState').mockResolvedValue({
        apocalypseId: 'APOC-0001',
        status: 'ACTIVE',
        apocalypsePercent: 50
      });
      const calcSpy = jest.spyOn(marketSimulator, 'calculateNewPrice');

      await marketSimulator.updateAllPrices();

      const expectedFactor = getApocalypseVolatility(50);
      expect(calcSpy).toHaveBeenCalled();
      for (const call of calcSpy.mock.calls) {
        expect(call[2]).toBe(expectedFactor);
      }
    });
  });

  describe('controlled random injection: direction and amplitude', () => {
    test('upward movement remains possible at the maximum apocalypse factor', () => {
      setupCoin(1, 100);
      jest.spyOn(Math, 'random').mockReturnValue(1); // max positive random component

      const newPrice = marketSimulator.calculateNewPrice(100, 1, ABSOLUTE_MAX_APOCALYPSE_FACTOR);
      expect(newPrice).toBeGreaterThan(100);
    });

    test('downward movement remains possible at the maximum apocalypse factor', () => {
      setupCoin(1, 100);
      jest.spyOn(Math, 'random').mockReturnValue(0); // max negative random component

      const newPrice = marketSimulator.calculateNewPrice(100, 1, ABSOLUTE_MAX_APOCALYPSE_FACTOR);
      expect(newPrice).toBeLessThan(100);
    });

    test('both directions remain possible at cycle start (factor 1) and late cycle', () => {
      setupCoin(1, 100);
      const randomSpy = jest.spyOn(Math, 'random');

      const factors = [getApocalypseVolatility(0), getApocalypseVolatility(90)];
      for (const factor of factors) {
        randomSpy.mockReturnValue(1);
        expect(marketSimulator.calculateNewPrice(100, 1, factor)).toBeGreaterThan(100);
        randomSpy.mockReturnValue(0);
        expect(marketSimulator.calculateNewPrice(100, 1, factor)).toBeLessThan(100);
      }
    });

    test('late-cycle factor produces a larger movement amplitude than the start factor', () => {
      setupCoin(1, 100);
      jest.spyOn(Math, 'random').mockReturnValue(1);

      const earlyMove = Math.abs(marketSimulator.calculateNewPrice(100, 1, getApocalypseVolatility(0)) - 100);
      const lateMove = Math.abs(marketSimulator.calculateNewPrice(100, 1, getApocalypseVolatility(90)) - 100);

      expect(lateMove).toBeGreaterThan(earlyMove);
    });
  });

  describe('safety guards', () => {
    test('prices stay finite, positive and inside the per-update limit even at the absolute maximum factor', () => {
      setupCoin(1, 100);
      const randomSpy = jest.spyOn(Math, 'random');

      for (const randomValue of [0, 0.25, 0.5, 0.75, 1]) {
        randomSpy.mockReturnValue(randomValue);
        const newPrice = marketSimulator.calculateNewPrice(100, 1, ABSOLUTE_MAX_APOCALYPSE_FACTOR);
        expect(Number.isFinite(newPrice)).toBe(true);
        expect(newPrice).toBeGreaterThan(0);
        // Existing 0.5% per-update protection still bounds every move.
        expect(Math.abs(newPrice - 100) / 100).toBeLessThanOrEqual(0.005 + 1e-9);
      }
    });

    test.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['zero', 0],
      ['negative', -2],
      ['undefined', undefined]
    ])('an invalid multiplier (%s) safely falls back to normal volatility', (_label, multiplier) => {
      setupCoin(1, 100);
      jest.spyOn(Math, 'random').mockReturnValue(1);

      const guarded = marketSimulator.calculateNewPrice(100, 1, multiplier);
      const normal = marketSimulator.calculateNewPrice(100, 1, 1);
      expect(guarded).toBe(normal);
    });

    test('a fundamentally invalid calculated price fails the batch: nothing is written', async () => {
      // Isolate the batch guard from Core 3 lifecycle work: a real
      // getGameState() reconciles due collapses whenever the wall clock is
      // inside a cycle's collapse window, which is legitimate behaviour but
      // not what this test measures. Pin a stable mid-cycle state instead
      // (same pattern as the factor test above).
      jest.spyOn(gameCycleService, 'getGameState').mockResolvedValue({
        apocalypseId: 'APOC-0001',
        status: 'ACTIVE',
        apocalypsePercent: 50
      });

      const before = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
      const historyBefore = await db.query('SELECT COUNT(*) AS count FROM price_history');

      jest.spyOn(marketSimulator, 'calculateNewPrice').mockReturnValue(NaN);
      await marketSimulator.updateAllPrices();

      const after = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
      const historyAfter = await db.query('SELECT COUNT(*) AS count FROM price_history');

      expect(after.rows).toEqual(before.rows);
      expect(historyAfter.rows[0].count).toBe(historyBefore.rows[0].count);
    });
  });

  describe('lifecycle isolation', () => {
    test('Core 2 adds no timers: importing the module and resolving state creates none', async () => {
      await marketSimulator.updateAllPrices();
      expect(marketSimulator.updateIntervalId).toBeNull();
      expect(marketSimulator.cycleTimeout).toBeNull();
    });
  });
});
