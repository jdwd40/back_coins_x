// Core 3 market integration, RESTORED legacy suite (deleted by mistake
// during the V2-1 implementation; restored and adapted to the V2
// deterministic market writer).
//
// A collapsed coin is permanently dead for the rest of the ACTIVE cycle —
// the ordinary automatic market update and the Core 2 amplitude must never
// revive it — while surviving coins keep updating normally. Zero itself must
// never trip the writer's invalid-price protection. Malformed persisted
// state fails safely.
//
// Pre-V2 this suite seeded the simulator's in-memory volatility maps and
// injected Math.random(). V2-1 removed that machinery entirely: prices come
// from the shared deterministic domain (game/marketDomain.js) as a pure
// function of persisted state, and collapsed coins are read from the
// persisted execution state of the live cycle (never inferred from
// current_price === 0, never held in memory). The adaptation pins a real
// reconcileCycle result and the writer clock instead of mocking
// getGameState/Math.random; every death/no-revival/rollback invariant is
// preserved.

const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const { getApocalypseVolatility } = require('../game/apocalypseVolatility');
const db = require('../db/connection');

jest.setTimeout(20000);

const CYCLE_START = new Date('2026-08-25T14:00:00.000Z');
const DURATION_MS = 30 * 60 * 1000;
const WINDOW_START_MS = CYCLE_START.getTime() + DURATION_MS * 0.70;
// Collapse ranks are evenly spaced by window/(coinCount - 1); the seeded
// canonical catalogue holds 10 active coins (migrations 013/014).
const SEEDED_COIN_COUNT = 10;
const SPACING_MS = (DURATION_MS * 0.30) / (SEEDED_COIN_COUNT - 1);

// Create the real aligned cycle (14:00-14:30) and reconcile exactly at the
// first scheduled collapse, executing rank 0 for real.
async function collapseRankZeroCoin() {
  const cycle = await gameCycleService.reconcileCycle({
    now: new Date(CYCLE_START.getTime() + 7 * 60 * 1000)
  });
  const { rows } = await db.query(
    'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
    [cycle.cycle_id]
  );
  await gameCycleService.reconcileCycle({ now: new Date(WINDOW_START_MS) });
  return { cycle, coinId: rows[0].coin_id };
}

// Pin the writer's Core 1 resolution and clock inside the live cycle window
// so the batch under test cannot reconcile further collapses or roll the
// cycle over; the collapse state under observation is the persisted state
// created by the real reconciliations above.
function pinCycle(cycle, nowMs) {
  jest.spyOn(gameCycleService, 'reconcileCycle').mockResolvedValue(cycle);
  jest.spyOn(Date, 'now').mockReturnValue(nowMs);
}

async function historyCounts() {
  const { rows } = await db.query(
    'SELECT coin_id, count(*)::int AS n FROM price_history GROUP BY coin_id ORDER BY coin_id'
  );
  return new Map(rows.map((r) => [r.coin_id, r.n]));
}

describe('Core 3: collapsed coins in the V2 market writer', () => {
  beforeEach(() => {
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('the ordinary automatic market update never revives a collapsed coin and never writes new history for it', async () => {
    const { cycle, coinId } = await collapseRankZeroCoin();
    pinCycle(cycle, WINDOW_START_MS + 60_000);

    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    await marketSimulator.updateAllPrices();

    const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
    expect(parseFloat(rows[0].current_price)).toBe(0);

    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n); // exactly the £0 transition, no more
  });

  test('Core 2 still applies to surviving coins while the collapsed coin is skipped entirely', async () => {
    const { cycle, coinId } = await collapseRankZeroCoin();
    const pinnedNowMs = WINDOW_START_MS + 60_000;
    pinCycle(cycle, pinnedNowMs);
    const calcSpy = jest.spyOn(marketSimulator, 'calculateNewPrice');
    const pricesBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyBefore = await historyCounts();

    await marketSimulator.updateAllPrices();

    // Every survivor priced exactly once through the current interface; the
    // dead coin never reaches calculateNewPrice.
    const { rows: coins } = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(calcSpy).toHaveBeenCalledTimes(coins[0].n - 1);
    const { apocalypsePercent } = gameCycleService.deriveProgress({
      startTime: cycle.start_time,
      endTime: cycle.end_time,
      durationMs: cycle.duration_ms,
      now: new Date(pinnedNowMs)
    });
    const expectedAmplitude = getApocalypseVolatility(apocalypsePercent);
    for (const call of calcSpy.mock.calls) {
      expect(call[0].coin_id).not.toBe(coinId);
      expect(call[1].amplitude).toBe(expectedAmplitude);
    }

    // Survivors actually moved and recorded exactly one new history row
    // each; the collapsed coin recorded none.
    const historyAfter = await historyCounts();
    let moved = 0;
    for (const before of pricesBefore.rows) {
      if (before.coin_id === coinId) {
        expect(historyAfter.get(coinId) ?? 0).toBe(historyBefore.get(coinId) ?? 0);
        continue;
      }
      expect(historyAfter.get(before.coin_id) ?? 0).toBe((historyBefore.get(before.coin_id) ?? 0) + 1);
      const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [before.coin_id]);
      const after = parseFloat(rows[0].current_price);
      expect(Number.isFinite(after)).toBe(true);
      expect(after).toBeGreaterThan(0);
      if (Math.abs(after - parseFloat(before.current_price)) > 1e-9) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);
  });

  test('a zero-priced dead coin does not trip the invalid-write protection: the batch completes for survivors', async () => {
    const { cycle } = await collapseRankZeroCoin();
    pinCycle(cycle, WINDOW_START_MS + 60_000);

    const marketHistoryBefore = await db.query('SELECT count(*)::int AS n FROM market_history');
    await marketSimulator.updateAllPrices();
    const marketHistoryAfter = await db.query('SELECT count(*)::int AS n FROM market_history');

    // The batch committed (market_history written) — zero caused no rollback.
    expect(marketHistoryAfter.rows[0].n).toBe(marketHistoryBefore.rows[0].n + 1);
  });

  test('several collapsed coins all stay dead across repeated updates', async () => {
    const cycle = await gameCycleService.reconcileCycle({
      now: new Date(CYCLE_START.getTime() + 7 * 60 * 1000)
    });
    await gameCycleService.reconcileCycle({ now: new Date(WINDOW_START_MS + 3 * SPACING_MS) }); // ranks 0..3 collapsed
    const { rows: deadRows } = await db.query(
      'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND executed_at IS NOT NULL',
      [cycle.cycle_id]
    );
    expect(deadRows).toHaveLength(4);

    pinCycle(cycle, WINDOW_START_MS + 3 * SPACING_MS + 30_000);
    const historyBefore = await historyCounts();

    await marketSimulator.updateAllPrices();
    await marketSimulator.updateAllPrices();

    const historyAfter = await historyCounts();
    for (const { coin_id } of deadRows) {
      const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coin_id]);
      expect(parseFloat(rows[0].current_price)).toBe(0);
      // Repeated batches preserve the dead state exactly: no new history.
      expect(historyAfter.get(coin_id)).toBe(historyBefore.get(coin_id));
    }
  });

  test('malformed state (collapsed coin with a non-zero price) fails safely: nothing written, nothing revived', async () => {
    const { cycle, coinId } = await collapseRankZeroCoin();
    pinCycle(cycle, WINDOW_START_MS + 60_000);

    // Corrupt the live price behind the persisted schedule's back.
    await db.query('UPDATE coins SET current_price = 5 WHERE coin_id = $1', [coinId]);

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
