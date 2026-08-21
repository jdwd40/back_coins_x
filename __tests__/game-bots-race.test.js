// Core 5: genuine multi-process bot races.
//
// Separate Node processes — never same-process Promise.all — are held behind
// a shared wall-clock barrier so their tick claims collide on the database at
// (nearly) the same instant. All invariants are asserted directly in
// PostgreSQL. The disposable local test database is the coordination
// authority; the guard module refuses any other target.

const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(__dirname, 'helpers', 'botRaceWorker.js');
const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

jest.setTimeout(60000);

function spawnWorkers(specs) {
  return specs.map((spec) => new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKER, spec.mode, String(spec.barrierMs), JSON.stringify(spec.payload || {})],
      { cwd: PROJECT_ROOT, env: { ...process.env, NODE_ENV: 'test' } }
    );
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
    if (code !== 0) throw new Error(`bot race worker exited ${code}: ${stderr}`);
    const lines = stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  });
}

describe('Core 5: genuine multi-process bot races', () => {
  test('guard: this suite only runs against the approved disposable test database', () => {
    const target = assertDisposableTestDatabase();
    expect(target.database).toMatch(/test/i);
  });

  test('duplicate tick race: 4 processes claiming one tick produce exactly one execution', async () => {
    const cycle = await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });

    const barrierMs = Date.now() + 2000;
    const specs = Array.from({ length: 4 }, () => ({
      mode: 'tick', barrierMs, payload: { tickId: 77, nowMs: barrierMs }
    }));
    const results = parseResults(await Promise.all(spawnWorkers(specs)));

    expect(results.every((r) => r.ok)).toBe(true);
    const executed = results.filter((r) => r.result.skipped === false);
    const duplicates = results.filter((r) => r.result.skipped === true && r.result.reason === 'duplicate-tick');
    expect(executed).toHaveLength(1);
    expect(duplicates).toHaveLength(3);

    // Exactly one durable tick row for the identity.
    const { rows: ticks } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_bot_ticks WHERE cycle_id = $1 AND tick_id = $2',
      [cycle.cycle_id, 77]
    );
    expect(ticks[0].n).toBe(1);

    // The roster was provisioned exactly once and joined exactly once each.
    const { rows: bots } = await db.query('SELECT count(*)::int AS n FROM users WHERE is_bot = true');
    expect(bots[0].n).toBe(4);
    const { rows: identities } = await db.query('SELECT count(*)::int AS n FROM apocalypse_bots');
    expect(identities[0].n).toBe(4);
    const { rows: participants } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_participants WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    expect(participants[0].n).toBe(4);
    for (const p of (await db.query(
      'SELECT * FROM apocalypse_participants WHERE cycle_id = $1', [cycle.cycle_id]
    )).rows) {
      expect(parseFloat(p.starting_cash)).toBe(1000);
      expect(parseFloat(p.current_cash)).toBeGreaterThanOrEqual(0);
    }

    // Ledger rows came from the single executed tick only.
    const executedCount = executed[0].result.actions.filter((a) => a.result === 'executed').length;
    const { rows: ledger } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_transactions WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    expect(ledger[0].n).toBe(executedCount);
  });

  test('tick racing rollover: universal invariants hold whichever interleaving wins', async () => {
    // Predecessor cycle expiring exactly at the barrier.
    const barrierMs = Date.now() + 2000;
    const predecessorStart = new Date(barrierMs - 30 * 60 * 1000).toISOString();
    const predecessorEnd = new Date(barrierMs).toISOString();
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'core5-race-predecessor-seed', $1, $2, 1800000, 'ACTIVE')`,
      [predecessorStart, predecessorEnd]
    );

    const specs = [
      // Bot tick that believes the predecessor is still live.
      { mode: 'tick', barrierMs, payload: { tickId: 5, nowMs: barrierMs - 1000 } },
      // Reconciler rolls the cycle over at the same instant.
      { mode: 'reconcile', barrierMs, payload: { nowMs: barrierMs + 2000 } }
    ];
    const results = parseResults(await Promise.all(spawnWorkers(specs)));
    expect(results.every((r) => r.ok)).toBe(true);

    // Ensure rollover has completed regardless of race order.
    await reconcileCycle({ now: new Date(barrierMs + 5000) });

    // Universal invariants, whichever interleaving won.
    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(2);
    expect(cycles[0].status).toBe('COMPLETED');
    expect(cycles[1].status).toBe('ACTIVE');

    // At most one tick row per (cycle, tick) identity; no duplicate claims.
    const { rows: dupTicks } = await db.query(
      `SELECT cycle_id, tick_id, count(*)::int AS n FROM apocalypse_bot_ticks
       GROUP BY cycle_id, tick_id HAVING count(*) > 1`
    );
    expect(dupTicks).toHaveLength(0);

    // Bots provisioned at most once each; participants finalized cleanly on
    // the predecessor and never negative anywhere.
    const { rows: bots } = await db.query('SELECT count(*)::int AS n FROM users WHERE is_bot = true');
    expect(bots[0].n).toBeLessThanOrEqual(4);
    const { rows: stale } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants p
       JOIN apocalypse_cycles ac ON ac.cycle_id = p.cycle_id
       WHERE ac.status = 'COMPLETED' AND p.status = 'ACTIVE'`
    );
    expect(stale[0].n).toBe(0);
    const { rows: badFinal } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants
       WHERE (status = 'FINALIZED' AND final_cash IS NULL)
          OR (status = 'ACTIVE' AND final_cash IS NOT NULL)
          OR current_cash < 0`
    );
    expect(badFinal[0].n).toBe(0);
    const { rows: negHoldings } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_holdings WHERE quantity < 0'
    );
    expect(negHoldings[0].n).toBe(0);

    // Legacy account state untouched by any bot activity in the race.
    const { rows: legacyTx } = await db.query(
      `SELECT count(*)::int AS n FROM transactions t JOIN users u ON u.user_id = t.user_id WHERE u.is_bot = true`
    );
    expect(legacyTx[0].n).toBe(0);
  });
});
