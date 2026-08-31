// Crypto Chaos Core 6: genuine multi-process settlement races.
//
// Separate Node processes — never same-process Promise.all — held behind a
// shared wall-clock barrier so their operations collide on the database
// advisory lock at (nearly) the same instant. No sleep-based coordination
// anywhere: the barrier is the only timing, and control times (cycle window
// vs each worker's logical `now`) decide which operation is legal. The
// disposable local test database is the coordination authority; afterwards
// every invariant is asserted directly in SQL.

const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RACE_WORKER = path.join(__dirname, 'helpers', 'settlementRaceWorker.js');

const CYCLE_MS = 10 * 60 * 1000;

// Documented deterministic cycle seed for the duplicate-settlement fixture,
// found and re-verifiable via
// `NODE_ENV=test node __tests__/helpers/findCollapseRaceSeed.js`.
// The reconcile workers below settle the predecessor at the barrier and
// continue at logical `barrier + 5000ms` — inside the successor's active
// window — where they legitimately evaluate dynamic collapse at the
// successor's start bucket with the market in its opening GROWTH state
// (risk capped at config dynamicCollapse.preDeclineRiskCap). An
// uncontrolled generated successor seed can land a rare roll under that
// cap and kill a coin, which the global zero-history assertion (written to
// validate the PREDECESSOR settlement) would then count as a duplicate.
// With this seed every per-(coin, bucket) collapse roll for every seeded
// coin is >= the cap at every evaluation bucket of a fresh cycle, so the
// successor cannot produce a death during the settlement-race assertion.
// Dynamic-collapse semantics, risk caps and evaluation itself are all
// unchanged — only the fixture's successor seed source is pinned.
const SETTLEMENT_RACE_SAFE_SEED = 'collapse-race-safe-seed-34';

jest.setTimeout(45000);

function spawnWorker(mode, barrierMs, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RACE_WORKER, mode, String(barrierMs), JSON.stringify(payload || {})], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: 'test' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseResults(settled) {
  return settled.map(({ code, stdout, stderr }) => {
    if (code !== 0) throw new Error(`race worker exited ${code}: ${stderr}`);
    const lines = stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  });
}

// Create a cycle expiring exactly at endMs, with users 1..n joined at start.
async function setupExpiringCycle(endMs, joinUserIds) {
  const start = new Date(endMs - CYCLE_MS);
  const cycle = await reconcileCycle({ now: start, durationMs: CYCLE_MS });
  for (const userId of joinUserIds) {
    await gameRoundService.joinRound({ userId, now: start });
  }
  return cycle;
}

