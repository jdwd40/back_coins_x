// Crypto Chaos Core 6: end-of-round settlement — deterministic coverage.
//
// Covers the lifecycle (ACTIVE -> SETTLING -> COMPLETED, durable SETTLING
// commit before settlement), the trade freeze, the final £0 collapse,
// participant finalization through the single Core 6 path, the deterministic
// rank rule (final_cash DESC, participant_id ASC — ties included), the
// immutable apocalypse_results snapshot (content, uniqueness, triggers),
// empty cycles, idempotent replays, crash-resume after durable SETTLING,
// successor chaining/timing, historical preservation across rounds, and
// Core 1-5 compatibility (round isolation, legacy funds untouched).

const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');
const settlementService = require('../game/gameSettlementService');
const botService = require('../game/botService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const CYCLE_MS = 10 * 60 * 1000; // custom duration: no half-hour alignment
const T0 = new Date('2026-08-21T10:00:00.000Z');
const END = new Date(T0.getTime() + CYCLE_MS);
const AFTER_END = new Date(END.getTime() + 1000);

async function startCycle() {
  return reconcileCycle({ now: T0, durationMs: CYCLE_MS });
}

async function getCycle(apocalypseId) {
  const { rows } = await db.query('SELECT * FROM apocalypse_cycles WHERE apocalypse_id = $1', [apocalypseId]);
  return rows[0];
}

async function cheapestCoin() {
  const { rows } = await db.query('SELECT coin_id, symbol, current_price FROM coins ORDER BY current_price ASC, coin_id ASC LIMIT 1');
  return rows[0];
}

async function tableCounts() {
  const out = {};
  for (const t of ['apocalypse_cycles', 'apocalypse_participants', 'apocalypse_holdings', 'apocalypse_transactions', 'apocalypse_results', 'coin_collapse_schedule']) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t}`);
    out[t] = rows[0].n;
  }
  const { rows: zeroRows } = await db.query(`SELECT count(*)::int AS n FROM price_history WHERE price = 0`);
  out.zeroPriceHistory = zeroRows[0].n;
  return out;
}

describe('Core 6: end-of-round settlement', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('freeze commits durable SETTLING before settlement and blocks any successor', async () => {
    const cycle = await startCycle();
    await gameRoundService.joinRound({ userId: 1, now: T0 });

    const frozen = await settlementService.freezeExpiredActiveCycle({ nowMs: AFTER_END.getTime() });
    expect(frozen).toBeTruthy();
    expect(frozen.cycle_id).toBe(cycle.cycle_id);

    const stored = await getCycle(cycle.apocalypse_id);
    expect(stored.status).toBe('SETTLING');
    expect(stored.settlement_started_at).not.toBeNull();
    expect(stored.settled_at).toBeNull();

    // No ACTIVE cycle and no successor exists while settlement is pending.
    const { rows: active } = await db.query(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'ACTIVE'`);
    expect(active[0].n).toBe(0);
    const { rows: all } = await db.query('SELECT count(*)::int AS n FROM apocalypse_cycles');
    expect(all[0].n).toBe(1);

    // The freeze is idempotent: nothing left to freeze.
    expect(await settlementService.freezeExpiredActiveCycle({ nowMs: AFTER_END.getTime() })).toBeNull();
  });

  test('an unexpired ACTIVE cycle is never frozen', async () => {
    await startCycle();
    expect(await settlementService.freezeExpiredActiveCycle({ nowMs: T0.getTime() + 1000 })).toBeNull();
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'SETTLING'`);
    expect(rows[0].n).toBe(0);
  });

  test('trades are rejected during SETTLING with zero mutation; join rolls forward to the successor', async () => {
    const cycle = await startCycle();
    const participant = await gameRoundService.joinRound({ userId: 1, now: T0 });
    const coin = await cheapestCoin();
    const price = parseFloat(coin.current_price);
    await gameRoundService.buyRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 5, now: T0
    });

    await settlementService.freezeExpiredActiveCycle({ nowMs: AFTER_END.getTime() });

    const before = await tableCounts();
    const cashBefore = (await db.query('SELECT current_cash FROM apocalypse_participants WHERE participant_id = $1', [participant.participantId])).rows[0].current_cash;

    // Buy and sell both reject against the SETTLING cycle.
    await expect(gameRoundService.buyRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 1, now: AFTER_END
    })).rejects.toMatchObject({ name: 'GameRoundError', status: 409 });
    await expect(gameRoundService.sellRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 1, now: AFTER_END
    })).rejects.toMatchObject({ name: 'GameRoundError', status: 409 });

    // Zero mutation from the rejected trades.
    const after = await tableCounts();
    expect(after.apocalypse_transactions).toBe(before.apocalypse_transactions);
    expect(after.apocalypse_holdings).toBe(before.apocalypse_holdings);
    const cashAfter = (await db.query('SELECT current_cash FROM apocalypse_participants WHERE participant_id = $1', [participant.participantId])).rows[0].current_cash;
    expect(cashAfter).toBe(cashBefore);

    // Joining during the freeze window resumes settlement and lands the user
    // in the SUCCESSOR cycle at the full game starting cash.
    const joined = await gameRoundService.joinRound({ userId: 2, now: AFTER_END });
    expect(joined.apocalypseId).not.toBe(cycle.apocalypse_id);
    expect(joined.startingCash).toBe(1000);
    expect(joined.currentCash).toBe(1000);

    const predecessor = await getCycle(cycle.apocalypse_id);
    expect(predecessor.status).toBe('COMPLETED');
    expect(predecessor.settled_at).not.toBeNull();
  });

  test('settlement reconciles the final collapse through exactly cycle end before any values', async () => {
    const cycle = await startCycle();
    await gameRoundService.joinRound({ userId: 1, now: T0 });

    await settlementService.freezeExpiredActiveCycle({ nowMs: AFTER_END.getTime() });
    const settled = await settlementService.settleSettlingCycle();
    expect(settled).toBeTruthy();
    expect(settled.cycle_id).toBe(cycle.cycle_id);

    // Every scheduled collapse executed, the final one exactly at cycle end.
    const { rows: schedule } = await db.query(
      'SELECT coin_id, scheduled_at, executed_at FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY collapse_rank',
      [cycle.cycle_id]
    );
    const { rows: coinCount } = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(schedule).toHaveLength(coinCount[0].n);
    for (const row of schedule) {
      expect(row.executed_at).not.toBeNull();
      expect(new Date(row.executed_at).getTime()).toBe(END.getTime());
    }
    const last = schedule[schedule.length - 1];
    expect(new Date(last.scheduled_at).getTime()).toBe(END.getTime());

    // Every coin reached exactly £0 (successor not created yet — no baseline
    // restore has run).
    const { rows: nonZero } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price <> 0');
    expect(nonZero[0].n).toBe(0);

    // The cycle is COMPLETED with observability stamps.
    const stored = await getCycle(cycle.apocalypse_id);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.settled_at).not.toBeNull();
    expect(stored.settlement_started_at).not.toBeNull();
  });

  test('results snapshot: deterministic ranks (final_cash DESC, participant_id ASC), stats, identities', async () => {
    const cycle = await startCycle();
    const p1 = await gameRoundService.joinRound({ userId: 1, now: T0 });
    const p2 = await gameRoundService.joinRound({ userId: 2, now: new Date(T0.getTime() + 60000) });
    const coin = await cheapestCoin();
    const price = parseFloat(coin.current_price);

    // User 1 spends on coins; user 2 holds cash. Final cash decides ranks.
    await gameRoundService.buyRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 5, now: T0
    });
    const spent = Math.round(5 * price * 100) / 100;

    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });

    const { rows: results } = await db.query(
      'SELECT * FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank',
      [cycle.cycle_id]
    );
    expect(results).toHaveLength(2);

    const [first, second] = results;
    // User 2 kept 1000 cash -> rank 1; user 1 spent -> rank 2.
    expect(first.user_id).toBe(2);
    expect(first.rank).toBe(1);
    expect(parseFloat(first.final_cash)).toBe(1000);
    expect(parseFloat(first.starting_cash)).toBe(1000);
    expect(parseFloat(first.net_profit)).toBe(0);
    expect(first.trade_count).toBe(0);
    expect(first.buy_count).toBe(0);
    expect(first.sell_count).toBe(0);
    expect(first.username).toBe('jane_smith');
    expect(first.is_bot).toBe(false);
    expect(first.bot_personality).toBeNull();
    expect(first.apocalypse_id).toBe(cycle.apocalypse_id);
    expect(new Date(first.joined_at).getTime()).toBe(new Date(p2.joinedAt).getTime());

    expect(second.user_id).toBe(1);
    expect(second.rank).toBe(2);
    expect(parseFloat(second.final_cash)).toBeCloseTo(1000 - spent, 2);
    expect(parseFloat(second.net_profit)).toBeCloseTo(-spent, 2);
    expect(second.trade_count).toBe(1);
    expect(second.buy_count).toBe(1);
    expect(second.sell_count).toBe(0);
    expect(second.username).toBe('john_doe');

    // Peak wealth is at least the final cash and at least the starting cash.
    expect(parseFloat(second.peak_wealth)).toBeGreaterThanOrEqual(parseFloat(second.final_cash));
    expect(parseFloat(second.peak_wealth)).toBeGreaterThanOrEqual(1000);

    // Participant rows are FINALIZED with matching final cash.
    const { rows: participants } = await db.query(
      'SELECT * FROM apocalypse_participants WHERE cycle_id = $1 ORDER BY participant_id',
      [cycle.cycle_id]
    );
    for (const p of participants) {
      expect(p.status).toBe('FINALIZED');
      expect(p.final_cash).not.toBeNull();
    }
  });

  test('tie on final cash breaks by participant_id ASC with gapless ranks', async () => {
    const cycle = await startCycle();
    const p1 = await gameRoundService.joinRound({ userId: 1, now: T0 });
    const p2 = await gameRoundService.joinRound({ userId: 2, now: T0 });
    expect(p1.participantId).toBeLessThan(p2.participantId);

    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });

    const { rows: results } = await db.query(
      'SELECT * FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank',
      [cycle.cycle_id]
    );
    expect(results).toHaveLength(2);
    expect(parseFloat(results[0].final_cash)).toBe(1000);
    expect(parseFloat(results[1].final_cash)).toBe(1000);
    expect(results[0].participant_id).toBe(p1.participantId); // lower id wins the tie
    expect(results[1].participant_id).toBe(p2.participantId);
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
  });

  test('late joiner gets exactly the game starting cash, no modifier, and is ranked', async () => {
    const cycle = await startCycle();
    // Join at 95% of the cycle.
    const late = new Date(T0.getTime() + CYCLE_MS * 0.95);
    const participant = await gameRoundService.joinRound({ userId: 1, now: late });
    expect(participant.startingCash).toBe(1000);

    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });

    const { rows } = await db.query('SELECT * FROM apocalypse_results WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].starting_cash)).toBe(1000);
    expect(parseFloat(rows[0].final_cash)).toBe(1000);
    expect(rows[0].rank).toBe(1);
    // joined_at is stamped once by the database at join and snapshotted as-is.
    expect(new Date(rows[0].joined_at).toISOString()).toBe(participant.joinedAt);
  });

  test('bots rank identically to humans and can take rank 1', async () => {
    const cycle = await startCycle();
    const roster = await botService.ensureBotsProvisioned();
    const bot = roster[0];
    await gameRoundService.joinRound({ userId: bot.userId, now: T0 });

    // The human spends cash; the untraded bot keeps the full 1000 and wins.
    await gameRoundService.joinRound({ userId: 1, now: T0 });
    const coin = await cheapestCoin();
    await gameRoundService.buyRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 10, now: T0
    });

    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });

    const { rows: results } = await db.query(
      'SELECT * FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank',
      [cycle.cycle_id]
    );
    expect(results).toHaveLength(2);
    expect(results[0].rank).toBe(1);
    expect(results[0].is_bot).toBe(true);
    expect(results[0].bot_personality).toBe(bot.strategy);
    expect(results[0].user_id).toBe(bot.userId);
    expect(parseFloat(results[0].final_cash)).toBe(1000);
    expect(results[1].is_bot).toBe(false);
  });

  test('an empty cycle completes with zero results', async () => {
    const cycle = await startCycle();
    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });

    const stored = await getCycle(cycle.apocalypse_id);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.settled_at).not.toBeNull();
    const { rows } = await db.query('SELECT count(*)::int AS n FROM apocalypse_results WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(rows[0].n).toBe(0);
  });

  test('settlement replay is a no-op: no duplicate results, cash, collapses or successors', async () => {
    const cycle = await startCycle();
    await gameRoundService.joinRound({ userId: 1, now: T0 });
    const coin = await cheapestCoin();
    await gameRoundService.buyRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 3, now: T0
    });

    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });
    const settledState = await tableCounts();
    const { rows: snapshot } = await db.query(
      'SELECT participant_id, rank, final_cash FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank',
      [cycle.cycle_id]
    );

    // Replay every phase: none of them may change anything.
    expect(await settlementService.freezeExpiredActiveCycle({ nowMs: AFTER_END.getTime() })).toBeNull();
    expect(await settlementService.settleSettlingCycle()).toBeNull();
    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });
    await reconcileCycle({ now: new Date(AFTER_END.getTime() + 60000), durationMs: CYCLE_MS });

    expect(await tableCounts()).toEqual(settledState);
    const { rows: again } = await db.query(
      'SELECT participant_id, rank, final_cash FROM apocalypse_results WHERE cycle_id = $1 ORDER BY rank',
      [cycle.cycle_id]
    );
    expect(again.map((r) => [r.participant_id, r.rank, parseFloat(r.final_cash)]))
      .toEqual(snapshot.map((r) => [r.participant_id, r.rank, parseFloat(r.final_cash)]));
  });

  test('crash after durable SETTLING: a later reconcile resumes to exactly one result set', async () => {
    const cycle = await startCycle();
    await gameRoundService.joinRound({ userId: 1, now: T0 });
    await gameRoundService.joinRound({ userId: 2, now: T0 });

    // "Crash": freeze committed, process died before settlement ran.
    await settlementService.freezeExpiredActiveCycle({ nowMs: AFTER_END.getTime() });
    const crashed = await getCycle(cycle.apocalypse_id);
    expect(crashed.status).toBe('SETTLING');
    expect(crashed.settled_at).toBeNull();

    // Restart: the retry converges to exactly one of everything.
    await reconcileCycle({ now: new Date(AFTER_END.getTime() + 3600000), durationMs: CYCLE_MS });
    await reconcileCycle({ now: new Date(AFTER_END.getTime() + 3600000), durationMs: CYCLE_MS });

    const stored = await getCycle(cycle.apocalypse_id);
    expect(stored.status).toBe('COMPLETED');
    const { rows: results } = await db.query('SELECT * FROM apocalypse_results WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.rank).sort()).toEqual([1, 2]);
    const { rows: participants } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants WHERE cycle_id = $1 AND status = 'FINALIZED'`,
      [cycle.cycle_id]
    );
    expect(participants[0].n).toBe(2);
  });

  test('bot trades fail during SETTLING and the successor tick works normally', async () => {
    const cycle = await startCycle();
    const roster = await botService.ensureBotsProvisioned();
    const bot = roster[0];
    await gameRoundService.joinRound({ userId: bot.userId, now: T0 });
    const coin = await cheapestCoin();

    await settlementService.freezeExpiredActiveCycle({ nowMs: AFTER_END.getTime() });

    // A bot trade against the SETTLING cycle is a clean domain rejection —
    // the exact shared Core 5 trade path, never a strategy bypass.
    await expect(gameRoundService.buyRoundTrade({
      userId: bot.userId, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 1, now: AFTER_END
    })).rejects.toMatchObject({ name: 'GameRoundError', status: 409 });

    // A bot tick after the freeze observes state, resumes settlement through
    // reconcile, and acts only on the successor — duplicate tick ids stay
    // idempotent.
    const tick = await botService.runBotTick({ tickId: 4242, now: AFTER_END });
    expect(tick.skipped).toBe(false);
    expect(tick.apocalypseId).not.toBe(cycle.apocalypse_id);
    const replay = await botService.runBotTick({ tickId: 4242, now: AFTER_END });
    expect(replay.skipped).toBe(true);
    expect(replay.reason).toBe('duplicate-tick');

    const predecessor = await getCycle(cycle.apocalypse_id);
    expect(predecessor.status).toBe('COMPLETED');
  });

  test('results rows are immutable: UPDATE, DELETE and TRUNCATE all raise', async () => {
    const cycle = await startCycle();
    await gameRoundService.joinRound({ userId: 1, now: T0 });
    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });

    await expect(
      db.query(`UPDATE apocalypse_results SET final_cash = 999999 WHERE cycle_id = $1`, [cycle.cycle_id])
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`DELETE FROM apocalypse_results WHERE cycle_id = $1`, [cycle.cycle_id])
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`TRUNCATE apocalypse_results`)
    ).rejects.toThrow(/immutable/);

    const { rows } = await db.query('SELECT final_cash FROM apocalypse_results WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(parseFloat(rows[0].final_cash)).toBe(1000);
  });

  test('successor chains exactly at predecessor end; multi-cycle downtime preserves full history', async () => {
    const cycle1 = await startCycle();
    await gameRoundService.joinRound({ userId: 1, now: T0 });
    const coin = await cheapestCoin();
    await gameRoundService.buyRoundTrade({
      userId: 1, apocalypseId: cycle1.apocalypse_id, coinId: coin.coin_id, quantity: 4, now: T0
    });

    // Jump 2.5 cycles into the future: two full cycles elapse.
    const later = new Date(T0.getTime() + CYCLE_MS * 2.5);
    const liveCycle = await reconcileCycle({ now: later, durationMs: CYCLE_MS });

    const { rows: cycles } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(3);
    expect(cycles[0].status).toBe('COMPLETED');
    expect(cycles[1].status).toBe('COMPLETED');
    expect(cycles[2].status).toBe('ACTIVE');
    expect(cycles[2].apocalypse_id).toBe(liveCycle.apocalypse_id);

    // Chained: each successor starts exactly at its predecessor's end, and
    // every COMPLETED cycle carries its durable settlement stamps.
    for (let i = 1; i < cycles.length; i++) {
      expect(new Date(cycles[i].start_time).getTime()).toBe(new Date(cycles[i - 1].end_time).getTime());
    }
    for (let i = 0; i < cycles.length - 1; i++) {
      expect(cycles[i].settled_at).not.toBeNull();
      expect(cycles[i].settlement_started_at).not.toBeNull();
    }
    expect(cycles[2].settled_at).toBeNull();

    // History: cycle 1's results/participants survive later rounds untouched.
    const { rows: results } = await db.query('SELECT * FROM apocalypse_results WHERE cycle_id = $1', [cycles[0].cycle_id]);
    expect(results).toHaveLength(1);
    expect(results[0].user_id).toBe(1);
    const { rows: emptyResults } = await db.query('SELECT count(*)::int AS n FROM apocalypse_results WHERE cycle_id = $1', [cycles[1].cycle_id]);
    expect(emptyResults[0].n).toBe(0);

    // The collapse schedules of completed cycles are preserved (no reroll,
    // no deletion).
    const { rows: schedules } = await db.query(
      'SELECT cycle_id, count(*)::int AS n FROM coin_collapse_schedule GROUP BY cycle_id ORDER BY cycle_id'
    );
    expect(schedules).toHaveLength(3);
    const { rows: coinCount } = await db.query('SELECT count(*)::int AS n FROM coins');
    for (const s of schedules) expect(s.n).toBe(coinCount[0].n);
  });

  test('Core 4 isolation holds through settlement: legacy funds, portfolios and transactions untouched', async () => {
    const cycle = await startCycle();
    await gameRoundService.joinRound({ userId: 1, now: T0 });
    const coin = await cheapestCoin();
    await gameRoundService.buyRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: coin.coin_id, quantity: 2, now: T0
    });

    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });

    const { rows: user } = await db.query('SELECT funds FROM users WHERE user_id = 1');
    expect(parseFloat(user[0].funds)).toBe(1000);
    const { rows: legacy } = await db.query(
      'SELECT (SELECT count(*)::int FROM portfolios) AS pf, (SELECT count(*)::int FROM transactions) AS tx'
    );
    expect(legacy[0].pf).toBe(0);
    expect(legacy[0].tx).toBe(0);
  });

  test('settlement never rerolls the schedule or rewrites history timestamps', async () => {
    const cycle = await startCycle();
    const { rows: before } = await db.query(
      'SELECT coin_id, collapse_rank, scheduled_at, baseline_price FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY collapse_rank',
      [cycle.cycle_id]
    );

    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });
    await reconcileCycle({ now: new Date(AFTER_END.getTime() + 1000), durationMs: CYCLE_MS });

    const { rows: after } = await db.query(
      'SELECT coin_id, collapse_rank, scheduled_at, baseline_price FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY collapse_rank',
      [cycle.cycle_id]
    );
    expect(after.map((r) => [r.coin_id, r.collapse_rank, new Date(r.scheduled_at).getTime(), parseFloat(r.baseline_price)]))
      .toEqual(before.map((r) => [r.coin_id, r.collapse_rank, new Date(r.scheduled_at).getTime(), parseFloat(r.baseline_price)]));

    // Exactly one £0 history transition per coin from the final collapse.
    const { rows: zeroRows } = await db.query(
      'SELECT coin_id, count(*)::int AS n FROM price_history WHERE price = 0 GROUP BY coin_id'
    );
    for (const row of zeroRows) expect(row.n).toBe(1);
  });

  test('a stuck SETTLING cycle is observable and blocks successors until settlement succeeds', async () => {
    const cycle = await startCycle();
    await gameRoundService.joinRound({ userId: 1, now: T0 });
    await settlementService.freezeExpiredActiveCycle({ nowMs: AFTER_END.getTime() });

    // Simulate a settlement that keeps failing: break nothing, but prove the
    // observable state while SETTLING persists and no successor appears.
    const { rows: settling } = await db.query(
      `SELECT cycle_id, settlement_started_at, settled_at FROM apocalypse_cycles WHERE status = 'SETTLING'`
    );
    expect(settling).toHaveLength(1);
    expect(settling[0].settlement_started_at).not.toBeNull();
    expect(settling[0].settled_at).toBeNull();

    // The database enforces at most one SETTLING cycle.
    await expect(
      db.query(
        `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
         VALUES ('APOC-9999', 'x', now(), now() + interval '10 minutes', 600000, 'SETTLING')`
      )
    ).rejects.toThrow(/duplicate key/);

    // Recovery converges normally afterwards.
    await reconcileCycle({ now: AFTER_END, durationMs: CYCLE_MS });
    const stored = await getCycle(cycle.apocalypse_id);
    expect(stored.status).toBe('COMPLETED');
    const { rows: actives } = await db.query(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'ACTIVE'`);
    expect(actives[0].n).toBe(1);
  });
});
