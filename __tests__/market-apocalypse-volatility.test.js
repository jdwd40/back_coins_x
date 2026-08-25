// Core 2 integration, RESTORED legacy suite (deleted by mistake during the
// V2-1 implementation; restored and adapted to the V2 deterministic market).
//
// Pre-V2 this suite drove the random-walk simulator with injected
// Math.random() and in-memory volatility maps. V2-1 replaced that machinery
// with the shared deterministic market domain (game/marketDomain.js): prices
// are a pure function of (persisted cycle seed, persisted cycle baseline,
// persisted cycle window, authoritative time, Core 2 amplitude). The
// regression coverage is preserved against the V2 interfaces:
//   * batch state resolution — updateAllPrices reconciles authoritative
//     Core 1 state exactly once per batch, not per coin;
//   * amplitude application — the Core 2 factor derived from Core 1 progress
//     reaches every calculateNewPrice(coin, marketContext) call and the
//     shared domain as marketContext.amplitude;
//   * direction/scaling — deterministic domain observations replace the old
//     Math.random direction injection: both movement directions remain
//     possible at the absolute maximum factor, and the late-cycle factor
//     produces a strictly larger excursion than the cycle-start factor;
//   * safety guards — prices stay finite/positive at the maximum factor,
//     invalid amplitudes fall back to normal volatility, and a fundamentally
//     invalid calculated price fails the whole batch with nothing written;
//   * lifecycle isolation — importing/running the writer creates no
//     obsolete per-coin event timers or in-memory pricing maps.

const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const {
  getApocalypseVolatility,
  ABSOLUTE_MAX_APOCALYPSE_FACTOR
} = require('../game/apocalypseVolatility');
const marketDomain = require('../game/marketDomain');
const db = require('../db/connection');

jest.setTimeout(20000);

const CYCLE_START = new Date('2026-08-25T12:00:00.000Z');
const DURATION_MS = 30 * 60 * 1000;
// Exactly mid-cycle: deriveProgress yields apocalypsePercent 50 here.
const MID_CYCLE_MS = CYCLE_START.getTime() + DURATION_MS / 2;

// Deterministic domain fixture (no database): a roster coin on a fixed seed.
const DOMAIN_FIXTURE = {
  seed: 'v2-volatility-fixture',
  coinId: 1, // ZIP archetype on the gameplay roster
  baselinePrice: 100,
  roundStartMs: CYCLE_START.getTime()
};

// Create the real aligned cycle (12:00-12:30) on the disposable test DB,
// then pin the writer's Core 1 resolution and clock to exactly mid-cycle so
// no collapse reconciliation or rollover can disturb the batch under test.
async function pinMidCycle() {
  const cycle = await gameCycleService.reconcileCycle({
    now: new Date(CYCLE_START.getTime() + 7 * 60 * 1000)
  });
  jest.spyOn(gameCycleService, 'reconcileCycle').mockResolvedValue(cycle);
  jest.spyOn(Date, 'now').mockReturnValue(MID_CYCLE_MS);
  return cycle;
}

