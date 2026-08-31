// Genuine multi-process race coverage for the dynamic collapse engine
// (SIM-13/14) — adapted from the retired fixed schedule's Core 3 race
// suite; every exactly-once/no-duplicate invariant is preserved.
//
// These tests spawn separate Node processes — never same-process Promise.all —
// and hold them behind a shared wall-clock barrier so their reconcileCycle
// calls (which now include the full dynamic collapse lifecycle: risk
// evaluation, death execution, baseline restore, rollover) collide on the
// database at (nearly) the same instant. The disposable local test database
// is the coordination authority; the guard module refuses any other target.

const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/connection');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');
const { DEFAULT_GAME_CYCLE_DURATION_MS } = require('../game/gameCycleService');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RACE_WORKER = path.join(__dirname, 'helpers', 'raceWorker.js');
const WORKER_COUNT = 6;

// Documented deterministic cycle seed for this fixture, found and
// re-verifiable via `NODE_ENV=test node __tests__/helpers/findCollapseRaceSeed.js`.
// The dynamic collapse engine legitimately evaluates the exact cycle-start
// bucket at cold start, so an uncontrolled generated seed can land a rare
// early roll under a coin's pre-decline-capped risk and kill coins during
// the exactly-once cold-start verification. With this seed every seeded
// per-(coin, bucket) collapse roll for every coin in the disposable seed
// set is >= the preDeclineRiskCap at every evaluation bucket of a fresh
// cycle, so no start-bucket death is possible under any racing interleaving
// while the market is in its opening GROWTH state. Dynamic-collapse
// semantics, risk caps and evaluation itself are all unchanged — only the
// fixture's seed source is pinned.
const COLLAPSE_RACE_SAFE_SEED = 'collapse-race-safe-seed-34';

jest.setTimeout(30000);

