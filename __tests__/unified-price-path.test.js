// SIM-08: live writer parity with the unified price engine.
//
// The live market writer (models/market-simulator.js — the only writer of
// coins.current_price and MARKET_TICK history) must persist EXACTLY what
// the shared pure calculation (game/priceEngine.js) computes from the
// persisted Wave 1/2 authorities for the same batch instant: one price
// path, one rounding rule, no second implementation.

const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const { getApocalypseVolatility } = require('../game/apocalypseVolatility');
const priceEngine = require('../game/priceEngine');
const { loadPricingContext } = require('../game/pricingContext');
const db = require('../db/connection');

jest.setTimeout(20000);

const MID_CYCLE_NOW = new Date('2026-08-25T10:10:00.000Z');

describe('SIM-08 live writer: unified price path parity', () => {
  beforeEach(() => {
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('calculateNewPrice delegates every live coin to priceEngine.unifiedPriceAt', async () => {
    const cycle = await gameCycleService.reconcileCycle({ now: new Date('2026-08-25T10:07:00.000Z') });
    jest.spyOn(gameCycleService, 'reconcileCycle').mockResolvedValue(cycle);
    jest.spyOn(Date, 'now').mockReturnValue(MID_CYCLE_NOW.getTime());
    const engineSpy = jest.spyOn(priceEngine, 'unifiedPriceAt');

    await marketSimulator.updateAllPrices();

    const { rows: coinRows } = await db.query('SELECT count(*)::int AS n FROM coins');
    // One write price + one trend-lookback price per live coin (nothing is
    // collapsed this early in the cycle).
    expect(engineSpy).toHaveBeenCalledTimes(coinRows[0].n * 2);
    for (const call of engineSpy.mock.calls) {
      expect(call[0].seed).toBe(cycle.seed);
      expect(call[0].roundStartMs).toBe(new Date(cycle.start_time).getTime());
      expect([MID_CYCLE_NOW.getTime(), MID_CYCLE_NOW.getTime() - 60_000]).toContain(call[0].nowMs);
      expect(['GROWTH', 'PLATEAU', 'DECLINE', 'COLLAPSE']).toContain(call[0].lifecycleState);
      expect(Number.isFinite(call[0].phaseModifier)).toBe(true);
      expect(Number.isFinite(call[0].eventModifier)).toBe(true);
    }
  });

  test('persisted prices equal the pure unified recomputation from the persisted context', async () => {
    const cycle = await gameCycleService.reconcileCycle({ now: new Date('2026-08-25T10:07:00.000Z') });
    jest.spyOn(gameCycleService, 'reconcileCycle').mockResolvedValue(cycle);
    jest.spyOn(Date, 'now').mockReturnValue(MID_CYCLE_NOW.getTime());

    await marketSimulator.updateAllPrices();

    const { apocalypsePercent } = gameCycleService.deriveProgress({
      startTime: cycle.start_time,
      endTime: cycle.end_time,
      durationMs: cycle.duration_ms,
      now: MID_CYCLE_NOW
    });
    const amplitude = getApocalypseVolatility(apocalypsePercent);
    const nowMs = MID_CYCLE_NOW.getTime();
    const roundStartMs = new Date(cycle.start_time).getTime();

    // Recompute from the same persisted authorities the writer used.
    const pricingContext = await loadPricingContext(db, cycle);
    const { rows: coins } = await db.query(
      'SELECT coin_id, current_price, cycle_baseline_price FROM coins ORDER BY coin_id'
    );
    expect(coins.length).toBeGreaterThan(0);
    for (const coin of coins) {
      const expected = priceEngine.unifiedPriceAt({
        seed: cycle.seed,
        coinId: coin.coin_id,
        baselinePrice: parseFloat(coin.cycle_baseline_price),
        roundStartMs,
        nowMs,
        amplitude,
        lifecycleState: pricingContext.lifecycleState,
        cycleProgress: Math.min(1, Math.max(0, apocalypsePercent / 100)),
        phaseModifier: pricingContext.phaseModifierAt(nowMs),
        eventModifier: pricingContext.eventModifierFor(coin.coin_id, nowMs)
      });
      const persisted = parseFloat(coin.current_price);
      expect(persisted).toBeCloseTo(expected, 8);
      // Exact persisted-precision equality at the 4dp gameplay contract.
      expect(persisted.toFixed(4)).toBe(expected.toFixed(4));
    }
  });

  test('the batch remains deterministic at a pinned instant under the unified path', async () => {
    const cycle = await gameCycleService.reconcileCycle({ now: new Date('2026-08-25T10:07:00.000Z') });
    jest.spyOn(gameCycleService, 'reconcileCycle').mockResolvedValue(cycle);
    jest.spyOn(Date, 'now').mockReturnValue(MID_CYCLE_NOW.getTime());

    await marketSimulator.updateAllPrices();
    const first = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    await marketSimulator.updateAllPrices();
    const second = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    expect(second.rows).toEqual(first.rows);
  });
});