describe('Core 2: apocalypse volatility in the V2 market writer', () => {
  beforeEach(() => {
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  describe('batch state resolution', () => {
    test('updateAllPrices resolves authoritative Core 1 state exactly once per batch, not per coin', async () => {
      const { rows } = await db.query('SELECT coin_id FROM coins');
      expect(rows.length).toBeGreaterThan(1);

      await pinMidCycle();
      const spy = gameCycleService.reconcileCycle; // already the spy
      await marketSimulator.updateAllPrices();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('updateAllPrices applies the Core 2 amplitude derived from Core 1 progress to every coin calculation', async () => {
      const cycle = await pinMidCycle();
      const calcSpy = jest.spyOn(marketSimulator, 'calculateNewPrice');

      await marketSimulator.updateAllPrices();

      const { apocalypsePercent } = gameCycleService.deriveProgress({
        startTime: cycle.start_time,
        endTime: cycle.end_time,
        durationMs: cycle.duration_ms,
        now: new Date(MID_CYCLE_MS)
      });
      expect(apocalypsePercent).toBe(50); // pinned exactly mid-cycle
      const expectedAmplitude = getApocalypseVolatility(apocalypsePercent);

      expect(calcSpy).toHaveBeenCalled();
      const { rows: coins } = await db.query('SELECT count(*)::int AS n FROM coins');
      expect(calcSpy).toHaveBeenCalledTimes(coins[0].n); // every live coin, exactly once
      for (const call of calcSpy.mock.calls) {
        const marketContext = call[1];
        expect(marketContext.amplitude).toBe(expectedAmplitude);
        expect(marketContext.seed).toBe(cycle.seed);
        expect(marketContext.roundStartMs).toBe(new Date(cycle.start_time).getTime());
        expect(marketContext.nowMs).toBe(MID_CYCLE_MS);
      }
    });

    test('every calculateNewPrice call reaches the shared domain with the same Core 2 amplitude', async () => {
      const cycle = await pinMidCycle();
      const domainSpy = jest.spyOn(marketDomain, 'evaluateMarketPoint');

      await marketSimulator.updateAllPrices();

      const { apocalypsePercent } = gameCycleService.deriveProgress({
        startTime: cycle.start_time,
        endTime: cycle.end_time,
        durationMs: cycle.duration_ms,
        now: new Date(MID_CYCLE_MS)
      });
      const expectedAmplitude = getApocalypseVolatility(apocalypsePercent);
      expect(domainSpy).toHaveBeenCalled();
      for (const call of domainSpy.mock.calls) {
        expect(call[0].seed).toBe(cycle.seed);
        expect(call[0].nowMs).toBe(MID_CYCLE_MS);
        expect(call[0].amplitude).toBe(expectedAmplitude);
      }
    });
  });

  describe('deterministic amplitude: direction and scaling', () => {
    // The pre-V2 suite injected Math.random() to force up/down moves. V2 has
    // no random component: direction is observed deterministically by
    // sweeping the shared domain across the cycle instead.
    test('both upward and downward movement remain possible at the maximum apocalypse factor', () => {
      let movedUp = false;
      let movedDown = false;
      for (let offset = 0; offset <= DURATION_MS; offset += 30000) {
        const { price } = marketDomain.evaluateMarketPoint({
          ...DOMAIN_FIXTURE,
          nowMs: CYCLE_START.getTime() + offset,
          amplitude: ABSOLUTE_MAX_APOCALYPSE_FACTOR
        });
        if (price > DOMAIN_FIXTURE.baselinePrice) movedUp = true;
        if (price < DOMAIN_FIXTURE.baselinePrice) movedDown = true;
      }
      expect(movedUp).toBe(true);
      expect(movedDown).toBe(true);
    });

    test('both directions remain possible at cycle start (factor 1) and late cycle', () => {
      for (const amplitude of [getApocalypseVolatility(0), getApocalypseVolatility(90)]) {
        let movedUp = false;
        let movedDown = false;
        for (let offset = 0; offset <= DURATION_MS; offset += 30000) {
          const { price } = marketDomain.evaluateMarketPoint({
            ...DOMAIN_FIXTURE,
            nowMs: CYCLE_START.getTime() + offset,
            amplitude
          });
          if (price > DOMAIN_FIXTURE.baselinePrice) movedUp = true;
          if (price < DOMAIN_FIXTURE.baselinePrice) movedDown = true;
        }
        expect(movedUp).toBe(true);
        expect(movedDown).toBe(true);
      }
    });

    test('the late-cycle factor produces a larger movement excursion than the start factor', () => {
      const excursion = (amplitude) => {
        let min = Infinity;
        let max = -Infinity;
        for (let offset = 0; offset < 10 * 60 * 1000; offset += 15000) {
          const { price } = marketDomain.evaluateMarketPoint({
            ...DOMAIN_FIXTURE,
            nowMs: CYCLE_START.getTime() + offset,
            amplitude
          });
          min = Math.min(min, price);
          max = Math.max(max, price);
        }
        return max - min;
      };

      const earlyExcursion = excursion(getApocalypseVolatility(0));
      const lateExcursion = excursion(getApocalypseVolatility(90));
      expect(lateExcursion).toBeGreaterThan(earlyExcursion);
    });
  });

  describe('safety guards', () => {
    test('prices stay finite and positive for every roster coin across the whole cycle even at the absolute maximum factor', () => {
      for (const coinId of marketDomain.GAMEPLAY_ROSTER.keys()) {
        for (let offset = 0; offset <= DURATION_MS; offset += 30000) {
          const { price } = marketDomain.evaluateMarketPoint({
            seed: DOMAIN_FIXTURE.seed,
            coinId,
            baselinePrice: 1,
            roundStartMs: DOMAIN_FIXTURE.roundStartMs,
            nowMs: CYCLE_START.getTime() + offset,
            amplitude: ABSOLUTE_MAX_APOCALYPSE_FACTOR
          });
          expect(Number.isFinite(price)).toBe(true);
          expect(price).toBeGreaterThan(0);
          // Persisted precision preserves the strictly-positive invariant.
          const persisted = marketDomain.roundGamePrice(price);
          expect(Number.isFinite(persisted)).toBe(true);
          expect(persisted).toBeGreaterThan(0);
        }
      }
    });

    test.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['zero', 0],
      ['negative', -2],
      ['undefined', undefined]
    ])('an invalid amplitude (%s) safely falls back to normal volatility', (_label, amplitude) => {
      const guarded = marketDomain.evaluateMarketPoint({
        ...DOMAIN_FIXTURE,
        nowMs: MID_CYCLE_MS,
        amplitude
      });
      const normal = marketDomain.evaluateMarketPoint({
        ...DOMAIN_FIXTURE,
        nowMs: MID_CYCLE_MS,
        amplitude: 1
      });
      expect(guarded).toEqual(normal);
    });

    test('a fundamentally invalid calculated price fails the batch: nothing is written', async () => {
      await pinMidCycle();

      const before = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
      const historyBefore = await db.query('SELECT COUNT(*) AS count FROM price_history');
      const marketHistoryBefore = await db.query('SELECT COUNT(*) AS count FROM market_history');

      jest.spyOn(marketSimulator, 'calculateNewPrice').mockReturnValue(NaN);
      await marketSimulator.updateAllPrices();

      const after = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
      const historyAfter = await db.query('SELECT COUNT(*) AS count FROM price_history');
      const marketHistoryAfter = await db.query('SELECT COUNT(*) AS count FROM market_history');
      expect(after.rows).toEqual(before.rows);
      expect(historyAfter.rows[0].count).toBe(historyBefore.rows[0].count);
      expect(marketHistoryAfter.rows[0].count).toBe(marketHistoryBefore.rows[0].count);
    });
  });

  describe('lifecycle isolation', () => {
    test('importing the module and running a batch creates no pricing timers and no obsolete per-coin event state', async () => {
      await pinMidCycle();
      await marketSimulator.updateAllPrices();

      // The batch interval belongs to start() only — a manual batch leaves none.
      expect(marketSimulator.updateIntervalId).toBeNull();
      // The V2 writer holds no pre-V2 per-coin in-memory pricing/event state.
      expect(marketSimulator.coinEvents).toBeUndefined();
      expect(marketSimulator.coinVolatility).toBeUndefined();
      expect(marketSimulator.initialPrices).toBeUndefined();
      expect(marketSimulator.cycleTimeout).toBeUndefined();
    });

    test('start() owns exactly one batch interval and no per-coin event timers', async () => {
      await pinMidCycle();

      await marketSimulator.start();
      expect(marketSimulator.isRunning).toBe(true);
      expect(marketSimulator.updateIntervalId).not.toBeNull();
      expect(marketSimulator.coinEvents).toBeUndefined();
      expect(marketSimulator.coinVolatility).toBeUndefined();
      expect(marketSimulator.initialPrices).toBeUndefined();

      // Drain the immediate batch start() fired before the next test reseeds
      // (restore the pinned clock first so the deadline uses the real clock).
      jest.restoreAllMocks();
      const deadline = Date.now() + 5000;
      while (marketSimulator.lastBatch === null && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      marketSimulator.stop();
      expect(marketSimulator.lastBatch).not.toBeNull(); // the batch really completed
      expect(marketSimulator.updateIntervalId).toBeNull();
    });
  });
});
