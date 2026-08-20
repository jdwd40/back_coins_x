// Core 3 market integration: a collapsed coin is permanently dead for the
// rest of the ACTIVE cycle — the ordinary automatic market update and the
// Core 2 volatility multiplier must never revive it — while surviving coins
// keep updating normally. Zero itself must never trip the simulator's
// invalid-write protection. Malformed persisted state fails safely.

const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const { reconcileCycle } = require('../game/gameCycleService');
const { getApocalypseVolatility } = require('../game/apocalypseVolatility');
const db = require('../db/connection');

jest.setTimeout(15000);

const CYCLE_START = new Date('2026-08-20T10:00:00.000Z');
const DURATION_MS = 30 * 60 * 1000;
const WINDOW_START_MS = CYCLE_START.getTime() + DURATION_MS * 0.70;
const CYCLE_END_MS = CYCLE_START.getTime() + DURATION_MS;
const SPACING_MS = (CYCLE_END_MS - WINDOW_START_MS) / 12;

async function collapseRankZeroCoin() {
  // Create the cycle and reconcile exactly at the first scheduled collapse.
  const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
  const { rows } = await db.query(
    'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
    [cycle.cycle_id]
  );
  await reconcileCycle({ now: new Date(WINDOW_START_MS) });
  return { cycle, coinId: rows[0].coin_id };
}

// Deterministic simulator fixture for every seeded coin: volatility profile
// and initial price set, no market cycle, no events, trend strength zero.
async function setupAllCoins() {
  const { rows } = await db.query('SELECT coin_id, current_price FROM coins');
  for (const coin of rows) {
    const price = parseFloat(coin.current_price);
    marketSimulator.initialPrices.set(coin.coin_id, price);
    marketSimulator.coinVolatility.set(coin.coin_id, {
      baseVolatility: 0.5,
      lastUpdate: new Date(),
      trendDirection: 1,
      trendStrength: 0,
      trendDuration: 60000,
      trendStartTime: new Date()
    });
  }
}

describe('Core 3: collapsed coins in the market simulator', () => {
  beforeEach(() => {
    marketSimulator.stop();
    marketSimulator.currentCycle = null;
    marketSimulator.coinEvents.clear();
    marketSimulator.coinVolatility.clear();
    marketSimulator.initialPrices.clear();
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('the ordinary automatic market update never revives a collapsed coin and never writes new history for it', async () => {
    const { coinId } = await collapseRankZeroCoin();
    await setupAllCoins();

    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    jest.spyOn(Math, 'random').mockReturnValue(1); // maximum upward pressure
    // Keep Core 1 state stable at this point in the cycle for the batch.
    jest.spyOn(gameCycleService, 'getGameState').mockResolvedValue({
      apocalypseId: 'APOC-0001',
      status: 'ACTIVE',
      apocalypsePercent: 75
    });

    await marketSimulator.updateAllPrices();

    const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
    expect(parseFloat(rows[0].current_price)).toBe(0);

    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n); // exactly the £0 transition, no more
  });

  test('Core 2 still applies to surviving coins while the collapsed coin is skipped entirely', async () => {
    const { coinId } = await collapseRankZeroCoin();
    await setupAllCoins();

    jest.spyOn(Math, 'random').mockReturnValue(1);
    jest.spyOn(gameCycleService, 'getGameState').mockResolvedValue({
      apocalypseId: 'APOC-0001',
      status: 'ACTIVE',
      apocalypsePercent: 50
    });
    const calcSpy = jest.spyOn(marketSimulator, 'calculateNewPrice');

    await marketSimulator.updateAllPrices();

    const { rows: coins } = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(calcSpy).toHaveBeenCalledTimes(coins[0].n - 1); // every survivor, never the dead coin
    const expectedFactor = getApocalypseVolatility(50);
    for (const call of calcSpy.mock.calls) {
      expect(call[1]).not.toBe(coinId);
      expect(call[2]).toBe(expectedFactor);
    }

    // Survivors actually moved and recorded history.
    const { rows: survivors } = await db.query('SELECT count(*)::int AS n FROM coins WHERE coin_id <> $1', [coinId]);
    const { rows: survivorHistory } = await db.query('SELECT count(DISTINCT coin_id)::int AS n FROM price_history WHERE coin_id <> $1 AND price > 0', [coinId]);
    expect(survivorHistory[0].n).toBe(survivors[0].n);
  });

  test('a zero-priced dead coin does not trip the invalid-write protection: the batch completes for survivors', async () => {
    await collapseRankZeroCoin();
    await setupAllCoins();
    jest.spyOn(Math, 'random').mockReturnValue(1);
    jest.spyOn(gameCycleService, 'getGameState').mockResolvedValue({
      apocalypseId: 'APOC-0001',
      status: 'ACTIVE',
      apocalypsePercent: 80
    });

    const marketHistoryBefore = await db.query('SELECT count(*)::int AS n FROM market_history');
    await marketSimulator.updateAllPrices();
    const marketHistoryAfter = await db.query('SELECT count(*)::int AS n FROM market_history');

    // The batch committed (market_history written) — zero caused no rollback.
    expect(marketHistoryAfter.rows[0].n).toBe(marketHistoryBefore.rows[0].n + 1);
  });

  test('several collapsed coins all stay dead across repeated updates', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    await reconcileCycle({ now: new Date(WINDOW_START_MS + 3 * SPACING_MS) }); // ranks 0..3 collapsed
    const { rows: deadRows } = await db.query(
      'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND executed_at IS NOT NULL',
      [cycle.cycle_id]
    );
    expect(deadRows).toHaveLength(4);
    await setupAllCoins();
    jest.spyOn(Math, 'random').mockReturnValue(1);
    jest.spyOn(gameCycleService, 'getGameState').mockResolvedValue({
      apocalypseId: 'APOC-0001',
      status: 'ACTIVE',
      apocalypsePercent: 90
    });

    await marketSimulator.updateAllPrices();
    await marketSimulator.updateAllPrices();

    for (const { coin_id } of deadRows) {
      const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coin_id]);
      expect(parseFloat(rows[0].current_price)).toBe(0);
    }
  });

  test('malformed state (collapsed coin with a non-zero price) fails safely: nothing written, nothing revived', async () => {
    const { coinId } = await collapseRankZeroCoin();
    await setupAllCoins();

    // Corrupt the live price behind the schedule's back.
    await db.query('UPDATE coins SET current_price = 5 WHERE coin_id = $1', [coinId]);

    // Hold Core 1 state stable so no rollover can reconcile the corruption away.
    jest.spyOn(gameCycleService, 'getGameState').mockResolvedValue({
      apocalypseId: 'APOC-0001',
      status: 'ACTIVE',
      apocalypsePercent: 75
    });

    const coinsBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history');
    const marketHistoryBefore = await db.query('SELECT count(*)::int AS n FROM market_history');

    await marketSimulator.updateAllPrices(); // logs the error, aborts the batch

    const coinsAfter = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history');
    const marketHistoryAfter = await db.query('SELECT count(*)::int AS n FROM market_history');

    expect(coinsAfter.rows).toEqual(coinsBefore.rows); // no writes at all
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n);
    expect(marketHistoryAfter.rows[0].n).toBe(marketHistoryBefore.rows[0].n);
  });
});
