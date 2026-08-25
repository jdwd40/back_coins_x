// V2-2: genuine multi-process races for Power and the position limit.
//
// Separate Node processes — never same-process Promise.all — are held behind
// a shared wall-clock barrier so their buys collide on the database advisory
// lock / row locks at (nearly) the same instant. All invariants are asserted
// directly in PostgreSQL. Pattern: __tests__/helpers/roundRaceWorker.js.

const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound } = require('../game/gameRoundService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(__dirname, 'helpers', 'roundRaceWorker.js');
const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

jest.setTimeout(45000);

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
    if (code !== 0) throw new Error(`race worker exited ${code}: ${stderr}`);
    const lines = stdout.trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  });
}

async function participantByUser(cycleId, userId) {
  const { rows } = await db.query(
    'SELECT * FROM apocalypse_participants WHERE cycle_id = $1 AND user_id = $2',
    [cycleId, userId]
  );
  return rows[0];
}

async function setupRace() {
  const now = new Date();
  const cycle = await reconcileCycle({ now, durationMs: LONG_DURATION_MS });
  const participant = await joinRound({ userId: 1, now });
  return { cycle, participant };
}

describe('V2-2: multi-process Power / position-limit races', () => {
  test('guard: this suite only runs against the approved disposable test database', () => {
    expect(assertDisposableTestDatabase().database).toMatch(/test/i);
  });

  test('concurrent buys can never overspend Power: exactly the affordable number commit', async () => {
    const { cycle, participant } = await setupRace();
    await db.query('UPDATE coins SET current_price = 125 WHERE coin_id = 1');
    // 6 Power available; 10 processes each try a £125 buy (2 Power each:
    // 1 + floor(125/125)).
    await db.query(
      'UPDATE apocalypse_participants SET power = 6, power_updated_at = now() WHERE participant_id = $1',
      [participant.participantId]
    );

    const barrierMs = Date.now() + 1500;
    const specs = Array.from({ length: 10 }, () => ({
      mode: 'buy',
      barrierMs,
      payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 1, nowMs: barrierMs }
    }));
    const results = parseResults(await Promise.all(spawnWorkers(specs)));

    const succeeded = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) {
      expect(r.status).toBe(400);
      expect(r.message).toMatch(/Insufficient Power/);
    }

    // Invariants in SQL: Power exactly 0 (never negative), cash debited
    // exactly the three successful totals, one holding with quantity 3,
    // exactly three ledger rows.
    const row = await participantByUser(cycle.cycle_id, 1);
    expect(Number(row.power)).toBe(0);
    expect(parseFloat(row.current_cash)).toBe(10000 - 3 * 125);
    const { rows: h } = await db.query(
      'SELECT quantity, cost_basis FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = 1',
      [participant.participantId]
    );
    expect(parseFloat(h[0].quantity)).toBe(3);
    expect(parseFloat(h[0].cost_basis)).toBe(375);
    const { rows: tx } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1 AND type = 'BUY'`,
      [participant.participantId]
    );
    expect(tx[0].n).toBe(3);
  });

  test('concurrent large buys drain Power exactly and never go negative', async () => {
    const { cycle, participant } = await setupRace();
    await db.query('UPDATE coins SET current_price = 250 WHERE coin_id = 2');
    // 7 Power; 5 processes each try a £250 buy (3 Power each): 2 succeed.
    await db.query(
      'UPDATE apocalypse_participants SET power = 7, power_updated_at = now() WHERE participant_id = $1',
      [participant.participantId]
    );

    const barrierMs = Date.now() + 1500;
    const specs = Array.from({ length: 5 }, () => ({
      mode: 'buy',
      barrierMs,
      payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 2, quantity: 1, nowMs: barrierMs }
    }));
    const results = parseResults(await Promise.all(spawnWorkers(specs)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(3);

    const row = await participantByUser(cycle.cycle_id, 1);
    expect(Number(row.power)).toBe(1); // 7 - 2*3, never negative
    expect(Number(row.power)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(row.current_cash)).toBe(10000 - 2 * 250);
  });

  test('position-limit race: five processes opening five distinct coins converge on exactly three live positions', async () => {
    const { cycle, participant } = await setupRace();
    for (const coinId of [1, 2, 3, 4, 5]) {
      await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = $1', [coinId]);
    }

    const barrierMs = Date.now() + 1500;
    const specs = [1, 2, 3, 4, 5].map((coinId) => ({
      mode: 'buy',
      barrierMs,
      payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 1, nowMs: barrierMs }
    }));
    const results = parseResults(await Promise.all(spawnWorkers(specs)));

    const succeeded = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.status).toBe(400);
      expect(r.message).toMatch(/Position limit reached/);
    }

    // Exactly three holdings exist, all with quantity 1 and £10 basis; the
    // two rejected attempts left no holding, no ledger row and no Power
    // spent (3 successful £10 buys = 3 Power).
    const { rows: holdings } = await db.query(
      'SELECT coin_id, quantity, cost_basis FROM apocalypse_holdings WHERE participant_id = $1 ORDER BY coin_id',
      [participant.participantId]
    );
    expect(holdings).toHaveLength(3);
    for (const h of holdings) {
      expect(parseFloat(h.quantity)).toBe(1);
      expect(parseFloat(h.cost_basis)).toBe(10);
    }
    const { rows: tx } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1',
      [participant.participantId]
    );
    expect(tx[0].n).toBe(3);
    const row = await participantByUser(cycle.cycle_id, 1);
    expect(Number(row.power)).toBe(97);
    expect(parseFloat(row.current_cash)).toBe(10000 - 30);
  });

  test('add-to-existing race at the cap: concurrent adds to a held coin are never blocked by the limit', async () => {
    const { cycle, participant } = await setupRace();
    for (const coinId of [1, 2, 3]) {
      await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = $1', [coinId]);
      await db.query(
        `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity, cost_basis)
         VALUES ($1, $2, 1, $3, 1, 10)
         ON CONFLICT (participant_id, coin_id) DO UPDATE SET quantity = EXCLUDED.quantity, cost_basis = EXCLUDED.cost_basis`,
        [participant.participantId, cycle.cycle_id, coinId]
      );
    }
    // 6 processes all add to coin 2 (an EXISTING live position) at the cap.
    const barrierMs = Date.now() + 1500;
    const specs = Array.from({ length: 6 }, () => ({
      mode: 'buy',
      barrierMs,
      payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 2, quantity: 1, nowMs: barrierMs }
    }));
    const results = parseResults(await Promise.all(spawnWorkers(specs)));
    expect(results.every((r) => r.ok)).toBe(true);

    const { rows: h } = await db.query(
      'SELECT quantity, cost_basis FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = 2',
      [participant.participantId]
    );
    expect(parseFloat(h[0].quantity)).toBe(7); // 1 + 6 adds, none lost
    expect(parseFloat(h[0].cost_basis)).toBe(70);
  });

  test('mixed race: concurrent buys on distinct coins while one process sells — sells always succeed at zero Power', async () => {
    const { cycle, participant } = await setupRace();
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 2');
    // Pre-load a position in coin 1 and zero Power.
    await db.query(
      `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, 1, 1, 5, 50)`,
      [participant.participantId, cycle.cycle_id]
    );
    await db.query(
      'UPDATE apocalypse_participants SET power = 0, power_updated_at = now() WHERE participant_id = $1',
      [participant.participantId]
    );

    const barrierMs = Date.now() + 1500;
    const specs = [
      { mode: 'sell', barrierMs, payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 5, nowMs: barrierMs } },
      { mode: 'buy', barrierMs, payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 2, quantity: 1, nowMs: barrierMs } }
    ];
    const results = parseResults(await Promise.all(spawnWorkers(specs)));
    const sell = results[0];
    const buy = results[1];
    // The sell is never Power-blocked; the buy is (0 Power, cost 1).
    expect(sell.ok).toBe(true);
    expect(buy.ok).toBe(false);
    expect(buy.message).toMatch(/Insufficient Power/);

    const row = await participantByUser(cycle.cycle_id, 1);
    expect(Number(row.power)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(row.current_cash)).toBe(10000 + 50); // sell credited £50, buy rolled back
  });
});
