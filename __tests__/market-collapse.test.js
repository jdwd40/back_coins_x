// SIM-13/14 market integration: collapsed coins in the V2 market writer
// under the DYNAMIC collapse engine (adapted from the retired fixed
// schedule's Core 3 suite — every death/no-revival/rollback invariant is
// preserved; only the death authority changed).
//
// A collapsed coin is permanently dead for the rest of the ACTIVE cycle —
// the ordinary automatic market update and the Core 2 amplitude must never
// revive it — while surviving coins keep updating normally. Zero itself must
// never trip the writer's invalid-price protection. Malformed persisted
// state fails safely.
//
// Deaths are produced for real through the Core 1 lifecycle: a genuinely
// crashed market (drawdown, decline/collapse lifecycle, per-coin damage)
// drives the dynamic engine's risk evaluation, exactly as in production.
// The writer clock and Core 1 resolution are then pinned so the batch under
// test cannot reconcile further deaths or roll the cycle over; the collapse
// state under observation is the persisted state created by the real
// reconciliations.

const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const { getApocalypseVolatility } = require('../game/apocalypseVolatility');
const db = require('../db/connection');

jest.setTimeout(30000);

const CYCLE_START = new Date('2026-08-25T14:00:00.000Z');
const DURATION_MS = 30 * 60 * 1000;

function at(fraction) {
  return new Date(CYCLE_START.getTime() + DURATION_MS * fraction);
}

// Create the real cycle, crash the market, and reconcile until the dynamic
// engine has executed at least one death for real.
async function collapseOneCoin() {
  const cycle = await gameCycleService.reconcileCycle({
    now: at(0.05), durationMs: DURATION_MS, generateSeed: () => 'writer-collapse-seed'
  });
  await db.query('UPDATE coins SET current_price = GREATEST(0.0001, current_price * 0.0001)');
  await gameCycleService.reconcileCycle({ now: at(0.56) }); // PLATEAU (guard)
  await gameCycleService.reconcileCycle({ now: at(0.71) }); // DECLINE (guard)
  await gameCycleService.reconcileCycle({ now: at(0.72) }); // COLLAPSE (drawdown)
  for (let p = 0.73; p < 1; p += 0.02) {
    await gameCycleService.reconcileCycle({ now: at(p) });
    const { rows } = await db.query(
      'SELECT coin_id FROM apocalypse_coin_collapses WHERE cycle_id = $1 ORDER BY collapse_rank LIMIT 1',
      [cycle.cycle_id]
    );
    if (rows.length > 0) return { cycle, coinId: rows[0].coin_id, atMs: at(p).getTime() };
  }
  throw new Error('dynamic collapse engine produced no deaths for a crashed market');
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

describe('SIM-13/14: collapsed coins in the V2 market writer (dynamic collapse)', () => {
  beforeEach(() => {
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('the ordinary automatic market update never revives a collapsed coin and never writes new history for it', async () => {
    const { cycle, coinId, atMs } = await collapseOneCoin();
    pinCycle(cycle, atMs + 60_000);

    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    await marketSimulator.updateAllPrices();

    const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [coinId]);
    expect(parseFloat(rows[0].current_price)).toBe(0);

    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history WHERE coin_id = $1', [coinId]);
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n); // exactly the £0 transition, no more
  });

  test('Core 2 still applies to surviving coins while the collapsed coin is skipped entirely', async () => {
    const { cycle, coinId, atMs } = await collapseOneCoin();
    const pinnedNowMs = atMs + 60_000;
    pinCycle(cycle, pinnedNowMs);
    const calcSpy = jest.spyOn(marketSimulator, 'calculateNewPrice');
    const pricesBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyBefore = await historyCounts();

    await marketSimulator.updateAllPrices();

    // Every survivor priced exactly once through the current interface; the
    // dead coin never reaches calculateNewPrice.
    const { rows: deadCount } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_coin_collapses WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    const { rows: coins } = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(calcSpy).toHaveBeenCalledTimes(coins[0].n - deadCount[0].n);
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
    // each; collapsed coins recorded none.
    const { rows: deadRows } = await db.query(
      'SELECT coin_id FROM apocalypse_coin_collapses WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    const deadIds = new Set(deadRows.map((r) => r.coin_id));
    const historyAfter = await historyCounts();
    let moved = 0;
    for (const before of pricesBefore.rows) {
      if (deadIds.has(before.coin_id)) {
        expect(historyAfter.get(before.coin_id) ?? 0).toBe(historyBefore.get(before.coin_id) ?? 0);
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
    const { cycle, atMs } = await collapseOneCoin();
    pinCycle(cycle, atMs + 60_000);

    const marketHistoryBefore = await db.query('SELECT count(*)::int AS n FROM market_history');
    await marketSimulator.updateAllPrices();
    const marketHistoryAfter = await db.query('SELECT count(*)::int AS n FROM market_history');

    // The batch committed (market_history written) — zero caused no rollback.
    expect(marketHistoryAfter.rows[0].n).toBe(marketHistoryBefore.rows[0].n + 1);
  });

  test('every collapsed coin stays dead across repeated updates', async () => {
    const { cycle, atMs } = await collapseOneCoin();
    const { rows: deadRows } = await db.query(
      'SELECT coin_id FROM apocalypse_coin_collapses WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    expect(deadRows.length).toBeGreaterThan(0);

    pinCycle(cycle, atMs + 60_000);
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
    const { cycle, coinId, atMs } = await collapseOneCoin();
    pinCycle(cycle, atMs + 60_000);

    // Corrupt the live price behind the persisted death record's back.
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