describe('Core 6: genuine multi-process settlement races', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('guard: this suite only runs against the approved disposable test database', () => {
    const target = assertDisposableTestDatabase();
    expect(target.database).toMatch(/test/i);
  });

  test('trade-vs-freeze: either one fully legal ACTIVE commit or zero mutation', async () => {
    const barrierMs = Date.now() + 1500;
    const endMs = barrierMs; // the cycle expires exactly at the barrier
    const cycle = await setupExpiringCycle(endMs, [1]);
    const { rows: coinRows } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id LIMIT 1');
    const coin = coinRows[0];

    const settled = await Promise.all([
      // The trade carries a LOGICAL now just before expiry: it is legal only
      // if it wins the advisory lock before the freeze commits SETTLING.
      spawnWorker('buy', barrierMs, {
        userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 1, nowMs: endMs - 5000
      }),
      spawnWorker('reconcile', barrierMs, { nowMs: endMs + 5000, durationMs: CYCLE_MS })
    ]);
    const [trade, recon] = parseResults(settled);
    expect(recon.ok).toBe(true);

    // Structural invariants hold regardless of who won the race.
    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(2);
    expect(cycles[0].status).toBe('COMPLETED');
    expect(cycles[1].status).toBe('ACTIVE');
    expect(new Date(cycles[1].start_time).getTime()).toBe(new Date(cycles[0].end_time).getTime());

    const { rows: txs } = await db.query(
      'SELECT * FROM apocalypse_transactions WHERE cycle_id = $1', [cycle.cycle_id]
    );
    const { rows: participants } = await db.query(
      'SELECT * FROM apocalypse_participants WHERE cycle_id = $1 AND user_id = 1', [cycle.cycle_id]
    );
    const { rows: results } = await db.query(
      'SELECT * FROM apocalypse_results WHERE cycle_id = $1 AND user_id = 1', [cycle.cycle_id]
    );
    // #17: user 2 is also auto-initialized into the cycle; assertions target
    // the RACING user 1's rows specifically.
    expect(participants).toHaveLength(1);
    expect(participants[0].status).toBe('FINALIZED');
    expect(results).toHaveLength(1);

    if (trade.ok) {
      // The trade committed fully against the still-ACTIVE cycle: ledger row,
      // holding, and the settlement result reflect it exactly once.
      expect(txs).toHaveLength(1);
      expect(txs[0].type).toBe('BUY');
      const expected = 10000 - parseFloat(txs[0].total_amount);
      expect(parseFloat(participants[0].current_cash)).toBeCloseTo(expected, 2);
      expect(parseFloat(results[0].final_cash)).toBeCloseTo(expected, 2);
    } else {
      // The freeze won: the trade was rejected and mutated NOTHING.
      expect(trade.status).toBe(409);
      expect(txs).toHaveLength(0);
      expect(parseFloat(participants[0].current_cash)).toBe(10000);
      expect(parseFloat(results[0].final_cash)).toBe(10000);
    }
  });

  test('duplicate settlement across processes converges to exactly one result set', async () => {
    const barrierMs = Date.now() + 1500;
    const cycle = await setupExpiringCycle(barrierMs, [1, 2]);

    // Four processes reconcile the same expired cycle at the same instant.
    // The pinned cycleSeed only controls the successor's collapse rolls
    // (see SETTLEMENT_RACE_SAFE_SEED above); the barrier, the advisory-lock
    // race and the predecessor settlement are untouched.
    const workers = await Promise.all(
      Array.from({ length: 4 }, () =>
        spawnWorker('reconcile', barrierMs, { nowMs: barrierMs + 5000, durationMs: CYCLE_MS, cycleSeed: SETTLEMENT_RACE_SAFE_SEED }))
    );
    const results = parseResults(workers);
    for (const r of results) expect(r.ok).toBe(true);

    // Every caller converged on the same single successor.
    const successorIds = new Set(results.map((r) => r.result.cycle_id));
    expect(successorIds.size).toBe(1);

    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(2);
    expect(cycles[0].status).toBe('COMPLETED');
    expect(cycles[1].status).toBe('ACTIVE');

    // Exactly one result per participant, gapless ranks, no duplicates.
    const { rows: snapshot } = await db.query(
      'SELECT rank FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank', [cycle.cycle_id]
    );
    expect(snapshot.map((r) => r.rank)).toEqual([1, 2]);

    // No duplicate collapses: every coin collapsed exactly once at cycle end.
    const { rows: zeroHistory } = await db.query(
      'SELECT coin_id, count(*)::int AS n FROM price_history WHERE price = 0 GROUP BY coin_id'
    );
    for (const row of zeroHistory) expect(row.n).toBe(1);

    // Finalization ran exactly once per participant.
    const { rows: participants } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants WHERE cycle_id = $1 AND status = 'FINALIZED'`,
      [cycle.cycle_id]
    );
    expect(participants[0].n).toBe(2);
  });

  test('crash after durable SETTLING, then concurrent retries: exactly one settlement', async () => {
    const barrierMs = Date.now() + 1500;
    const cycle = await setupExpiringCycle(barrierMs, [1, 2]);

    // Phase 1 ("crash"): one process commits the durable freeze and dies.
    const [frozen] = parseResults(await Promise.all([
      spawnWorker('freeze', barrierMs, { nowMs: barrierMs + 5000 })
    ]));
    expect(frozen.ok).toBe(true);
    expect(frozen.result).toBeTruthy(); // it won: it committed SETTLING

    const { rows: mid } = await db.query('SELECT status FROM apocalypse_cycles WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(mid[0].status).toBe('SETTLING');

    // Phase 2 ("restart"): three processes resume the settlement at once.
    const retries = parseResults(await Promise.all(
      Array.from({ length: 3 }, () =>
        spawnWorker('reconcile', Date.now() + 1500, { nowMs: barrierMs + 5000, durationMs: CYCLE_MS }))
    ));
    for (const r of retries) expect(r.ok).toBe(true);

    // Exactly one of everything.
    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(2);
    expect(cycles[0].status).toBe('COMPLETED');
    expect(cycles[0].settled_at).not.toBeNull();
    expect(cycles[1].status).toBe('ACTIVE');
    const { rows: snapshot } = await db.query(
      'SELECT rank FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank', [cycle.cycle_id]
    );
    expect(snapshot.map((r) => r.rank)).toEqual([1, 2]);
  });

  test('concurrent freeze and settle phases never interleave into a partial settlement', async () => {
    const barrierMs = Date.now() + 1500;
    const cycle = await setupExpiringCycle(barrierMs, [1]);

    // freeze + settle + reconcile all collide at the barrier. Any of them
    // may win individual phases; the end state must be fully settled.
    const results = parseResults(await Promise.all([
      spawnWorker('freeze', barrierMs, { nowMs: barrierMs + 5000 }),
      spawnWorker('settle', barrierMs, {}),
      spawnWorker('reconcile', barrierMs, { nowMs: barrierMs + 5000, durationMs: CYCLE_MS })
    ]));
    for (const r of results) expect(r.ok).toBe(true);

    // Settle may have run before the freeze (a no-op returning null) — the
    // reconcile guarantees convergence either way.
    const { rows: cycles } = await db.query('SELECT status FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles.map((c) => c.status)).toEqual(['COMPLETED', 'ACTIVE']);
    const { rows: snapshot } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_results WHERE cycle_id = $1', [cycle.cycle_id]
    );
    expect(snapshot[0].n).toBe(2); // #17: both seeded users are participants
    const { rows: settling } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'SETTLING'`
    );
    expect(settling[0].n).toBe(0);
  });
});
