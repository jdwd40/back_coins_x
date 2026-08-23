// Issue #18: passive economic pressure — fees, taxes and Apocalypse events.
//
// Proves the full acceptance surface against the disposable test database:
// offline human fee/tax, events without any browser/session, bot parity,
// ledger evidence for every debit, fee/tax/event idempotency under replay
// and genuine concurrency, SETTLING/COMPLETED rejection, users.funds
// isolation, concurrent trade+debit exactness, money rounding, the
// never-negative clamp, unattended zero-human operation, late-join
// retro-charge protection, and the representative zero-trade full-round
// simulation landing in the £9,500–£9,800 target band.

const path = require('path');
const { spawn } = require('child_process');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const settlementService = require('../game/gameSettlementService');
const gameRoundService = require('../game/gameRoundService');
const economyService = require('../game/economyService');
const { resolveEconomyConfig } = require('../game/economyConfig');
const { ensureBotsProvisioned } = require('../game/botService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(45000);

const T0 = new Date('2026-01-05T00:00:00.000Z'); // aligned 30-min boundary
const MIN = 60 * 1000;
const at = (minutes) => new Date(T0.getTime() + minutes * MIN);

const WORKER = path.join(__dirname, 'helpers', 'economyRaceWorker.js');
const PROJECT_ROOT = path.resolve(__dirname, '..');

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function startCycle(now = T0) {
  return reconcileCycle({ now });
}

async function participants(cycleId) {
  const { rows } = await db.query(
    `SELECT p.participant_id, p.user_id, p.starting_cash, p.current_cash, p.status, u.is_bot
     FROM apocalypse_participants p JOIN users u ON u.user_id = p.user_id
     WHERE p.cycle_id = $1 ORDER BY p.participant_id`,
    [cycleId]
  );
  return rows;
}

async function cashEventsFor(cycleId, type) {
  const { rows } = await db.query(
    `SELECT * FROM apocalypse_cash_events WHERE cycle_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY cash_event_id`,
    type ? [cycleId, type] : [cycleId]
  );
  return rows;
}

async function userFunds(userId) {
  const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [userId]);
  return parseFloat(rows[0].funds);
}

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

// Expected zero-trade cash at an injected instant, computed from the
// persisted schedule so seed-dependent event timing never makes a test
// flaky: 10000 - due fees - due taxes - due events.
async function expectedZeroTradeCash(cycle, nowMs) {
  const startMs = new Date(cycle.start_time).getTime();
  const endMs = new Date(cycle.end_time).getTime();
  const elapsed = Math.max(0, Math.min(nowMs, endMs - 1) - startMs);
  const fees = Math.floor(elapsed / (2 * MIN)) * 5;
  const taxes = Math.floor(elapsed / (5 * MIN)) * 10;
  const { rows } = await db.query(
    'SELECT amount FROM apocalypse_economy_events WHERE cycle_id = $1 AND scheduled_at <= $2',
    [cycle.cycle_id, new Date(nowMs).toISOString()]
  );
  const events = rows.reduce((sum, r) => sum + parseFloat(r.amount), 0);
  return round2(10000 - fees - taxes - events);
}

