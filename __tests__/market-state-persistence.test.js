// SIM-06/07: market state persistence/recovery against the disposable test
// database (guard-enforced; jest.setup.js reseeds before each test).
//
// Covered:
//   * opening state creation: deterministic index from the canonical
//     surviving coin state, monotonic peak, zeroed drawdown/momentum, the
//     seed-generated plateau target (never rerolled), one row per cycle;
//   * repeated reconciliation observes the persisted row (idempotent);
//   * the peak is monotonic and restart-safe; drawdown/momentum track the
//     persisted evaluations;
//   * collapsed coins (Core 3 authority) and retired coins are excluded
//     from the index;
//   * the lifecycle advances only in legal order, driven by the persisted
//     measurements and bounded progress guards;
//   * empty-catalogue and all-collapsed edge cases are safe;
//   * the engine never writes coin prices or price history;
//   * the full Core 1 reconcileCycle path creates and advances state;
//   * no cross-cycle leakage.

const db = require('../db/connection');
const {
  computeMarketIndex,
  drawPlateauTarget,
  getCycleMarketState,
  ensureMarketState
} = require('../game/marketStateEngine');
const { ensureMarketPhaseCoverage, getCycleMarketPhases } = require('../game/marketPhaseEngine');
const dynamicCollapseService = require('../game/dynamicCollapseService');
const { reconcileCycle } = require('../game/gameCycleService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const LOCK_KEY = 727001; // the Core 1 game-lifecycle advisory lock

const START = new Date('2026-08-20T10:00:00.000Z');
const END = new Date('2026-08-20T10:30:00.000Z');
const SEED = 'sim06-persistence-seed';

async function withLifecycleTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertCycle({ apocalypseId, seed, status = 'ACTIVE', start = START, end = END }) {
  const { rows } = await db.query(
    `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [apocalypseId, seed, start.toISOString(), end.toISOString(), end.getTime() - start.getTime(), status]
  );
  return rows[0];
}

// The canonical surviving-coin index as computed straight from the DB,
// independent of the engine's own query (test-side oracle).
async function expectedIndex(cycleId) {
  const { rows } = await db.query(
    `SELECT c.current_price
     FROM coins c
     WHERE c.retired = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM apocalypse_coin_collapses cc
         WHERE cc.cycle_id = $1 AND cc.coin_id = c.coin_id
       )
     ORDER BY c.coin_id`,
    [cycleId]
  );
  return computeMarketIndex(rows);
}

function num(row, key) {
  return parseFloat(row[key]);
}

describe('SIM-06/07: market state persistence and recovery', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('the first evaluation opens the cycle state: GROWTH, index = peak = starting, zero drawdown/momentum, seed-drawn target', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date(START.getTime() + 60000);
    const state = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, now));

    const index = await expectedIndex(cycle.cycle_id);
    expect(index).toBeGreaterThan(0);
    expect(num(state, 'starting_index')).toBe(index);
    expect(num(state, 'current_index')).toBe(index);
    expect(num(state, 'peak_index')).toBe(index);
    expect(new Date(state.peak_at).getTime()).toBe(now.getTime());
    expect(num(state, 'drawdown')).toBe(0);
    expect(num(state, 'momentum')).toBe(0);
    expect(state.lifecycle_state).toBe('GROWTH');
    expect(new Date(state.last_evaluated_at).getTime()).toBe(now.getTime());
    // The plateau target equals the pure seeded draw and is never below the start.
    expect(num(state, 'plateau_target')).toBe(drawPlateauTarget({ seed: SEED, startingIndex: index }));
    expect(num(state, 'plateau_target')).toBeGreaterThanOrEqual(index);
  });

  test('repeated evaluation with unchanged prices is observationally stable (no reroll, no drift)', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date(START.getTime() + 60000);
    const first = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, now));
    const second = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, new Date(now.getTime() + 30000)));

    expect(second.state_id).toBe(first.state_id);
    expect(num(second, 'starting_index')).toBe(num(first, 'starting_index'));
    expect(num(second, 'current_index')).toBe(num(first, 'current_index'));
    expect(num(second, 'peak_index')).toBe(num(first, 'peak_index'));
    expect(num(second, 'plateau_target')).toBe(num(first, 'plateau_target'));
    expect(second.lifecycle_state).toBe('GROWTH');
    // Unchanged prices: the second evaluation measures no movement.
    expect(num(second, 'momentum')).toBe(0);
    expect(num(second, 'drawdown')).toBe(0);

    const { rows } = await db.query('SELECT count(*)::int AS n FROM apocalypse_market_state WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(rows[0].n).toBe(1);
  });

  test('the peak is monotonic: lifted on new highs (with timestamp), never lowered', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const t0 = new Date(START.getTime() + 60000);
    const opened = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, t0));
    const start = num(opened, 'starting_index');

    // Market rises ~10%: peak lifts, drawdown resets, momentum positive.
    await db.query('UPDATE coins SET current_price = current_price * 1.1');
    const t1 = new Date(t0.getTime() + 60000);
    const high = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, t1));
    const highIndex = await expectedIndex(cycle.cycle_id);
    expect(num(high, 'current_index')).toBe(highIndex);
    expect(num(high, 'peak_index')).toBe(highIndex);
    expect(new Date(high.peak_at).getTime()).toBe(t1.getTime());
    expect(num(high, 'drawdown')).toBe(0);
    expect(num(high, 'momentum')).toBeCloseTo(0.1, 6);

    // Market falls back: the peak persists with its original timestamp.
    await db.query('UPDATE coins SET current_price = current_price / 1.1');
    const t2 = new Date(t1.getTime() + 60000);
    const fallen = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, t2));
    expect(num(fallen, 'current_index')).toBeCloseTo(start, 4);
    expect(num(fallen, 'peak_index')).toBe(highIndex);
    expect(new Date(fallen.peak_at).getTime()).toBe(t1.getTime());
    expect(num(fallen, 'drawdown')).toBeCloseTo((highIndex - num(fallen, 'current_index')) / highIndex, 6);
    expect(num(fallen, 'momentum')).toBeLessThan(0);

    // Peak monotonicity is database-enforced, not just engine-enforced.
    await expect(db.query(
      'UPDATE apocalypse_market_state SET peak_index = current_index - 1 WHERE cycle_id = $1',
      [cycle.cycle_id]
    )).rejects.toThrow(/violates check/);
  });

  test('restart-equivalent state: a fresh transaction observes the persisted row and never rerolls the target', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date(START.getTime() + 5 * 60000);
    const first = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, now));

    // Simulate a process restart: new transaction, cycle re-read from the DB.
    const recovered = await withLifecycleTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM apocalypse_cycles WHERE cycle_id = $1', [cycle.cycle_id]);
      return ensureMarketState(client, rows[0], new Date(now.getTime() + 30000));
    });

    expect(recovered.state_id).toBe(first.state_id);
    expect(num(recovered, 'plateau_target')).toBe(num(first, 'plateau_target'));
    expect(num(recovered, 'plateau_target')).toBe(drawPlateauTarget({ seed: SEED, startingIndex: num(first, 'starting_index') }));
    expect(num(recovered, 'peak_index')).toBe(num(first, 'peak_index'));
    expect(num(recovered, 'starting_index')).toBe(num(first, 'starting_index'));
  });

  test('collapsed coins are excluded via the dynamic collapse authority', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const t0 = new Date(START.getTime() + 60000);
    const opened = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, t0));
    const startIndex = num(opened, 'starting_index');

    // Crash the whole market and mark the persisted state DECLINE (the
    // simulated damage the risk engine reads), then let the dynamic engine
    // evaluate deaths for real inside the lifecycle transaction.
    await db.query('UPDATE coins SET current_price = GREATEST(0.0001, current_price * 0.0001)');
    await db.query(
      `UPDATE apocalypse_market_state SET lifecycle_state = 'DECLINE', drawdown = 0.95 WHERE cycle_id = $1`,
      [cycle.cycle_id]
    );
    const { rows: preDeath } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const priceBeforeDeath = new Map(preDeath.map((r) => [r.coin_id, parseFloat(r.current_price)]));

    const evalAt = new Date(START.getTime() + (END.getTime() - START.getTime()) * 0.75);
    const afterDeaths = await withLifecycleTransaction(async (client) => {
      const executed = await dynamicCollapseService.evaluateAndExecuteCollapses(client, cycle, evalAt);
      expect(executed.length).toBeGreaterThan(0);
      return { state: await ensureMarketState(client, cycle, evalAt), executed };
    });
    const expected = await expectedIndex(cycle.cycle_id);
    expect(num(afterDeaths.state, 'current_index')).toBe(expected);
    expect(expected).toBeLessThan(startIndex);

    // Each dead coin is exactly £0 with exactly one durable death record,
    // and the index fell from its pre-death (crashed) level by exactly the
    // prices the dead coins contributed.
    const crashedIndex = preDeath.reduce((sum, r) => sum + parseFloat(r.current_price), 0);
    const deadIds = new Set(afterDeaths.executed.map((r) => r.coin_id));
    const { rows: dead } = await db.query('SELECT coin_id, current_price FROM coins WHERE current_price = 0');
    expect(new Set(dead.map((r) => r.coin_id))).toEqual(deadIds);
    let contributed = 0;
    for (const coinId of deadIds) contributed += priceBeforeDeath.get(coinId);
    expect(crashedIndex - expected).toBeCloseTo(contributed, 6);
    expect(startIndex).toBeGreaterThan(expected);
  });

  test('retired coins are excluded from the index', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const t0 = new Date(START.getTime() + 60000);
    const opened = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, t0));

    const { rows: victim } = await db.query('SELECT coin_id, current_price FROM coins WHERE retired = FALSE ORDER BY coin_id LIMIT 1');
    await db.query('UPDATE coins SET retired = TRUE WHERE coin_id = $1', [victim[0].coin_id]);
    const after = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, new Date(t0.getTime() + 60000)));
    expect(num(after, 'current_index')).toBe(await expectedIndex(cycle.cycle_id));
    expect(num(after, 'current_index')).toBeCloseTo(num(opened, 'starting_index') - parseFloat(victim[0].current_price), 4);
  });

  test('the empty catalogue edge is safe: zero index, zero target, guards still advance the lifecycle', async () => {
    await db.query('UPDATE coins SET retired = TRUE');
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const state = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, new Date(START.getTime() + 60000)));
    expect(num(state, 'starting_index')).toBe(0);
    expect(num(state, 'current_index')).toBe(0);
    expect(num(state, 'peak_index')).toBe(0);
    expect(num(state, 'plateau_target')).toBe(0);
    expect(num(state, 'drawdown')).toBe(0);
    expect(num(state, 'momentum')).toBe(0);
    expect(state.lifecycle_state).toBe('GROWTH');

    // The value path can never fire on a zero target, but the bounded
    // late-cycle guards still walk the lifecycle forward legally.
    const late = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, new Date(START.getTime() + 20 * 60000)));
    expect(late.lifecycle_state).toBe('PLATEAU'); // progress 2/3 past the 0.55 guard, one step
  });

  test('the all-collapsed edge: index 0, drawdown 1, momentum -1, then zero-base momentum 0', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const t0 = new Date(START.getTime() + 60000);
    await withLifecycleTransaction((client) => ensureMarketState(client, cycle, t0));

    // The final safety rule at cycle end: the whole market dies at once.
    const wiped = await withLifecycleTransaction(async (client) => {
      await dynamicCollapseService.executeRemainingCollapses(client, cycle, END);
      return ensureMarketState(client, cycle, new Date(END.getTime() - 1));
    });
    expect(num(wiped, 'current_index')).toBe(0);
    expect(num(wiped, 'drawdown')).toBe(1);
    expect(num(wiped, 'momentum')).toBe(-1);
    expect(num(wiped, 'peak_index')).toBeGreaterThan(0); // the peak survives the wipe

    // A further evaluation at a zero base has no momentum signal and the
    // peak stays put.
    const after = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, new Date(END.getTime() - 1)));
    expect(num(after, 'momentum')).toBe(0);
    expect(num(after, 'current_index')).toBe(0);
    expect(num(after, 'drawdown')).toBe(1);
  });

  test('the lifecycle walks GROWTH -> PLATEAU -> DECLINE -> COLLAPSE from real price behaviour', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const evaluate = (now) => withLifecycleTransaction((client) => ensureMarketState(client, cycle, now));

    // Opening: GROWTH.
    const t0 = new Date(START.getTime() + 60000);
    let state = await evaluate(t0);
    expect(state.lifecycle_state).toBe('GROWTH');
    const target = num(state, 'plateau_target');

    // Drive the market into the generated peak region: PLATEAU. Setting
    // every surviving coin to target / n makes the summed index ~= target.
    const n = (await db.query('SELECT count(*)::int AS n FROM coins WHERE retired = FALSE')).rows[0].n;
    await db.query('UPDATE coins SET current_price = $1', [target / n]);
    state = await evaluate(new Date(t0.getTime() + 60000));
    expect(state.lifecycle_state).toBe('PLATEAU');
    const peak = num(state, 'peak_index');
    expect(peak).toBeGreaterThanOrEqual(target * 0.9);

    // Oscillation with a new high keeps the plateau.
    await db.query('UPDATE coins SET current_price = current_price * 1.02');
    state = await evaluate(new Date(t0.getTime() + 2 * 60000));
    expect(state.lifecycle_state).toBe('PLATEAU');
    expect(num(state, 'peak_index')).toBeGreaterThan(peak);

    // Confirmed weakening: >5% drawdown with negative momentum -> DECLINE.
    await db.query('UPDATE coins SET current_price = current_price * 0.90');
    state = await evaluate(new Date(t0.getTime() + 3 * 60000));
    expect(state.lifecycle_state).toBe('DECLINE');
    expect(num(state, 'drawdown')).toBeGreaterThanOrEqual(0.05);
    expect(num(state, 'momentum')).toBeLessThan(0);

    // A strong rally does NOT reset the decline (no backwards transition).
    await db.query('UPDATE coins SET current_price = current_price * 1.03');
    state = await evaluate(new Date(t0.getTime() + 4 * 60000));
    expect(state.lifecycle_state).toBe('DECLINE');
    expect(num(state, 'momentum')).toBeGreaterThan(0);

    // Severe drawdown -> COLLAPSE (terminal).
    await db.query('UPDATE coins SET current_price = current_price * 0.60');
    state = await evaluate(new Date(t0.getTime() + 5 * 60000));
    expect(state.lifecycle_state).toBe('COLLAPSE');
    expect(num(state, 'drawdown')).toBeGreaterThanOrEqual(0.3);

    // Terminal: even a full recovery cannot leave COLLAPSE.
    await db.query('UPDATE coins SET current_price = current_price * 1.5');
    state = await evaluate(new Date(t0.getTime() + 6 * 60000));
    expect(state.lifecycle_state).toBe('COLLAPSE');

    // Illegal persisted states are rejected by the database vocabulary.
    await expect(db.query(
      `UPDATE apocalypse_market_state SET lifecycle_state = 'MANIA' WHERE cycle_id = $1`,
      [cycle.cycle_id]
    )).rejects.toThrow(/violates check/);
  });

  test('the engine never writes coin prices or price history (not a second price writer)', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const pricesBefore = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyBefore = await db.query('SELECT count(*)::int AS n FROM price_history');

    await withLifecycleTransaction((client) => ensureMarketState(client, cycle, new Date(START.getTime() + 60000)));
    await withLifecycleTransaction((client) => ensureMarketState(client, cycle, new Date(START.getTime() + 120000)));

    const pricesAfter = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    const historyAfter = await db.query('SELECT count(*)::int AS n FROM price_history');
    expect(pricesAfter.rows).toEqual(pricesBefore.rows);
    expect(historyAfter.rows[0].n).toBe(historyBefore.rows[0].n);
  });

  test('no cross-cycle leakage: each cycle carries its own state and target', async () => {
    const cycleA = await insertCycle({ apocalypseId: 'APOC-0001', seed: 'state-cycle-a' });
    const cycleB = await insertCycle({
      apocalypseId: 'APOC-0002', seed: 'state-cycle-b', status: 'COMPLETED',
      start: END, end: new Date(END.getTime() + 30 * 60000)
    });
    const stateA = await withLifecycleTransaction((client) => ensureMarketState(client, cycleA, new Date(START.getTime() + 60000)));
    const stateB = await withLifecycleTransaction((client) => ensureMarketState(client, cycleB, new Date(END.getTime() + 60000)));

    expect(stateA.cycle_id).toBe(cycleA.cycle_id);
    expect(stateB.cycle_id).toBe(cycleB.cycle_id);
    expect(stateA.state_id).not.toBe(stateB.state_id);
    // Different seeds generate independent targets (same seed -> same target
    // is proven by the pure determinism tests).
    expect(num(stateA, 'plateau_target')).not.toBe(num(stateB, 'plateau_target'));

    const { rows } = await db.query('SELECT count(*)::int AS n FROM apocalypse_market_state');
    expect(rows[0].n).toBe(2);
  });

  test('the Core 1 reconcile path opens and advances market state for the live cycle', async () => {
    const generateSeed = () => SEED;
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:05:00.000Z'), generateSeed });
    expect(cycle.status).toBe('ACTIVE');

    const opened = await getCycleMarketState(db, cycle.cycle_id);
    expect(opened).not.toBeNull();
    expect(opened.lifecycle_state).toBe('GROWTH');
    expect(num(opened, 'starting_index')).toBe(await expectedIndex(cycle.cycle_id));
    expect(num(opened, 'plateau_target')).toBe(drawPlateauTarget({ seed: SEED, startingIndex: num(opened, 'starting_index') }));

    // A late reconcile observes the same row (same id, same target) and the
    // bounded guards have advanced the lifecycle in legal order.
    const later = await reconcileCycle({ now: new Date('2026-08-20T10:29:00.000Z'), generateSeed });
    expect(later.cycle_id).toBe(cycle.cycle_id);
    const advanced = await getCycleMarketState(db, cycle.cycle_id);
    expect(advanced.state_id).toBe(opened.state_id);
    expect(num(advanced, 'plateau_target')).toBe(num(opened, 'plateau_target'));
    expect(advanced.lifecycle_state).toBe('PLATEAU'); // one legal step past the 0.55 guard

    // The phase chain drawn after the advance records the real lifecycle state.
    const phases = await getCycleMarketPhases(db, cycle.cycle_id);
    expect(phases[0].lifecycle_state).toBe('GROWTH');
    expect(phases.some((p) => p.lifecycle_state === 'PLATEAU')).toBe(true);
  });

  test('a pre-Wave-2 cycle recovered mid-flight gets state without disturbing phases or events', async () => {
    // Simulate a cycle created before Wave 2 existed: phases covered, no
    // market-state row.
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const earlyNow = new Date(START.getTime() + 5 * 60000);
    await withLifecycleTransaction((client) => ensureMarketPhaseCoverage(client, cycle, earlyNow));
    expect(await getCycleMarketState(db, cycle.cycle_id)).toBeNull();

    // Recovery creates the state from the CURRENT canonical prices; the
    // pre-existing phase rows are untouched.
    const phasesBefore = await getCycleMarketPhases(db, cycle.cycle_id);
    const state = await withLifecycleTransaction((client) => ensureMarketState(client, cycle, new Date(START.getTime() + 6 * 60000)));
    expect(state.lifecycle_state).toBe('GROWTH');
    expect(num(state, 'starting_index')).toBe(await expectedIndex(cycle.cycle_id));
    const phasesAfter = await getCycleMarketPhases(db, cycle.cycle_id);
    expect(phasesAfter.slice(0, phasesBefore.length)).toEqual(phasesBefore);
  });
});
