// V2-1: the live market writer (models/market-simulator.js) integrated with
// the shared cyclical domain, the Core 2 amplitude and the Core 3 collapse
// lifecycle. Replaces the pre-V2 random-walk suites
// (market-apocalypse-volatility / market-collapse): prices now come from
// game/marketDomain.js, deterministic in (seed, baseline, window, time,
// amplitude) with no Math.random() anywhere.

const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const { getApocalypseVolatility } = require('../game/apocalypseVolatility');
const marketDomain = require('../game/marketDomain');
const db = require('../db/connection');

jest.setTimeout(20000);

const CYCLE_START = new Date('2026-08-25T10:00:00.000Z');
const DURATION_MS = 30 * 60 * 1000;
const MID_CYCLE_MS = CYCLE_START.getTime() + 10 * 60 * 1000;

function pinCycle(cycleRow, nowMs) {
  jest.spyOn(gameCycleService, 'reconcileCycle').mockResolvedValue(cycleRow);
  jest.spyOn(Date, 'now').mockReturnValue(nowMs);
}

async function realCycleRow() {
  const cycle = await gameCycleService.reconcileCycle({ now: new Date('2026-08-25T10:07:00.000Z') });
  return cycle;
}

describe('V2-1 market writer: batch state resolution', () => {
  beforeEach(() => {
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('updateAllPrices reconciles authoritative Core 1 state exactly once per batch', async () => {
    const cycle = await realCycleRow();
    const spy = jest.spyOn(gameCycleService, 'reconcileCycle').mockResolvedValue(cycle);
    jest.spyOn(Date, 'now').mockReturnValue(MID_CYCLE_MS);

    await marketSimulator.updateAllPrices();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('every live coin is priced through the shared domain with the Core 2 amplitude from Core 1 progress', async () => {
    const cycle = await realCycleRow();
    pinCycle(cycle, MID_CYCLE_MS);
    const domainSpy = jest.spyOn(marketDomain, 'evaluateMarketPoint');

    await marketSimulator.updateAllPrices();

    expect(domainSpy).toHaveBeenCalled();
    const { apocalypsePercent } = gameCycleService.deriveProgress({
      startTime: cycle.start_time,
      endTime: cycle.end_time,
      durationMs: cycle.duration_ms,
      now: new Date(MID_CYCLE_MS)
    });
    const expectedAmplitude = getApocalypseVolatility(apocalypsePercent);
    const lookbackMs = marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS;
    for (const call of domainSpy.mock.calls) {
      expect(call[0].seed).toBe(cycle.seed);
      expect(call[0].roundStartMs).toBe(new Date(cycle.start_time).getTime());
      // SIM-08: the batch prices the pinned instant; the coarse
      // market_history trend lookback prices one public-lookback behind it.
      // Both instants go through the shared domain via the unified engine.
      expect([MID_CYCLE_MS, MID_CYCLE_MS - lookbackMs]).toContain(call[0].nowMs);
      expect(call[0].amplitude).toBe(expectedAmplitude);
    }
  });

  test('survivors move and record history; the batch is deterministic at a pinned instant', async () => {
    const cycle = await realCycleRow();
    pinCycle(cycle, MID_CYCLE_MS);

    await marketSimulator.updateAllPrices();
    const afterFirst = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');

    // Prices actually moved off the seeded baselines.
    const seeded = require('../db/test_data/coins.json');
    let moved = 0;
    for (const row of afterFirst.rows) {
      const seedPrice = Number(String(seeded.find((c) => c.coin_id === row.coin_id).current_price).replace(/[£,]/g, ''));
      if (Math.abs(parseFloat(row.current_price) - seedPrice) > 1e-9) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);

    // A second batch at the SAME pinned instant recomputes identical prices.
    await marketSimulator.updateAllPrices();
    const afterSecond = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    expect(afterSecond.rows).toEqual(afterFirst.rows);
  });

  test('a fundamentally invalid calculated price fails the batch: nothing is written', async () => {
    const cycle = await realCycleRow();
    pinCycle(cycle, MID_CYCLE_MS);

    const before = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyBefore = await db.query('SELECT COUNT(*) AS count FROM price_history');

    jest.spyOn(marketSimulator, 'calculateNewPrice').mockReturnValue(NaN);
    await marketSimulator.updateAllPrices();

    const after = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyAfter = await db.query('SELECT COUNT(*) AS count FROM price_history');
    expect(after.rows).toEqual(before.rows);
    expect(historyAfter.rows[0].count).toBe(historyBefore.rows[0].count);
  });

  test('V2-1 writer owns no pricing timers: no interval appears outside start()', async () => {
    const cycle = await realCycleRow();
    pinCycle(cycle, MID_CYCLE_MS);
    await marketSimulator.updateAllPrices();
    expect(marketSimulator.updateIntervalId).toBeNull();
  });
});

describe('V2-1 market writer: collapsed coins stay exactly £0', () => {
  const WINDOW_START_MS = new Date('2026-08-25T10:00:00.000Z').getTime() + DURATION_MS * 0.70;

  async function collapseOneCoin() {
    const cycle = await gameCycleService.reconcileCycle({ now: new Date('2026-08-25T10:07:00.000Z') });
    // The writer test needs one already-authoritative durable death and live
    // survivors. Dynamic execution itself is covered in dynamic-collapse;
    // here insert the persisted execution record exactly as that authority
    // commits it, with no legacy future schedule involved.
    const { rows } = await db.query('SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id LIMIT 1');
    const coinId = rows[0].coin_id;
    await db.query(
      `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
       VALUES ($1, $2, 0, $3)`,
      [cycle.cycle_id, coinId, new Date(WINDOW_START_MS)]
    );
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [coinId]);
    return { cycle, coinId };
  }

  beforeEach(() => {
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('the market update never revives a collapsed coin and never writes new history for it', async () => {
    const { cycle, coinId } = await collapseOneCoin();
    pinCycle(cycle, WINDOW_START_MS + 60_000);

    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    await marketSimulator.updateAllPrices();

    const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
    expect(parseFloat(rows[0].current_price)).toBe(0);
    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n);
  });

  test('the collapsed coin is never priced: domain calls cover exactly the survivors', async () => {
    const { cycle, coinId } = await collapseOneCoin();
    pinCycle(cycle, WINDOW_START_MS + 60_000);
    const calcSpy = jest.spyOn(marketSimulator, 'calculateNewPrice');

    await marketSimulator.updateAllPrices();

    const { rows: coins } = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(calcSpy).toHaveBeenCalledTimes(coins[0].n - 1);
    for (const call of calcSpy.mock.calls) {
      expect(call[0].coin_id).not.toBe(coinId);
    }
  });

  test('a zero-priced dead coin does not trip the invalid-write protection: the batch commits', async () => {
    const { cycle } = await collapseOneCoin();
    pinCycle(cycle, WINDOW_START_MS + 60_000);

    const marketHistoryBefore = await db.query('SELECT count(*)::int AS n FROM market_history');
    await marketSimulator.updateAllPrices();
    const marketHistoryAfter = await db.query('SELECT count(*)::int AS n FROM market_history');
    expect(marketHistoryAfter.rows[0].n).toBe(marketHistoryBefore.rows[0].n + 1);
  });

  test('malformed state (collapsed coin with a non-zero price) fails safely: nothing written, nothing revived', async () => {
    const { cycle, coinId } = await collapseOneCoin();
    pinCycle(cycle, WINDOW_START_MS + 60_000);
    await db.query('UPDATE coins SET current_price = 5 WHERE coin_id = $1', [coinId]);

    const coinsBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history');

    await marketSimulator.updateAllPrices();

    const coinsAfter = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history');
    expect(coinsAfter.rows).toEqual(coinsBefore.rows);
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n);
  });
});