describe('issue #18: economy configuration', () => {
  test('defaults resolve to the centralized conservative 30-minute tuning', () => {
    const config = resolveEconomyConfig({});
    expect(config.enabled).toBe(true);
    expect(config.feeTickIntervalMs).toBe(120000);
    expect(config.feeAmount).toBe(5);
    expect(config.taxTickIntervalMs).toBe(300000);
    expect(config.taxAmount).toBe(10);
    expect(config.eventCount).toBe(2);
    expect(config.eventMinAmount).toBe(50);
    expect(config.eventMaxAmount).toBe(150);
    expect(config.workerIntervalMs).toBe(30000);
  });

  test('malformed overrides are rejected, never silently coerced', () => {
    expect(() => resolveEconomyConfig({ GAME_FEE_AMOUNT: '5.001' })).toThrow(/GAME_FEE_AMOUNT/);
    expect(() => resolveEconomyConfig({ GAME_FEE_AMOUNT: 'abc' })).toThrow(/GAME_FEE_AMOUNT/);
    expect(() => resolveEconomyConfig({ GAME_FEE_AMOUNT: '-5' })).toThrow(/GAME_FEE_AMOUNT/);
    expect(() => resolveEconomyConfig({ GAME_FEE_TICK_INTERVAL_MS: '12.5' })).toThrow(/GAME_FEE_TICK_INTERVAL_MS/);
    expect(() => resolveEconomyConfig({ GAME_TAX_TICK_INTERVAL_MS: '1000' })).toThrow(/below the minimum/);
    expect(() => resolveEconomyConfig({ GAME_ECONOMY_ENABLED: 'maybe' })).toThrow(/GAME_ECONOMY_ENABLED/);
    expect(() => resolveEconomyConfig({ GAME_EVENT_COUNT: '-1' })).toThrow(/GAME_EVENT_COUNT/);
    expect(() => resolveEconomyConfig({ GAME_EVENT_MIN_FRACTION: '0.6', GAME_EVENT_MAX_FRACTION: '0.5' })).toThrow(/GAME_EVENT_MAX_FRACTION/);
    expect(resolveEconomyConfig({ GAME_ECONOMY_ENABLED: 'false' }).enabled).toBe(false);
  });

  test('event schedule is deterministic from the seed and stays inside the configured window', () => {
    const config = resolveEconomyConfig({});
    const start = T0;
    const end = at(30);
    const a = economyService.buildEventSchedule({ seed: 'seed-x', startTime: start, endTime: end, config });
    const b = economyService.buildEventSchedule({ seed: 'seed-x', startTime: start, endTime: end, config });
    expect(a).toEqual(b); // identical replay, forever
    expect(a).toHaveLength(2);
    for (const row of a) {
      expect(row.scheduled_at.getTime()).toBeGreaterThanOrEqual(T0.getTime() + 0.1 * 30 * MIN);
      expect(row.scheduled_at.getTime()).toBeLessThanOrEqual(T0.getTime() + 0.6 * 30 * MIN);
      expect(row.amount).toBeGreaterThanOrEqual(50);
      expect(row.amount).toBeLessThanOrEqual(150);
      // exact 2-decimal money
      expect(Math.round(row.amount * 100) - row.amount * 100).toBe(0);
      expect(typeof row.description).toBe('string');
      expect(row.description.length).toBeGreaterThan(0);
    }
    const other = economyService.buildEventSchedule({ seed: 'seed-y', startTime: start, endTime: end, config });
    expect(other).not.toEqual(a); // a different seed rolls a different schedule
    const none = economyService.buildEventSchedule({ seed: 'seed-x', startTime: start, endTime: end, config: { ...config, eventCount: 0 } });
    expect(none).toEqual([]);
  });

  test('tick arithmetic: ticks are 1-based and a tick exactly at cycle end never fires', () => {
    const startMs = T0.getTime();
    const endMs = startMs + 30 * MIN;
    const intervalMs = 2 * MIN;
    expect(economyService.latestDueTick({ startMs, endMs, nowMs: startMs + 1, intervalMs })).toBe(0);
    expect(economyService.latestDueTick({ startMs, endMs, nowMs: startMs + 2 * MIN, intervalMs })).toBe(1);
    expect(economyService.latestDueTick({ startMs, endMs, nowMs: startMs + 29 * MIN, intervalMs })).toBe(14);
    // At exactly cycle end the cycle is expired; tick 15 at 30:00 must never exist.
    expect(economyService.latestDueTick({ startMs, endMs, nowMs: endMs, intervalMs })).toBe(14);
    expect(economyService.latestDueTick({ startMs, endMs, nowMs: endMs + 60 * MIN, intervalMs })).toBe(14);
  });
});