function spawnRaceWorkers(barrierMs, nowMs, { cycleSeed } = {}) {
  return Array.from({ length: WORKER_COUNT }, () => new Promise((resolve, reject) => {
    const env = { ...process.env, NODE_ENV: 'test' };
    if (cycleSeed !== undefined) env.RACE_WORKER_CYCLE_SEED = cycleSeed;
    const child = spawn(process.execPath, [RACE_WORKER, String(barrierMs), String(nowMs)], {
      cwd: PROJECT_ROOT,
      env
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  }));
}

function parseResults(settled) {
  return settled.map(({ code, stdout, stderr }) => {
    if (code !== 0) throw new Error(`race worker exited ${code}: ${stderr}`);
    const lines = stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  });
}

async function coinCount() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM coins');
  return rows[0].n;
}

describe('SIM-13/14: genuine multi-process collapse races (dynamic collapse)', () => {
  test('guard: this suite only runs against the approved disposable test database', () => {
    const target = assertDisposableTestDatabase();
    expect(target.database).toMatch(/test/i);
  });

  test('cold start: simultaneous processes create exactly one cycle and persist no future collapse plan', async () => {
    // The wall-clock barrier genuinely synchronises the six processes; the
    // effective-now is pinned to one second after the NEXT aligned cycle
    // boundary so the cold start is evaluated exactly at the cycle-start
    // bucket (bucket zero, opening GROWTH market state) no matter where in
    // the half-hour window the test fires. Without this, a barrier landing
    // late in the aligned window would let the racing reconciles advance
    // the hidden lifecycle past the pre-decline risk cap before evaluating,
    // and even a start-safe seed could see deaths. The scenario under test
    // — a healthy market at the very start of the cycle — is unchanged.
    const barrierMs = Date.now() + 1500;
    const cycleStartMs = Math.ceil(barrierMs / DEFAULT_GAME_CYCLE_DURATION_MS) * DEFAULT_GAME_CYCLE_DURATION_MS;
    const nowMs = cycleStartMs + 1000;
    const results = parseResults(await Promise.all(spawnRaceWorkers(barrierMs, nowMs, { cycleSeed: COLLAPSE_RACE_SAFE_SEED })));

    // Every process converged on the same single cycle.
    expect(new Set(results.map((r) => r.cycle_id)).size).toBe(1);
    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles');
    expect(cycles).toHaveLength(1);

    // SIM-14: no schedule is ever created — the legacy table stays empty
    // and nothing about future timing/order is persisted.
    const { rows: legacy } = await db.query('SELECT count(*)::int AS n FROM coin_collapse_schedule');
    expect(legacy[0].n).toBe(0);

    // A healthy market at the very start of the cycle: no deaths, no £0
    // prices — and no racing process could double-execute anything.
    const { rows: deaths } = await db.query('SELECT count(*)::int AS n FROM apocalypse_coin_collapses');
    expect(deaths[0].n).toBe(0);
    const { rows: zeroCoins } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price = 0');
    expect(zeroCoins[0].n).toBe(0);
    const { rows: zeroHistory } = await db.query('SELECT count(*)::int AS n FROM price_history WHERE price = 0');
    expect(zeroHistory[0].n).toBe(0);
  });

  test('end-boundary race: every coin dies exactly once at exactly cycle end, successor created once, baseline restored', async () => {
    // Predecessor expires exactly at the barrier instant — the racing
    // workers must settle it (the final safety rule kills every coin) AND
    // chain exactly one successor.
    const barrierMs = Date.now() + 1500;
    const predecessorStart = new Date(barrierMs - 30 * 60 * 1000).toISOString();
    const predecessorEnd = new Date(barrierMs).toISOString();
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'collapse-race-seed', $1, $2, 1800000, 'ACTIVE')`,
      [predecessorStart, predecessorEnd]
    );

    const results = parseResults(await Promise.all(spawnRaceWorkers(barrierMs, barrierMs, { cycleSeed: COLLAPSE_RACE_SAFE_SEED })));

    // Every caller converged on the same successor cycle.
    expect(new Set(results.map((r) => r.cycle_id)).size).toBe(1);

    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(2);
    const [predecessor, successor] = cycles;
    expect(predecessor.status).toBe('COMPLETED');
    expect(successor.status).toBe('ACTIVE');

    const n = await coinCount();

    // Predecessor: every coin has exactly one death record, killed at
    // exactly the cycle end by the settlement safety rule. No duplicate
    // records, no duplicate ranks — six racing processes could not
    // double-execute a single death.
    const { rows: deaths } = await db.query(
      'SELECT coin_id, collapse_rank, collapsed_at FROM apocalypse_coin_collapses WHERE cycle_id = $1 ORDER BY collapse_rank',
      [predecessor.cycle_id]
    );
    expect(deaths).toHaveLength(n);
    expect(new Set(deaths.map((r) => r.coin_id)).size).toBe(n);
    expect(deaths.map((r) => r.collapse_rank)).toEqual(Array.from({ length: n }, (_, i) => i));
    for (const row of deaths) {
      expect(new Date(row.collapsed_at).getTime()).toBe(barrierMs);
    }

    // Exactly one £0 history transition per coin, timestamped at the end.
    const { rows: zeroHistory } = await db.query(
      'SELECT coin_id, count(*)::int AS n, max(created_at) AS latest FROM price_history WHERE price = 0 GROUP BY coin_id'
    );
    expect(zeroHistory).toHaveLength(n);
    for (const row of zeroHistory) {
      expect(row.n).toBe(1);
      expect(new Date(row.latest).getTime()).toBe(barrierMs);
    }

    // Successor: no deaths yet, and every coin restored to its explicit
    // persisted baseline (no £0 leaked across the boundary).
    const { rows: successorDeaths } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_coin_collapses WHERE cycle_id = $1',
      [successor.cycle_id]
    );
    expect(successorDeaths[0].n).toBe(0);

    const { rows: coins } = await db.query('SELECT current_price, cycle_baseline_price FROM coins');
    for (const coin of coins) {
      expect(parseFloat(coin.current_price)).toBeGreaterThan(0);
      expect(parseFloat(coin.current_price)).toBe(parseFloat(coin.cycle_baseline_price));
    }

    // No process created duplicate cycles or a second ACTIVE row.
    const { rows: activeCount } = await db.query(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'ACTIVE'`);
    expect(activeCount[0].n).toBe(1);
  });
});
