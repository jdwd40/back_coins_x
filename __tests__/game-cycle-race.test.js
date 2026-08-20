// Genuine multi-process race coverage for the global apocalypse cycle.
//
// These tests spawn separate Node processes — never same-process Promise.all —
// and hold them behind a shared wall-clock barrier so their reconcileCycle
// calls collide on the database at (nearly) the same instant. The disposable
// local test database is the coordination authority; the guard module refuses
// any other target.

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

describe('Core 1: genuine multi-process races', () => {
  test('guard: this suite only runs against the approved disposable test database', () => {
    const target = assertDisposableTestDatabase();
    expect(target.database).toMatch(/test/i);
  });

  test('cold start: simultaneous processes create exactly one cycle and all converge', async () => {
    // Empty table (fresh seed). All workers wake at the same barrier instant.
    const barrierMs = Date.now() + 1500;
    const results = parseResults(await Promise.all(spawnRaceWorkers(barrierMs, barrierMs)));

    const cycleIds = new Set(results.map((r) => r.cycle_id));
    expect(cycleIds.size).toBe(1);
    const apocalypseIds = new Set(results.map((r) => r.apocalypse_id));
    expect(apocalypseIds.size).toBe(1);

    const { rows } = await db.query('SELECT * FROM apocalypse_cycles');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ACTIVE');
    expect(rows[0].cycle_id).toBe(results[0].cycle_id);
  });

  test('expiry rollover: simultaneous processes produce exactly one contiguous successor', async () => {
    // Predecessor that expires exactly at the barrier instant.
    const barrierMs = Date.now() + 1500;
    const predecessorStart = new Date(barrierMs - 30 * 60 * 1000).toISOString();
    const predecessorEnd = new Date(barrierMs).toISOString();
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'race-predecessor-seed', $1, $2, 1800000, 'ACTIVE')`,
      [predecessorStart, predecessorEnd]
    );

    const results = parseResults(await Promise.all(spawnRaceWorkers(barrierMs, barrierMs)));

    // Every caller converged on the same successor cycle.
    const cycleIds = new Set(results.map((r) => r.cycle_id));
    expect(cycleIds.size).toBe(1);

    const { rows } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(rows).toHaveLength(2);

    // Predecessor intact: completed once, original window preserved.
    expect(rows[0].apocalypse_id).toBe('APOC-0001');
    expect(rows[0].status).toBe('COMPLETED');
    expect(rows[0].seed).toBe('race-predecessor-seed');
    expect(new Date(rows[0].end_time).toISOString()).toBe(predecessorEnd);

    // Exactly one ACTIVE successor, chained: start = predecessor end, no overlap.
    const active = rows.filter((r) => r.status === 'ACTIVE');
    expect(active).toHaveLength(1);
    const successor = active[0];
    expect(successor.cycle_id).toBe(results[0].cycle_id);
    expect(new Date(successor.start_time).getTime()).toBe(new Date(rows[0].end_time).getTime());
    expect(new Date(successor.end_time).getTime()).toBeGreaterThan(barrierMs);

    // No overlapping windows anywhere in the table.
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i].start_time).getTime())
        .toBeGreaterThanOrEqual(new Date(rows[i - 1].end_time).getTime());
    }
  });
});
