// Issue #17: continuous automatic participation — every registered human and
// every configured bot receives exactly one £10,000 participant row per
// Apocalypse, created by the server at cycle start/reconcile time. There is
// no JOIN step, no human needs to be online, retries/restarts/concurrent
// workers can never duplicate state, and nothing leaks between cycles.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound } = require('../game/gameRoundService');
const { GAME_STARTING_CASH, resolveGameStartingCash } = require('../game/gameConstants');
const botService = require('../game/botService');
const { BOT_ROSTER } = require('../game/botConfig');

const CYCLE_START_MS = new Date('2026-08-20T10:00:00.000Z').getTime();
const DURATION_MS = 30 * 60 * 1000;
const atPercent = (pct) => new Date(CYCLE_START_MS + (DURATION_MS * pct) / 100);

async function participantsFor(cycleId) {
  const { rows } = await db.query(
    `SELECT p.*, u.is_bot FROM apocalypse_participants p
     JOIN users u ON u.user_id = p.user_id
     WHERE p.cycle_id = $1 ORDER BY p.user_id`,
    [cycleId]
  );
  return rows;
}

async function activeCycle() {
  const { rows } = await db.query(
    `SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE' LIMIT 1`
  );
  return rows[0];
}

describe('issue #17: authoritative £10,000 starting cash', () => {
  test('the game constant and default resolution are exactly £10,000', () => {
    expect(GAME_STARTING_CASH).toBe(10000);
    expect(resolveGameStartingCash(undefined)).toBe(10000);
    expect(resolveGameStartingCash('')).toBe(10000);
  });
});