describe('issue #18: passive drains', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('offline human is charged the recurring fee with no session, with full ledger evidence', async () => {
    const cycle = await startCycle();
    const summary = await economyService.runEconomyPass({ now: at(2) });
    expect(summary.feeTicks).toEqual([1]);
    expect(summary.taxTicks).toEqual([]);
    expect(summary.events).toEqual([]);

    const ps = await participants(cycle.cycle_id);
    expect(ps).toHaveLength(2); // seeded users 1-2, auto-participating offline
    for (const p of ps) {
      expect(parseFloat(p.current_cash)).toBe(9995);
    }
    const ledger = await cashEventsFor(cycle.cycle_id, 'FEE');
    expect(ledger).toHaveLength(2);
    for (const row of ledger) {
      expect(row.event_key).toBe('FEE-T1');
      expect(parseFloat(row.amount)).toBe(5);
      expect(parseFloat(row.balance_before)).toBe(10000);
      expect(parseFloat(row.balance_after)).toBe(9995);
      expect(row.description).toMatch(/fee/i);
      expect(row.created_at).toBeTruthy();
    }
  });

  test('offline human is charged the recurring tax on its independent cadence', async () => {
    const cycle = await startCycle();
    await economyService.runEconomyPass({ now: at(5) }); // fees T1,T2 + tax T1 (+ any due event)

    const ps = await participants(cycle.cycle_id);
    const expected = await expectedZeroTradeCash(cycle, at(5).getTime());
    for (const p of ps) {
      expect(parseFloat(p.current_cash)).toBe(expected);
    }
    const taxes = await cashEventsFor(cycle.cycle_id, 'TAX');
    expect(taxes).toHaveLength(2);
    for (const row of taxes) {
      expect(row.event_key).toBe('TAX-T1');
      expect(parseFloat(row.amount)).toBe(10);
      expect(parseFloat(row.balance_before)).toBe(round2(parseFloat(row.balance_after) + 10));
    }
  });

  test('a persisted Apocalypse event debits every participant with no browser or session', async () => {
    const cycle = await startCycle();
    const { rows: schedule } = await db.query(
      `SELECT event_key, scheduled_at, amount FROM apocalypse_economy_events
       WHERE cycle_id = $1 ORDER BY scheduled_at LIMIT 1`,
      [cycle.cycle_id]
    );
    expect(schedule).toHaveLength(1); // schedule persisted at cycle start
    const first = schedule[0];

    const summary = await economyService.runEconomyPass({ now: new Date(first.scheduled_at) });
    expect(summary.events).toEqual([first.event_key]);

    const events = await cashEventsFor(cycle.cycle_id, 'EVENT');
    expect(events).toHaveLength(2);
    for (const row of events) {
      expect(row.event_key).toBe(first.event_key);
      expect(parseFloat(row.amount)).toBe(parseFloat(first.amount));
      expect(row.description).toMatch(/^Apocalypse event:/);
    }
    const ps = await participants(cycle.cycle_id);
    const expected = await expectedZeroTradeCash(cycle, new Date(first.scheduled_at).getTime());
    for (const p of ps) {
      expect(parseFloat(p.current_cash)).toBe(expected);
    }
  });

  test('bots are charged identically to humans', async () => {
    const cycle = await startCycle();
    await ensureBotsProvisioned();
    // Recovery reconciliation picks the new bot users up as participants.
    await reconcileCycle({ now: at(1) });
    const before = await participants(cycle.cycle_id);
    expect(before).toHaveLength(6); // 2 humans + 4 roster bots

    await economyService.runEconomyPass({ now: at(2) });
    const ps = await participants(cycle.cycle_id);
    for (const p of ps) {
      expect(parseFloat(p.current_cash)).toBe(9995); // human and bot alike
    }
    const ledger = await cashEventsFor(cycle.cycle_id, 'FEE');
    expect(ledger).toHaveLength(6);
    expect(new Set(ledger.map((r) => r.event_key))).toEqual(new Set(['FEE-T1']));
  });

  test('every debit is ledgered and the ledger explains the cash exactly', async () => {
    const cycle = await startCycle();
    await economyService.runEconomyPass({ now: at(7) }); // fees T1-3, tax T1, EV-1 if due

    const ps = await participants(cycle.cycle_id);
    for (const p of ps) {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS drained, count(*)::int AS n
         FROM apocalypse_cash_events WHERE participant_id = $1`,
        [p.participant_id]
      );
      const drained = parseFloat(rows[0].drained);
      expect(rows[0].n).toBeGreaterThan(0);
      expect(round2(parseFloat(p.starting_cash) - parseFloat(p.current_cash))).toBe(drained);
      // Per-participant balance chain is contiguous and exact.
      const { rows: chain } = await db.query(
        `SELECT balance_before, balance_after, amount FROM apocalypse_cash_events
         WHERE participant_id = $1 ORDER BY cash_event_id`,
        [p.participant_id]
      );
      let expected = 10000;
      for (const link of chain) {
        expect(parseFloat(link.balance_before)).toBe(expected);
        expect(round2(parseFloat(link.balance_before) - parseFloat(link.amount))).toBe(parseFloat(link.balance_after));
        expected = parseFloat(link.balance_after);
      }
      expect(expected).toBe(parseFloat(p.current_cash));
    }
  });

  test('fee tick idempotency: replay, catch-up and concurrent passes never double-charge', async () => {
    const cycle = await startCycle();
    await economyService.runEconomyPass({ now: at(2) });
    const replay = await economyService.runEconomyPass({ now: at(2) });
    expect(replay.feeTicks).toEqual([]); // already claimed + committed
    expect(replay.participantsCharged).toBe(0);

    // Genuine concurrency: two processes race the same tick-2 pass.
    const barrierMs = Date.now() + 1500;
    const results = parseResults(await Promise.all(spawnWorkers([
      { mode: 'pass', barrierMs, payload: { nowMs: at(4).getTime() } },
      { mode: 'pass', barrierMs, payload: { nowMs: at(4).getTime() } }
    ])));
    expect(results.every((r) => r.ok)).toBe(true);
    const applied = results.filter((r) => r.result.feeTicks && r.result.feeTicks.length > 0);
    expect(applied.length).toBeLessThanOrEqual(1); // at most one process claimed tick 2

    const ps = await participants(cycle.cycle_id);
    const expected = await expectedZeroTradeCash(cycle, at(4).getTime());
    for (const p of ps) {
      expect(parseFloat(p.current_cash)).toBe(expected); // exactly one application of everything due
    }
    const { rows: feeLedger } = await db.query(
      `SELECT event_key, count(*)::int AS n FROM apocalypse_cash_events
       WHERE cycle_id = $1 AND type = 'FEE' GROUP BY event_key ORDER BY event_key`,
      [cycle.cycle_id]
    );
    expect(feeLedger).toEqual([
      { event_key: 'FEE-T1', n: 2 },
      { event_key: 'FEE-T2', n: 2 } // tick 2 applied exactly once despite the race
    ]);
    const { rows: ticks } = await db.query(
      `SELECT tick_id FROM apocalypse_economy_ticks WHERE cycle_id = $1 AND kind = 'FEE' ORDER BY tick_id`,
      [cycle.cycle_id]
    );
    expect(ticks.map((t) => Number(t.tick_id))).toEqual([1, 2]);
  });

  test('tax tick idempotency: rerunning the same window is a no-op', async () => {
    const cycle = await startCycle();
    await economyService.runEconomyPass({ now: at(5) });
    const again = await economyService.runEconomyPass({ now: at(5) });
    const third = await economyService.runEconomyPass({ now: at(9) }); // no new tax tick due until +10
    expect(again.participantsCharged).toBe(0);
    expect(third.taxTicks).toEqual([]);

    const taxes = await cashEventsFor(cycle.cycle_id, 'TAX');
    expect(taxes).toHaveLength(2); // one TAX-T1 row per participant, ever
    const ps = await participants(cycle.cycle_id);
    const expected = await expectedZeroTradeCash(cycle, at(9).getTime());
    for (const p of ps) {
      expect(parseFloat(p.current_cash)).toBe(expected);
    }
  });

  test('event execution is idempotent across retries and restarts — persisted, never rerolled', async () => {
    const cycle = await startCycle();
    const { rows: before } = await db.query(
      'SELECT event_key, scheduled_at, amount, description FROM apocalypse_economy_events WHERE cycle_id = $1 ORDER BY event_key',
      [cycle.cycle_id]
    );

    await economyService.runEconomyPass({ now: at(30 - 1) }); // everything due except the final boundary
    const { rows: after } = await db.query(
      'SELECT event_key, scheduled_at, amount, description, executed_at FROM apocalypse_economy_events WHERE cycle_id = $1 ORDER BY event_key',
      [cycle.cycle_id]
    );
    // The schedule was never rerolled: identical rows, now executed.
    expect(after.map((r) => [r.event_key, r.scheduled_at.toISOString(), parseFloat(r.amount), r.description]))
      .toEqual(before.map((r) => [r.event_key, r.scheduled_at.toISOString(), parseFloat(r.amount), r.description]));
    expect(after.every((r) => r.executed_at !== null)).toBe(true);

    // A "restart" pass over the same executed window applies nothing.
    const replay = await economyService.runEconomyPass({ now: at(30 - 1) });
    expect(replay.events).toEqual([]);
    expect(replay.participantsCharged).toBe(0);

    const events = await cashEventsFor(cycle.cycle_id, 'EVENT');
    expect(events).toHaveLength(2 * before.length); // exactly one row per participant per event
  });

  test('no debit lands once the cycle stops being ACTIVE (SETTLING/COMPLETED)', async () => {
    const cycle = await startCycle();
    await economyService.runEconomyPass({ now: at(2) }); // one fee lands while live

    // Expire the cycle, freeze it, settle it, roll into the successor.
    const endMs = new Date(cycle.end_time).getTime();
    const frozen = await settlementService.freezeExpiredActiveCycle({ nowMs: endMs + 1 });
    expect(frozen && frozen.cycle_id).toBe(cycle.cycle_id);

    // The pass reconciles (settle + successor) and must never touch the old cycle.
    const summary = await economyService.runEconomyPass({ now: new Date(endMs + 1) });
    expect(summary.cycleId).not.toBe(cycle.cycle_id);

    const { rows: oldCycle } = await db.query(
      `SELECT status FROM apocalypse_cycles WHERE cycle_id = $1`, [cycle.cycle_id]
    );
    expect(['SETTLING', 'COMPLETED']).toContain(oldCycle[0].status);
    const ps = await participants(cycle.cycle_id);
    for (const p of ps) {
      expect(parseFloat(p.current_cash)).toBe(9995); // only the live-window fee
    }
    const ledger = await cashEventsFor(cycle.cycle_id);
    expect(ledger).toHaveLength(2); // FEE-T1 for two participants; nothing after expiry
    const { rows: ticks } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_economy_ticks WHERE cycle_id = $1`,
      [cycle.cycle_id]
    );
    expect(ticks[0].n).toBe(1); // tick claims never crossed the boundary either
  });

  test('users.funds is never touched by any drain', async () => {
    const cycle = await startCycle();
    const fundsBefore = [await userFunds(1), await userFunds(2)];
    await economyService.runEconomyPass({ now: at(29) }); // everything in the window
    expect(await userFunds(1)).toBe(fundsBefore[0]);
    expect(await userFunds(2)).toBe(fundsBefore[1]);
    const ps = await participants(cycle.cycle_id);
    expect(parseFloat(ps[0].current_cash)).toBeLessThan(10000); // drains did happen
  });

  test('cash clamps at zero: debits never drive a balance negative', async () => {
    const cycle = await startCycle();
    // User 1 is nearly broke; user 2 is exactly broke.
    await db.query(
      `UPDATE apocalypse_participants SET current_cash = CASE user_id WHEN 1 THEN 2.00 ELSE 0.00 END
       WHERE cycle_id = $1`,
      [cycle.cycle_id]
    );
    await economyService.runEconomyPass({ now: at(2) });

    const ps = await participants(cycle.cycle_id);
    expect(parseFloat(ps[0].current_cash)).toBe(0); // charged min(£5, £2) = £2
    expect(parseFloat(ps[1].current_cash)).toBe(0); // nothing to charge

    const ledger = await cashEventsFor(cycle.cycle_id, 'FEE');
    expect(ledger).toHaveLength(1); // no zero-amount rows (amount > 0 CHECK)
    expect(parseFloat(ledger[0].amount)).toBe(2);
    expect(parseFloat(ledger[0].balance_before)).toBe(2);
    expect(parseFloat(ledger[0].balance_after)).toBe(0);

    const { rows: negatives } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_participants WHERE current_cash < 0'
    );
    expect(negatives[0].n).toBe(0);
  });

  test('concurrent trade and debit serialise on the advisory lock with exact final cash', async () => {
    const cycle = await startCycle();
    const { rows: coinRows } = await db.query(
      `SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id LIMIT 1`
    );
    const coinId = coinRows[0].coin_id;
    await db.query('UPDATE coins SET current_price = 100.00 WHERE coin_id = $1', [coinId]);

    // One process buys 10 units (£1,000); another runs the tick-1 fee pass —
    // fired at the same barrier instant so they genuinely collide.
    const barrierMs = Date.now() + 1500;
    const results = parseResults(await Promise.all(spawnWorkers([
      { mode: 'buy', barrierMs, payload: { userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 10, nowMs: at(1).getTime() } },
      { mode: 'pass', barrierMs, payload: { nowMs: at(2).getTime() } }
    ])));
    expect(results.every((r) => r.ok)).toBe(true);

    // Whatever order they committed in, the arithmetic is exact:
    // 10000 - 1000 (buy) - 5 (fee) and no lost update in either direction.
    const ps = await participants(cycle.cycle_id);
    const buyer = ps.find((p) => p.user_id === 1);
    const bystander = ps.find((p) => p.user_id === 2);
    expect(parseFloat(buyer.current_cash)).toBe(8995);
    expect(parseFloat(bystander.current_cash)).toBe(9995);
    const { rows: holding } = await db.query(
      'SELECT quantity FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
      [buyer.participant_id, coinId]
    );
    expect(parseFloat(holding[0].quantity)).toBe(10);
    const ledger = await cashEventsFor(cycle.cycle_id, 'FEE');
    expect(ledger).toHaveLength(2); // the fee hit both, exactly once each
  });

  test('unattended operation with zero humans: the pass runs cleanly and mid-cycle registrants join the same economy', async () => {
    // Zero users at all: cycle starts empty, drains are a clean no-op.
    await db.query('DELETE FROM users');
    const cycle = await startCycle();
    expect((await participants(cycle.cycle_id))).toHaveLength(0);
    const empty = await economyService.runEconomyPass({ now: at(6) });
    expect(empty.skipped).toBe(false);
    expect(empty.participantsCharged).toBe(0);

    // A user registers mid-cycle; recovery adds them at the full £10,000.
    // Drains are claimed on the server cadence against whoever participates
    // at that moment: ticks/events already claimed during the empty window
    // stay claimed (their starting cash is never adjusted — no retro
    // charges), and the registrant joins every drain claimed after their
    // participant row exists.
    await db.query(
      `INSERT INTO users (username, email, password_hash, funds)
       VALUES ('latecomer', 'late@example.com', 'x', 1000)`
    );
    await reconcileCycle({ now: at(7) });
    const ps = await participants(cycle.cycle_id);
    expect(ps).toHaveLength(1);
    expect(parseFloat(ps[0].current_cash)).toBe(10000);

    await economyService.runEconomyPass({ now: at(9) });
    const after = await participants(cycle.cycle_id);
    // Exactly: FEE-T4 (£5, claimed at this pass) plus any event scheduled in
    // the (at(6), at(9)] window. Ticks claimed by the empty at(6) pass
    // (FEE-T1..T3, TAX-T1, earlier events) were committed with zero
    // participants and are never re-charged.
    const { rows: midEvents } = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM apocalypse_economy_events
       WHERE cycle_id = $1 AND scheduled_at > $2 AND scheduled_at <= $3`,
      [cycle.cycle_id, at(6).toISOString(), at(9).toISOString()]
    );
    expect(parseFloat(after[0].current_cash)).toBe(round2(9995 - parseFloat(midEvents[0].total)));
    const { rows: ledger } = await db.query(
      `SELECT event_key FROM apocalypse_cash_events
       WHERE participant_id = $1 AND type = 'FEE' ORDER BY cash_event_id`,
      [after[0].participant_id]
    );
    expect(ledger.map((r) => r.event_key)).toEqual(['FEE-T4']);
  });

  test('representative zero-trade full-round simulation finishes below £10,000 inside the target band', async () => {
    const cycle = await startCycle();
    const fundsBefore = await userFunds(1);

    // Unattended server-side operation: one pass per minute, no sessions.
    for (let m = 1; m < 30; m++) {
      await economyService.runEconomyPass({ now: at(m) });
    }
    // Rollover: freeze, settle, successor.
    await reconcileCycle({ now: at(31) });

    const { rows: fin } = await db.query(
      `SELECT p.participant_id, p.user_id, p.starting_cash, p.final_cash, p.status
       FROM apocalypse_participants p WHERE p.cycle_id = $1 ORDER BY p.user_id`,
      [cycle.cycle_id]
    );
    expect(fin).toHaveLength(2);
    for (const row of fin) {
      const finalCash = parseFloat(row.final_cash);
      expect(row.status).toBe('FINALIZED');
      expect(parseFloat(row.starting_cash)).toBe(10000);
      expect(finalCash).toBeLessThan(10000);
      expect(finalCash).toBeGreaterThanOrEqual(9500);
      expect(finalCash).toBeLessThanOrEqual(9800);

      // Every pound of the drain is auditable.
      const { rows: sums } = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS drained FROM apocalypse_cash_events WHERE participant_id = $1`,
        [row.participant_id]
      );
      expect(round2(10000 - finalCash)).toBe(parseFloat(sums[0].drained));
    }
    // The immutable results snapshot agrees.
    const { rows: results } = await db.query(
      'SELECT user_id, final_cash, net_profit FROM apocalypse_results WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(parseFloat(r.net_profit)).toBeLessThan(0);
      expect(parseFloat(r.final_cash)).toBe(parseFloat(fin.find((f) => f.user_id === r.user_id).final_cash));
    }
    expect(await userFunds(1)).toBe(fundsBefore); // legacy funds untouched
  });
});

