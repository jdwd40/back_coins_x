// Core 4: genuine multi-process races against round state.
//
// Separate Node processes — never same-process Promise.all — are held behind
// a shared wall-clock barrier so their operations collide on the database at
// (nearly) the same instant. All invariants are asserted directly in
// PostgreSQL. The disposable local test database is the coordination
// authority; the guard module refuses any other target.

const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound, buyRoundTrade } = require('../game/gameRoundService');
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
  return rows;
}

describe('Core 4: genuine multi-process races', () => {
  test('guard: this suite only runs against the approved disposable test database', () => {
    const target = assertDisposableTestDatabase();
    expect(target.database).toMatch(/test/i);
  });

  test('duplicate join race: 6 processes joining one user create exactly one participant with £1,000', async () => {
    const barrierMs = Date.now() + 1500;
    const specs = Array.from({ length: 6 }, () => ({
      mode: 'join', barrierMs, payload: { userId: 1, nowMs: barrierMs }
    }));
    const results = parseResults(await Promise.all(spawnWorkers(specs)));

    // Every process succeeded and converged on the same participant row.
    expect(results.every((r) => r.ok)).toBe(true);
    const participantIds = new Set(results.map((r) => r.result.participantId));
    expect(participantIds.size).toBe(1);

    const { rows: cycles } = await db.query(`SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE'`);
    expect(cycles).toHaveLength(1);
    const participants = await participantByUser(cycles[0].cycle_id, 1);
    expect(participants).toHaveLength(1);
    expect(parseFloat(participants[0].starting_cash)).toBe(1000);
    expect(parseFloat(participants[0].current_cash)).toBe(1000);
    expect(parseFloat(participants[0].peak_wealth)).toBe(1000);
    // Exactly one join ever happened globally for this user.
    const { rows: all } = await db.query('SELECT count(*)::int AS n FROM apocalypse_participants WHERE user_id = 1');
    expect(all[0].n).toBe(1);
  });

  test('overspend buy race: concurrent buys can never overspend or drive round cash negative', async () => {
    const cycle = await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
    await joinRound({ userId: 1, now: new Date() });
    const { rows: coinRows } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 1');
    const coinId = coinRows[0].coin_id;
    await db.query('UPDATE coins SET current_price = 100.00 WHERE coin_id = $1', [coinId]);

    // Two processes each try to buy £600 of coin with only £1,000 round cash.
    const barrierMs = Date.now() + 1500;
    const specs = Array.from({ length: 2 }, () => ({
      mode: 'buy', barrierMs,
      payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 6, nowMs: barrierMs }
    }));
    const results = parseResults(await Promise.all(spawnWorkers(specs)));

    const succeeded = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe(400);
    expect(rejected[0].message).toMatch(/Insufficient round cash/);

    // Invariants asserted directly in PostgreSQL.
    const participants = await participantByUser(cycle.cycle_id, 1);
    expect(parseFloat(participants[0].current_cash)).toBe(400);
    const { rows: h } = await db.query(
      'SELECT quantity FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
      [participants[0].participant_id, coinId]
    );
    expect(h).toHaveLength(1);
    expect(parseFloat(h[0].quantity)).toBe(6);
    const { rows: t } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1 AND type = 'BUY'`,
      [participants[0].participant_id]
    );
    expect(t[0].n).toBe(1);
    const { rows: neg } = await db.query('SELECT count(*)::int AS n FROM apocalypse_participants WHERE current_cash < 0');
    expect(neg[0].n).toBe(0);
    // Legacy funds never touched.
    const { rows: u } = await db.query('SELECT funds FROM users WHERE user_id = 1');
    expect(parseFloat(u[0].funds)).toBe(1000);
  });

  test('oversell sell race: concurrent sells can never produce negative holdings', async () => {
    const cycle = await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
    await joinRound({ userId: 1, now: new Date() });
    const { rows: coinRows } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 1');
    const coinId = coinRows[0].coin_id;
    await db.query('UPDATE coins SET current_price = 100.00 WHERE coin_id = $1', [coinId]);
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 5, now: new Date() });

    // Two processes each try to sell the entire 5-unit holding.
    const barrierMs = Date.now() + 1500;
    const specs = Array.from({ length: 2 }, () => ({
      mode: 'sell', barrierMs,
      payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 5, nowMs: barrierMs }
    }));
    const results = parseResults(await Promise.all(spawnWorkers(specs)));

    const succeeded = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe(400);
    expect(rejected[0].message).toMatch(/Insufficient round holdings/);

    const participants = await participantByUser(cycle.cycle_id, 1);
    // Exactly one £500 sale landed: 1000 - 500 (buy) + 500 (sell) = 1000.
    expect(parseFloat(participants[0].current_cash)).toBe(1000);
    const { rows: h } = await db.query(
      'SELECT quantity FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
      [participants[0].participant_id, coinId]
    );
    expect(parseFloat(h[0].quantity)).toBe(0);
    const { rows: t } = await db.query(
      `SELECT type, count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1 GROUP BY type ORDER BY type`,
      [participants[0].participant_id]
    );
    expect(t).toEqual([{ type: 'BUY', n: 1 }, { type: 'SELL', n: 1 }]);
    const { rows: neg } = await db.query('SELECT count(*)::int AS n FROM apocalypse_holdings WHERE quantity < 0');
    expect(neg[0].n).toBe(0);
  });

  test('trade racing rollover: a buy colliding with cycle rollover leaves either a finalized traded state or a clean rejection — never corruption', async () => {
    // Predecessor cycle expiring exactly at the barrier.
    const barrierMs = Date.now() + 2000;
    const predecessorStart = new Date(barrierMs - 30 * 60 * 1000).toISOString();
    const predecessorEnd = new Date(barrierMs).toISOString();
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'race4-predecessor-seed', $1, $2, 1800000, 'ACTIVE')`,
      [predecessorStart, predecessorEnd]
    );
    // Join before expiry (a fixed pre-barrier now keeps the predecessor
    // live). Joining this late in the cycle executes every due collapse, so
    // the trade below must target the LAST-ranked coin: the only coin still
    // alive until the exact cycle end.
    const joinNow = new Date(barrierMs - 60 * 1000);
    const participant = await joinRound({ userId: 1, now: joinNow });
    expect(participant.apocalypseId).toBe('APOC-0001');
    const { rows: lastCoin } = await db.query(
      `SELECT cs.coin_id, c.current_price
       FROM coin_collapse_schedule cs JOIN coins c ON c.coin_id = cs.coin_id
       WHERE cs.cycle_id = $1 AND cs.executed_at IS NULL
       ORDER BY cs.collapse_rank DESC LIMIT 1`,
      [participant.cycleId]
    );
    const coin = lastCoin[0];
    const price = parseFloat(coin.current_price);
    expect(price).toBeGreaterThan(0);

    const specs = [
      // Buyer believes the round is still live (now = 2s before the end).
      { mode: 'buy', barrierMs, payload: { userId: 1, apocalypseId: 'APOC-0001', coinId: coin.coin_id, quantity: 2, nowMs: barrierMs - 2000 } },
      // Reconciler rolls the cycle over at the same instant.
      { mode: 'reconcile', barrierMs, payload: { nowMs: barrierMs + 2000 } }
    ];
    const [buyResult, rolloverResult] = parseResults(await Promise.all(spawnWorkers(specs)));
    expect(rolloverResult.ok).toBe(true);

    // Ensure rollover has completed regardless of race order.
    await reconcileCycle({ now: new Date(barrierMs + 5000) });

    // Universal invariants, whichever interleaving won.
    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(2);
    expect(cycles[0].status).toBe('COMPLETED');
    expect(cycles[1].status).toBe('ACTIVE');

    const p = (await participantByUser(cycles[0].cycle_id, 1))[0];
    expect(p.status).toBe('FINALIZED');
    expect(parseFloat(p.final_cash)).toBeCloseTo(parseFloat(p.current_cash), 2);
    expect(parseFloat(p.current_cash)).toBeGreaterThanOrEqual(0);

    const { rows: h } = await db.query(
      'SELECT * FROM apocalypse_holdings WHERE participant_id = $1', [p.participant_id]
    );
    const { rows: t } = await db.query(
      'SELECT * FROM apocalypse_transactions WHERE participant_id = $1', [p.participant_id]
    );

    if (buyResult.ok) {
      // The buy committed before finalization: cash/holding/ledger are all
      // consistent and the final cash includes the trade.
      const total = Math.round(2 * price * 100) / 100;
      expect(parseFloat(p.current_cash)).toBeCloseTo(1000 - total, 2);
      expect(parseFloat(p.final_cash)).toBeCloseTo(1000 - total, 2);
      expect(h).toHaveLength(1);
      expect(parseFloat(h[0].quantity)).toBe(2);
      expect(t).toHaveLength(1);
      expect(t[0].type).toBe('BUY');
    } else {
      // The rollover won the lock first: the trade was cleanly rejected as
      // stale and nothing was written.
      expect(buyResult.status).toBe(409);
      expect(buyResult.message).toMatch(/no longer active/);
      expect(parseFloat(p.current_cash)).toBe(1000);
      expect(parseFloat(p.final_cash)).toBe(1000);
      expect(h).toHaveLength(0);
      expect(t).toHaveLength(0);
    }
  });
});
