// Genuine multi-process race coverage for Core 3 coin collapse.
//
// These tests spawn separate Node processes — never same-process Promise.all —
// and hold them behind a shared wall-clock barrier so their reconcileCycle
// calls (which now include the full collapse lifecycle: schedule generation,
// due-collapse execution, baseline restore, rollover) collide on the database
// at (nearly) the same instant. The disposable local test database is the
// coordination authority; the guard module refuses any other target.

const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/connection');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RACE_WORKER = path.join(__dirname, 'helpers', 'raceWorker.js');
const WORKER_COUNT = 6;

jest.setTimeout(30000);

function spawnRaceWorkers(barrierMs, nowMs) {
  return Array.from({ length: WORKER_COUNT }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RACE_WORKER, String(barrierMs), String(nowMs)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: 'test' }
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

describe('Core 3: genuine multi-process collapse races', () => {
  test('guard: this suite only runs against the approved disposable test database', () => {
    const target = assertDisposableTestDatabase();
    expect(target.database).toMatch(/test/i);
  });

  test('cold start: simultaneous processes create exactly one schedule and converge on the same persisted order', async () => {
    const barrierMs = Date.now() + 1500;
    const results = parseResults(await Promise.all(spawnRaceWorkers(barrierMs, barrierMs)));

    // Every process converged on the same single cycle.
    expect(new Set(results.map((r) => r.cycle_id)).size).toBe(1);
    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles');
    expect(cycles).toHaveLength(1);

    // Exactly one schedule: one row per coin, dense unique ranks, no dupes.
    const n = await coinCount();
    const { rows: schedule } = await db.query(
      'SELECT coin_id, collapse_rank, scheduled_at FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY collapse_rank',
      [cycles[0].cycle_id]
    );
    expect(schedule).toHaveLength(n);
    expect(new Set(schedule.map((r) => r.coin_id)).size).toBe(n);
    expect(schedule.map((r) => r.collapse_rank)).toEqual(Array.from({ length: n }, (_, i) => i));

    // Whatever was due at the barrier instant executed exactly once; nothing
    // scheduled later was touched. The wall-clock cycle alignment decides how
    // much of the window had passed — derive the expectation from the
    // persisted schedule so the test is deterministic at any wall time.
    const due = schedule.filter((r) => new Date(r.scheduled_at).getTime() <= barrierMs);
    const { rows: executed } = await db.query(
      'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND executed_at IS NOT NULL',
      [cycles[0].cycle_id]
    );
    expect(new Set(executed.map((r) => r.coin_id))).toEqual(new Set(due.map((r) => r.coin_id)));

    // Each executed collapse: price exactly 0, exactly one £0 history row.
    const { rows: zeroHistory } = await db.query(
      'SELECT coin_id, count(*)::int AS n FROM price_history WHERE price = 0 GROUP BY coin_id'
    );
    expect(new Set(zeroHistory.map((r) => r.coin_id))).toEqual(new Set(due.map((r) => r.coin_id)));
    for (const row of zeroHistory) expect(row.n).toBe(1);
    const { rows: zeroCoins } = await db.query('SELECT coin_id FROM coins WHERE current_price = 0');
    expect(new Set(zeroCoins.map((r) => r.coin_id))).toEqual(new Set(due.map((r) => r.coin_id)));
  });

  test('due-collapse race across the end boundary: final coin collapses exactly once, successor schedule created exactly once, baseline restored', async () => {
    // Predecessor expires exactly at the barrier instant (no schedule yet —
    // the racing workers must generate AND fully execute it through the end).
    const barrierMs = Date.now() + 1500;
    const predecessorStart = new Date(barrierMs - 30 * 60 * 1000).toISOString();
    const predecessorEnd = new Date(barrierMs).toISOString();
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'collapse-race-seed', $1, $2, 1800000, 'ACTIVE')`,
      [predecessorStart, predecessorEnd]
    );

    const results = parseResults(await Promise.all(spawnRaceWorkers(barrierMs, barrierMs)));

    // Every caller converged on the same successor cycle.
    expect(new Set(results.map((r) => r.cycle_id)).size).toBe(1);

    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(2);
    const [predecessor, successor] = cycles;
    expect(predecessor.status).toBe('COMPLETED');
    expect(successor.status).toBe('ACTIVE');

    const n = await coinCount();

    // Predecessor: full schedule, every row executed exactly once, the final
    // one exactly at the cycle end. No duplicate rows, no duplicate ranks.
    const { rows: oldSchedule } = await db.query(
      'SELECT coin_id, collapse_rank, executed_at FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY collapse_rank',
      [predecessor.cycle_id]
    );
    expect(oldSchedule).toHaveLength(n);
    expect(new Set(oldSchedule.map((r) => r.coin_id)).size).toBe(n);
    for (const row of oldSchedule) {
      expect(row.executed_at).not.toBeNull();
      expect(new Date(row.executed_at).getTime()).toBe(barrierMs);
    }

    // Exactly one £0 history transition per coin, timestamped at the end —
    // six racing processes could not duplicate a single execution.
    const { rows: zeroHistory } = await db.query(
      'SELECT coin_id, count(*)::int AS n, max(created_at) AS latest FROM price_history WHERE price = 0 GROUP BY coin_id'
    );
    expect(zeroHistory).toHaveLength(n);
    for (const row of zeroHistory) {
      expect(row.n).toBe(1);
      expect(new Date(row.latest).getTime()).toBe(barrierMs);
    }

    // Successor: exactly one fresh schedule, nothing executed yet, and every
    // coin restored to its explicit persisted baseline (no £0 leaked across
    // the boundary).
    const { rows: newSchedule } = await db.query(
      'SELECT count(*)::int AS n, count(executed_at)::int AS executed FROM coin_collapse_schedule WHERE cycle_id = $1',
      [successor.cycle_id]
    );
    expect(newSchedule[0].n).toBe(n);
    expect(newSchedule[0].executed).toBe(0);

    const { rows: coins } = await db.query('SELECT current_price, cycle_baseline_price FROM coins');
    for (const coin of coins) {
      expect(parseFloat(coin.current_price)).toBeGreaterThan(0);
      expect(parseFloat(coin.current_price)).toBe(parseFloat(coin.cycle_baseline_price));
    }

    // No process created duplicate cycles, schedules, or a second ACTIVE row.
    const { rows: activeCount } = await db.query(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'ACTIVE'`);
    expect(activeCount[0].n).toBe(1);
  });
});