describe('issue #18: player-safe API (frontend #11 contract)', () => {
  test('GET /api/game/participant requires authentication', async () => {
    const res = await request(app).get('/api/game/participant');
    expect(res.status).toBe(401);
  });

  test('returns authoritative Cash plus recent FEE/TAX/EVENT rows, with no internal secrets', async () => {
    // Real-time-aligned live cycle: the endpoint reconciles with the real
    // clock, so the cycle must be genuinely live NOW.
    const cycle = await reconcileCycle({ now: new Date() });
    const startMs = new Date(cycle.start_time).getTime();
    await economyService.runEconomyPass({ now: new Date(startMs + 5 * MIN) }); // fees + tax (+ any due event)

    const res = await request(app)
      .get('/api/game/participant')
      .set('Authorization', `Bearer ${tokenFor(1)}`);
    expect(res.status).toBe(200);
    const { participant, cashEvents } = res.body.data;
    expect(participant.userId).toBe(1);
    const expected = await expectedZeroTradeCash(cycle, startMs + 5 * MIN);
    expect(participant.currentCash).toBe(expected);
    expect(cashEvents.length).toBeGreaterThanOrEqual(3); // FEE-T1, FEE-T2, TAX-T1 (+ any due event)
    const keys = cashEvents.map((e) => e.eventKey);
    expect(keys.filter((k) => k === 'FEE-T1')).toHaveLength(1);
    expect(keys.filter((k) => k === 'FEE-T2')).toHaveLength(1);
    expect(keys.filter((k) => k === 'TAX-T1')).toHaveLength(1);
    // Newest first.
    const ids = cashEvents.map((e) => e.cashEventId);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    for (const e of cashEvents) {
      expect(['FEE', 'TAX', 'EVENT']).toContain(e.type);
      expect(e.amount).toBeGreaterThan(0);
      expect(typeof e.description).toBe('string');
      expect(typeof e.createdAt).toBe('string');
      expect(e.balanceAfter).toBeLessThan(e.balanceBefore);
    }
    // No internal secrets or future event information anywhere in the payload.
    const payload = JSON.stringify(res.body);
    expect(payload).not.toMatch(/seed/i);
    expect(payload).not.toMatch(/scheduled_at|scheduledAt/);
    // Future events exist in the persisted schedule but are not executed:
    // the player's feed shows EXECUTED debits only.
    const { rows: futureEvents } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_economy_events WHERE cycle_id = $1 AND executed_at IS NULL',
      [cycle.cycle_id]
    );
    expect(cashEvents.filter((e) => e.type === 'EVENT')).toHaveLength(2 - futureEvents[0].n);
  });

  test('validates the history limit', async () => {
    await reconcileCycle({ now: new Date() });
    const res = await request(app)
      .get('/api/game/participant?limit=abc')
      .set('Authorization', `Bearer ${tokenFor(1)}`);
    expect(res.status).toBe(400);
    const ok = await request(app)
      .get('/api/game/participant?limit=1')
      .set('Authorization', `Bearer ${tokenFor(1)}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.cashEvents.length).toBeLessThanOrEqual(1);
  });
});

function round2(value) {
  return Math.round(value * 100) / 100;
}