describe('issue #17: automatic participant initialization', () => {
  test('cycle creation initializes every registered human at exactly £10,000 with no API call', async () => {
    // No login, no join, no HTTP — pure server-side reconciliation.
    const cycle = await reconcileCycle({ now: atPercent(0.5) });

    const participants = await participantsFor(cycle.cycle_id);
    // Seeded humans are user_ids 1-2 (john_doe, jane_smith).
    const humans = participants.filter((p) => p.is_bot !== true);
    expect(humans.length).toBeGreaterThanOrEqual(2);
    for (const p of humans) {
      expect(p.starting_cash).toBe('10000.00');
      expect(p.current_cash).toBe('10000.00');
      expect(p.peak_wealth).toBe('10000.00');
      expect(p.status).toBe('ACTIVE');
    }
  });

  test('offline users are participants: state exists without any session, login or join', async () => {
    const cycle = await reconcileCycle({ now: atPercent(1) });
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants
       WHERE cycle_id = $1 AND user_id IN (1, 2) AND starting_cash = 10000.00`,
      [cycle.cycle_id]
    );
    expect(rows[0].n).toBe(2);
  });

  test('every configured bot is initialized exactly once', async () => {
    await botService.ensureBotsProvisioned();
    const cycle = await reconcileCycle({ now: atPercent(0.5) });

    for (const bot of BOT_ROSTER) {
      const { rows } = await db.query(
        `SELECT p.* FROM apocalypse_participants p
         JOIN users u ON u.user_id = p.user_id
         WHERE p.cycle_id = $1 AND u.username = $2`,
        [cycle.cycle_id, bot.username]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].starting_cash).toBe('10000.00');
      expect(rows[0].current_cash).toBe('10000.00');
    }

    // Reconcile again: still exactly one participant per bot.
    await reconcileCycle({ now: atPercent(2) });
    await botService.ensureBotsProvisioned();
    await reconcileCycle({ now: atPercent(3) });
    const { rows } = await db.query(
      `SELECT u.username, count(*)::int AS n
       FROM apocalypse_participants p JOIN users u ON u.user_id = p.user_id
       WHERE p.cycle_id = $1 AND u.is_bot = true
       GROUP BY u.username`,
      [cycle.cycle_id]
    );
    expect(rows).toHaveLength(BOT_ROSTER.length);
    for (const row of rows) expect(row.n).toBe(1);
  });

  test('repeated reconciles and joins never duplicate or reset a participant', async () => {
    const cycle = await reconcileCycle({ now: atPercent(0.5) });
    await reconcileCycle({ now: atPercent(1) });
    await reconcileCycle({ now: atPercent(2) });

    // Disturb user 1's cash; neither reconcile nor join may repair/reset it.
    await db.query(
      `UPDATE apocalypse_participants SET current_cash = 4321.00
       WHERE cycle_id = $1 AND user_id = 1`,
      [cycle.cycle_id]
    );
    await reconcileCycle({ now: atPercent(3) });
    const state = await joinRound({ userId: 1, now: atPercent(4) });
    expect(state.currentCash).toBe(4321);
    expect(state.startingCash).toBe(10000);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants
       WHERE cycle_id = $1 AND user_id = 1`,
      [cycle.cycle_id]
    );
    expect(rows[0].n).toBe(1);
  });

  test('concurrent reconcile/join cannot duplicate participants or starting cash', async () => {
    const now = atPercent(0.5);
    await Promise.all([
      reconcileCycle({ now }),
      reconcileCycle({ now }),
      joinRound({ userId: 1, now: atPercent(1) }),
      joinRound({ userId: 2, now: atPercent(1) })
    ]);
    const cycle = await activeCycle();
    const { rows } = await db.query(
      `SELECT user_id, count(*)::int AS n FROM apocalypse_participants
       WHERE cycle_id = $1 GROUP BY user_id`,
      [cycle.cycle_id]
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.n).toBe(1);
    const { rows: sums } = await db.query(
      `SELECT count(*)::int AS over_paid FROM apocalypse_participants
       WHERE cycle_id = $1 AND starting_cash <> 10000.00`,
      [cycle.cycle_id]
    );
    expect(sums[0].over_paid).toBe(0);
  });

  test('a new registration during ACTIVE play gets exactly one £10,000 participant immediately', async () => {
    // Registration joins at REAL time, so this test uses the real clock
    // (the fixed 2026-08-20 cycle would be long expired by wall-clock now).
    await reconcileCycle({ now: new Date() });

    const response = await request(app)
      .post('/api/users/register')
      .send({ username: 'midcycle_newbie', email: 'midcycle_newbie@example.com', password: 'password123' })
      .expect(201);
    const userId = response.body.user.user_id;

    // Registration itself ensured the participant in whatever cycle is
    // ACTIVE right now (robust even if a boundary lands mid-test).
    const cycle = await activeCycle();
    let { rows } = await db.query(
      `SELECT * FROM apocalypse_participants WHERE cycle_id = $1 AND user_id = $2`,
      [cycle.cycle_id, userId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].starting_cash).toBe('10000.00');
    expect(rows[0].current_cash).toBe('10000.00');

    // Later reconciles and an explicit ensure keep it exactly one row.
    await reconcileCycle({ now: new Date() });
    await joinRound({ userId, now: new Date() });
    ({ rows } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants WHERE cycle_id = $1 AND user_id = $2`,
      [cycle.cycle_id, userId]
    ));
    expect(rows[0].n).toBe(1);
  });

  test('initialization never touches legacy users.funds', async () => {
    await db.query(`UPDATE users SET funds = 7777.00 WHERE user_id = 1`);
    await reconcileCycle({ now: atPercent(0.5) });
    const { rows } = await db.query(`SELECT funds FROM users WHERE user_id = 1`);
    expect(parseFloat(rows[0].funds)).toBe(7777);
  });
});

describe('issue #17: unattended continuous rollover', () => {
  test('successor cycle auto-starts and re-initializes everyone at £10,000 with zero humans connected', async () => {
    // Round 1 at 10:00-10:30; disturb user 1 so leakage would be visible.
    const cycle1 = await reconcileCycle({ now: atPercent(0.5) });
    const { rows: p1rows } = await db.query(
      `SELECT participant_id FROM apocalypse_participants WHERE cycle_id = $1 AND user_id = 1`,
      [cycle1.cycle_id]
    );
    const participant1 = p1rows[0].participant_id;
    await db.query(
      `UPDATE apocalypse_participants SET current_cash = 123.45 WHERE participant_id = $1`,
      [participant1]
    );
    const { rows: coinRows } = await db.query(
      `SELECT coin_id FROM coins ORDER BY coin_id LIMIT 1`
    );
    await db.query(
      `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity)
       VALUES ($1, $2, 1, $3, 5)`,
      [participant1, cycle1.cycle_id, coinRows[0].coin_id]
    );

    // No HTTP requests, no joins, no humans: pure server-side rollover.
    const cycle2 = await reconcileCycle({ now: atPercent(110) });

    expect(cycle2.cycle_id).not.toBe(cycle1.cycle_id);
    expect(cycle2.status).toBe('ACTIVE');

    // Round 1 settled: participant finalized with the disturbed cash, and
    // the immutable result preserves it (losing results are history, not
    // leaderboard entries — full profit filtering is issue #19).
    const { rows: oldRows } = await db.query(
      `SELECT status, final_cash FROM apocalypse_participants WHERE participant_id = $1`,
      [participant1]
    );
    expect(oldRows[0].status).toBe('FINALIZED');
    expect(oldRows[0].final_cash).toBe('123.45');

    // Round 2: every registered user has fresh £10,000 and no holdings.
    const participants2 = await participantsFor(cycle2.cycle_id);
    expect(participants2.length).toBeGreaterThanOrEqual(2);
    for (const p of participants2) {
      expect(p.starting_cash).toBe('10000.00');
      expect(p.current_cash).toBe('10000.00');
      expect(p.status).toBe('ACTIVE');
    }
    const { rows: holdings2 } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_holdings WHERE cycle_id = $1`,
      [cycle2.cycle_id]
    );
    expect(holdings2[0].n).toBe(0);

    // Successor participants are NEW rows — identity persists, state does not.
    const { rows: p2rows } = await db.query(
      `SELECT participant_id, joined_at FROM apocalypse_participants WHERE cycle_id = $1 AND user_id = 1`,
      [cycle2.cycle_id]
    );
    expect(p2rows).toHaveLength(1);
    expect(p2rows[0].participant_id).not.toBe(participant1);
  });

  test('server restart/replay of reconciliation never re-awards starting cash', async () => {
    const cycle = await reconcileCycle({ now: atPercent(0.5) });
    // Simulate restart recovery: reconcile repeatedly at later times.
    await reconcileCycle({ now: atPercent(10) });
    await reconcileCycle({ now: atPercent(50) });
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, bool_and(starting_cash = 10000.00) AS all_exact
       FROM apocalypse_participants WHERE cycle_id = $1 AND user_id IN (1, 2)`,
      [cycle.cycle_id]
    );
    expect(rows[0].n).toBe(2);
    expect(rows[0].all_exact).toBe(true);
  });
});
