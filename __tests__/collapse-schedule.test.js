// Core 3: permanent coin collapse — deterministic schedule math and the
// database-backed lifecycle (schedule-once, due execution, idempotent replay,
// missed-checkpoint catch-up, restart reconstruction, cycle-boundary restore).
//
// All mutating tests run against the guarded disposable coins_test database
// (jest.setup.js reseeds before each test; the guard refuses any non-test
// target). Tests are free to inspect their test database directly; nothing
// here touches production.

const path = require('path');
const { spawnSync } = require('child_process');
const db = require('../db/connection');
const { reconcileCycle, getGameState } = require('../game/gameCycleService');
const {
  COLLAPSE_WINDOW_START_PERCENT,
  computeScheduleTimes,
  createSeededRandom,
  deterministicShuffle,
  buildSchedule,
  getScheduleForCycle,
  getCollapsedCoinIds,
  isCoinCollapsed
} = require('../game/collapseScheduleService');

const CYCLE_START = new Date('2026-08-20T10:00:00.000Z');
const CYCLE_END = new Date('2026-08-20T10:30:00.000Z');
const DURATION_MS = 30 * 60 * 1000;
const WINDOW_START_MS = CYCLE_START.getTime() + DURATION_MS * (COLLAPSE_WINDOW_START_PERCENT / 100);
// 10 seeded canonical coins (migration 013) -> rank spacing inside the collapse window.
const SEEDED_COIN_COUNT = 10;
const SPACING_MS = (CYCLE_END.getTime() - WINDOW_START_MS) / (SEEDED_COIN_COUNT - 1);

async function coinCount() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM coins');
  return rows[0].n;
}

describe('Core 3: pure schedule mathematics', () => {
  test('the collapse window start is fixed at 70% (not configurable)', () => {
    expect(COLLAPSE_WINDOW_START_PERCENT).toBe(70);
    expect(process.env.COLLAPSE_WINDOW_START_PERCENT).toBeUndefined();
  });

  test('N > 1: rank 0 exactly at the 70% window start, rank N-1 exactly at cycle end, evenly spaced', () => {
    const times = computeScheduleTimes({ startTime: CYCLE_START, endTime: CYCLE_END, coinCount: SEEDED_COIN_COUNT });

    expect(times).toHaveLength(SEEDED_COIN_COUNT);
    expect(times[0].getTime()).toBe(WINDOW_START_MS);
    expect(times[SEEDED_COIN_COUNT - 1].getTime()).toBe(CYCLE_END.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i].getTime() - times[i - 1].getTime()).toBe(SPACING_MS);
    }
  });

  test('N === 2: collapses land exactly on the window start and the cycle end', () => {
    const times = computeScheduleTimes({ startTime: CYCLE_START, endTime: CYCLE_END, coinCount: 2 });
    expect(times.map((t) => t.getTime())).toEqual([WINDOW_START_MS, CYCLE_END.getTime()]);
  });

  test('N === 1: the sole collapse is exactly at cycle end', () => {
    const times = computeScheduleTimes({ startTime: CYCLE_START, endTime: CYCLE_END, coinCount: 1 });
    expect(times).toHaveLength(1);
    expect(times[0].getTime()).toBe(CYCLE_END.getTime());
  });

  test('N === 0 produces no collapses', () => {
    expect(computeScheduleTimes({ startTime: CYCLE_START, endTime: CYCLE_END, coinCount: 0 })).toEqual([]);
  });

  test('no scheduled collapse exists before 70% of the cycle', () => {
    const times = computeScheduleTimes({ startTime: CYCLE_START, endTime: CYCLE_END, coinCount: 50 });
    for (const t of times) {
      expect(t.getTime()).toBeGreaterThanOrEqual(WINDOW_START_MS);
      expect(t.getTime()).toBeLessThanOrEqual(CYCLE_END.getTime());
    }
  });

  test('rejects inverted windows and non-integer coin counts', () => {
    expect(() => computeScheduleTimes({ startTime: CYCLE_END, endTime: CYCLE_START, coinCount: 2 })).toThrow();
    expect(() => computeScheduleTimes({ startTime: CYCLE_START, endTime: CYCLE_END, coinCount: 2.5 })).toThrow();
    expect(() => computeScheduleTimes({ startTime: CYCLE_START, endTime: CYCLE_END, coinCount: -1 })).toThrow();
  });

  test('same seed + same coin set produces the identical order and times', () => {
    const coins = Array.from({ length: SEEDED_COIN_COUNT }, (_, i) => ({ coin_id: i + 1, baseline_price: 10 + i }));
    const first = buildSchedule({ seed: 'fixed-seed', coins, startTime: CYCLE_START, endTime: CYCLE_END });
    const second = buildSchedule({ seed: 'fixed-seed', coins, startTime: CYCLE_START, endTime: CYCLE_END });
    expect(second).toEqual(first);
    // Input order is irrelevant: the seed decides the collapse order.
    const reversed = buildSchedule({ seed: 'fixed-seed', coins: coins.slice().reverse(), startTime: CYCLE_START, endTime: CYCLE_END });
    expect(reversed).toEqual(first);
    // Ranks are a dense 0..N-1 permutation and times match the pure math.
    expect(first.map((r) => r.collapse_rank)).toEqual(Array.from({ length: SEEDED_COIN_COUNT }, (_, i) => i));
    const times = computeScheduleTimes({ startTime: CYCLE_START, endTime: CYCLE_END, coinCount: SEEDED_COIN_COUNT });
    expect(first.map((r) => r.scheduled_at.getTime())).toEqual(times.map((t) => t.getTime()));
  });

  test('injected randomness fully controls the shuffle (deterministic, no Math.random)', () => {
    const coins = [1, 2, 3, 4].map((id) => ({ coin_id: id, baseline_price: id * 10 }));
    // Fisher-Yates with j always 0 rotates the canonical order left by one.
    const alwaysZero = () => 0;
    const scheduled = buildSchedule({ seed: 'ignored', coins, startTime: CYCLE_START, endTime: CYCLE_END, random: alwaysZero });
    expect(scheduled.map((r) => r.coin_id)).toEqual([2, 3, 4, 1]);
    // The random source is actually consumed (one call per shuffle step).
    let calls = 0;
    const counting = () => { calls += 1; return 0.5; };
    buildSchedule({ seed: 'ignored', coins, startTime: CYCLE_START, endTime: CYCLE_END, random: counting });
    expect(calls).toBe(coins.length - 1);
  });

  test('createSeededRandom is deterministic across instances and never Math.random', () => {
    const a = createSeededRandom('seed-xyz');
    const b = createSeededRandom('seed-xyz');
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const randomSpy = jest.spyOn(Math, 'random');
    createSeededRandom('seed-xyz')();
    expect(randomSpy).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  test('deterministicShuffle never mutates its input', () => {
    const input = [1, 2, 3, 4, 5];
    const out = deterministicShuffle(input, createSeededRandom('s'));
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect(out.slice().sort()).toEqual(input);
  });
});

describe('Core 3: persisted schedule lifecycle', () => {
  test('schedule generation occurs once, transactionally, from the persisted seed and eligible coins', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

    const client = await db.getClient();
    const schedule = await getScheduleForCycle(client, cycle.cycle_id);
    client.release();

    const n = await coinCount();
    expect(schedule).toHaveLength(n);
    expect(new Set(schedule.map((r) => r.coin_id)).size).toBe(n);
    expect(schedule.map((r) => r.collapse_rank)).toEqual(Array.from({ length: n }, (_, i) => i));

    // Exact schedule maths against the persisted cycle window.
    expect(new Date(schedule[0].scheduled_at).getTime()).toBe(WINDOW_START_MS);
    expect(new Date(schedule[n - 1].scheduled_at).getTime()).toBe(CYCLE_END.getTime());
    for (let i = 1; i < n; i++) {
      expect(new Date(schedule[i].scheduled_at).getTime() - new Date(schedule[i - 1].scheduled_at).getTime())
        .toBe(SPACING_MS);
    }

    // Baseline snapshot equals the live price at schedule creation.
    const { rows: coins } = await db.query('SELECT coin_id, current_price FROM coins');
    const priceById = new Map(coins.map((c) => [c.coin_id, c.current_price]));
    for (const row of schedule) {
      expect(row.baseline_price).toBe(priceById.get(row.coin_id));
      expect(row.executed_at).toBeNull();
    }

    // The persisted order matches the pure seeded derivation from the cycle seed.
    const derived = buildSchedule({
      seed: cycle.seed,
      coins: coins.map((c) => ({ coin_id: c.coin_id, baseline_price: c.current_price })),
      startTime: cycle.start_time,
      endTime: cycle.end_time
    });
    expect(schedule.map((r) => r.coin_id)).toEqual(derived.map((r) => r.coin_id));
  });

  test('reconciliation reuses the persisted schedule; it never rerolls after restart', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    const { rows: before } = await db.query(
      'SELECT schedule_id, coin_id, collapse_rank, scheduled_at FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY collapse_rank',
      [cycle.cycle_id]
    );

    // Several more lifecycle invocations at later times (still before the window).
    await reconcileCycle({ now: new Date('2026-08-20T10:10:00.000Z') });
    await getGameState({ now: new Date('2026-08-20T10:15:00.000Z') });

    const { rows: after } = await db.query(
      'SELECT schedule_id, coin_id, collapse_rank, scheduled_at FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY collapse_rank',
      [cycle.cycle_id]
    );
    expect(after.map((r) => ({ ...r, scheduled_at: new Date(r.scheduled_at).getTime() })))
      .toEqual(before.map((r) => ({ ...r, scheduled_at: new Date(r.scheduled_at).getTime() })));
  });

  test('no coin collapses before the 70% window / first stored timestamp', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

    // One millisecond before the first scheduled collapse.
    await reconcileCycle({ now: new Date(WINDOW_START_MS - 1) });

    const { rows: executed } = await db.query(
      'SELECT count(*)::int AS n FROM coin_collapse_schedule WHERE cycle_id = $1 AND executed_at IS NOT NULL',
      [cycle.cycle_id]
    );
    expect(executed[0].n).toBe(0);
    const { rows: zeros } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price = 0');
    expect(zeros[0].n).toBe(0);
  });

  test('a due checkpoint collapses exactly the scheduled coin to exactly £0 and appends the £0 history transition', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    const { rows } = await db.query(
      'SELECT * FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
      [cycle.cycle_id]
    );
    const first = rows[0];

    // Pre-existing history must survive the collapse.
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, 123.45, '2026-08-20T10:05:00.000Z')`,
      [first.coin_id]
    );

    await reconcileCycle({ now: new Date(WINDOW_START_MS) });

    const { rows: coinRows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [first.coin_id]);
    expect(parseFloat(coinRows[0].current_price)).toBe(0);

    const { rows: updated } = await db.query(
      'SELECT executed_at FROM coin_collapse_schedule WHERE schedule_id = $1',
      [first.schedule_id]
    );
    expect(new Date(updated[0].executed_at).getTime()).toBe(WINDOW_START_MS);

    const { rows: history } = await db.query(
      'SELECT price, created_at FROM price_history WHERE coin_id = $1 ORDER BY created_at',
      [first.coin_id]
    );
    expect(parseFloat(history[0].price)).toBe(123.45); // earlier history preserved
    const zeroRows = history.filter((h) => parseFloat(h.price) === 0);
    expect(zeroRows).toHaveLength(1); // exactly one actual £0 transition
    expect(new Date(zeroRows[0].created_at).getTime()).toBe(WINDOW_START_MS);

    // Exactly one coin collapsed; every other coin is untouched.
    const { rows: zeroCoins } = await db.query('SELECT coin_id FROM coins WHERE current_price = 0');
    expect(zeroCoins.map((r) => r.coin_id)).toEqual([first.coin_id]);
  });

  test('a delayed reconcile catches one missed checkpoint and several missed checkpoints', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

    // Miss rank 0 entirely; wake one checkpoint later.
    await reconcileCycle({ now: new Date(WINDOW_START_MS + SPACING_MS) });
    let { rows: executed } = await db.query(
      'SELECT count(*)::int AS n FROM coin_collapse_schedule WHERE cycle_id = $1 AND executed_at IS NOT NULL',
      [cycle.cycle_id]
    );
    expect(executed[0].n).toBe(2);

    // Sleep through the rest and wake at 95%: every rank due by then executes.
    // 95% of the cycle = 10:28:30 -> ranks 0..7 due with the 10-coin 60s
    // spacing (rank 8 at 10:29:00, rank 9 at cycle end).
    await reconcileCycle({ now: new Date('2026-08-20T10:28:30.000Z') });
    ({ rows: executed } = await db.query(
      'SELECT collapse_rank FROM coin_collapse_schedule WHERE cycle_id = $1 AND executed_at IS NOT NULL ORDER BY collapse_rank',
      [cycle.cycle_id]
    ));
    expect(executed.map((r) => r.collapse_rank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const { rows: zeroCoins } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price = 0');
    expect(zeroCoins[0].n).toBe(8);
  });

  test('repeated reconciliation is idempotent: no duplicate £0 history or state changes', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    await reconcileCycle({ now: new Date(WINDOW_START_MS + SPACING_MS) });

    const snapshot = async () => {
      const schedule = await db.query(
        'SELECT schedule_id, executed_at FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY schedule_id',
        [cycle.cycle_id]
      );
      const history = await db.query('SELECT count(*)::int AS n FROM price_history WHERE price = 0');
      const coins = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
      return { schedule: schedule.rows, zeroHistory: history.rows[0].n, coins: coins.rows };
    };

    const first = await snapshot();
    await reconcileCycle({ now: new Date(WINDOW_START_MS + SPACING_MS) });
    await reconcileCycle({ now: new Date(WINDOW_START_MS + SPACING_MS) });
    const second = await snapshot();

    expect(second.zeroHistory).toBe(first.zeroHistory);
    expect(second.coins).toEqual(first.coins);
    expect(second.schedule.map((r) => ({ id: r.schedule_id, ex: r.executed_at && new Date(r.executed_at).getTime() })))
      .toEqual(first.schedule.map((r) => ({ id: r.schedule_id, ex: r.executed_at && new Date(r.executed_at).getTime() })));
  });

  test('a restarted separate process reconstructs state: schedule and executed collapses survive, catch-up works', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    await reconcileCycle({ now: new Date(WINDOW_START_MS) }); // one collapse executed

    const projectRoot = path.resolve(__dirname, '..');
    const script = `
      const { reconcileCycle } = require(${JSON.stringify(path.join(projectRoot, 'game', 'gameCycleService'))});
      const db = require(${JSON.stringify(path.join(projectRoot, 'db', 'connection'))});
      (async () => {
        const cycle = await reconcileCycle({ now: new Date(${WINDOW_START_MS + 2 * SPACING_MS}) });
        const sched = await db.query('SELECT count(*)::int AS total, count(executed_at)::int AS executed FROM coin_collapse_schedule WHERE cycle_id = $1', [cycle.cycle_id]);
        console.log(JSON.stringify({ cycle_id: cycle.cycle_id, ...sched.rows[0] }));
        await db.end();
      })().catch((err) => { console.error(err.message); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
      cwd: projectRoot
    });

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').filter((l) => l.startsWith('{'));
    const observed = JSON.parse(lines[lines.length - 1]);
    expect(observed.cycle_id).toBe(cycle.cycle_id); // same persisted cycle
    expect(observed.total).toBe(SEEDED_COIN_COUNT); // schedule survived intact
    expect(observed.executed).toBe(3); // the restarted process caught up the missed checkpoints
  });

  test('a collapsed coin cannot be selected or duplicated again within a cycle', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    const { rows } = await db.query(
      'SELECT * FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
      [cycle.cycle_id]
    );
    const first = rows[0];

    // Duplicate (cycle, coin) is rejected by the database.
    await expect(
      db.query(
        `INSERT INTO coin_collapse_schedule (cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price)
         VALUES ($1, $2, 99, now(), 1)`,
        [cycle.cycle_id, first.coin_id]
      )
    ).rejects.toMatchObject({ code: '23505' });

    // Duplicate (cycle, rank) is rejected by the database — use a fresh coin
    // so only the rank constraint can fire.
    const { rows: extraCoin } = await db.query(
      `INSERT INTO coins (name, symbol, current_price, market_cap, circulating_supply, founder, cycle_baseline_price)
       VALUES ('ExtraCoin', 'EXTRA', 5, 5000, 1000, 'tester', 5) RETURNING coin_id`
    );
    await expect(
      db.query(
        `INSERT INTO coin_collapse_schedule (cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price)
         VALUES ($1, $2, 0, now(), 5)`,
        [cycle.cycle_id, extraCoin[0].coin_id]
      )
    ).rejects.toMatchObject({ code: '23505' });

    // Executing past the due time twice never re-selects the collapsed coin.
    await reconcileCycle({ now: new Date(WINDOW_START_MS) });
    const { rows: executed } = await db.query(
      'SELECT count(*)::int AS n FROM coin_collapse_schedule WHERE cycle_id = $1 AND coin_id = $2 AND executed_at IS NOT NULL',
      [cycle.cycle_id, first.coin_id]
    );
    expect(executed[0].n).toBe(1); // exactly one row, executed once
  });

  test('the database rejects an execution timestamp before its scheduled time', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    await expect(
      db.query(
        `UPDATE coin_collapse_schedule SET executed_at = scheduled_at - interval '1 second'
         WHERE cycle_id = $1 AND collapse_rank = 0`,
        [cycle.cycle_id]
      )
    ).rejects.toMatchObject({ code: '23514' }); // CHECK violation
  });

  test('read helpers reflect only the ACTIVE cycle execution state', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    expect((await getCollapsedCoinIds()).size).toBe(0);

    await reconcileCycle({ now: new Date(WINDOW_START_MS) });
    const { rows } = await db.query(
      'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
      [cycle.cycle_id]
    );
    const collapsed = await getCollapsedCoinIds();
    expect(collapsed.size).toBe(1);
    expect(collapsed.has(rows[0].coin_id)).toBe(true);
    expect(await isCoinCollapsed(rows[0].coin_id)).toBe(true);
    expect(await isCoinCollapsed(rows[0].coin_id + 100)).toBe(false);
  });
});

describe('Core 3: cycle boundary and baseline restoration', () => {
  test('new cycle restores the explicit persisted baseline; the final coin is exactly £0 at cycle end; old markers do not corrupt the new cycle', async () => {
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

    // Disturb live prices mid-cycle so restoration is observable.
    await db.query('UPDATE coins SET current_price = current_price * 2');

    // Go fully offline across the end boundary; wake in the next cycle.
    const successor = await reconcileCycle({ now: new Date('2026-08-20T10:31:00.000Z') });
    expect(successor.cycle_id).not.toBe(cycle.cycle_id);
    expect(new Date(successor.start_time).getTime()).toBe(CYCLE_END.getTime());

    // The expiring cycle was reconciled THROUGH ITS END before completion:
    // every scheduled collapse executed exactly once, the final one exactly
    // at the cycle end.
    const { rows: oldRows } = await db.query(
      'SELECT collapse_rank, scheduled_at, executed_at FROM coin_collapse_schedule WHERE cycle_id = $1 ORDER BY collapse_rank',
      [cycle.cycle_id]
    );
    expect(oldRows).toHaveLength(SEEDED_COIN_COUNT);
    for (const row of oldRows) {
      expect(row.executed_at).not.toBeNull();
      expect(new Date(row.executed_at).getTime()).toBe(CYCLE_END.getTime());
    }

    // Every coin got exactly one £0 history transition, timestamped at the end.
    const { rows: zeroHistory } = await db.query(
      `SELECT coin_id, count(*)::int AS n, max(created_at) AS latest
       FROM price_history WHERE price = 0 GROUP BY coin_id`
    );
    expect(zeroHistory).toHaveLength(SEEDED_COIN_COUNT);
    for (const row of zeroHistory) {
      expect(row.n).toBe(1);
      expect(new Date(row.latest).getTime()).toBe(CYCLE_END.getTime());
    }

    // The new cycle restored every live price from the explicit persisted
    // baseline — not stale memory, not the previous cycle's zero.
    const { rows: coins } = await db.query('SELECT current_price, cycle_baseline_price FROM coins');
    for (const coin of coins) {
      expect(parseFloat(coin.current_price)).toBeGreaterThan(0);
      expect(parseFloat(coin.current_price)).toBe(parseFloat(coin.cycle_baseline_price));
    }

    // The new cycle has its own fresh, unexecuted schedule. The previous
    // cycle's executed markers do not make any new-cycle coin logically dead.
    const { rows: newRows } = await db.query(
      'SELECT count(*)::int AS n, count(executed_at)::int AS executed FROM coin_collapse_schedule WHERE cycle_id = $1',
      [successor.cycle_id]
    );
    expect(newRows[0].n).toBe(SEEDED_COIN_COUNT);
    expect(newRows[0].executed).toBe(0);
    expect((await getCollapsedCoinIds()).size).toBe(0);
  });

  test('multi-cycle downtime recovery reconciles every intermediate cycle and lands on a clean active cycle', async () => {
    await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

    // 90 minutes later: three full cycles elapsed.
    const state = await getGameState({ now: new Date('2026-08-20T11:37:00.000Z') });
    expect(state.apocalypseId).toBe('APOC-0004');

    const { rows: cycles } = await db.query('SELECT cycle_id, status FROM apocalypse_cycles ORDER BY cycle_id');
    expect(cycles).toHaveLength(4);
    expect(cycles.slice(0, 3).every((c) => c.status === 'COMPLETED')).toBe(true);

    // Every completed cycle had its full schedule executed through its end.
    for (const cycle of cycles.slice(0, 3)) {
      const { rows } = await db.query(
        'SELECT count(*)::int AS n, count(executed_at)::int AS executed FROM coin_collapse_schedule WHERE cycle_id = $1',
        [cycle.cycle_id]
      );
      expect(rows[0].n).toBe(SEEDED_COIN_COUNT);
      expect(rows[0].executed).toBe(SEEDED_COIN_COUNT);
    }

    // Active cycle 4: fresh schedule, baseline-restored prices, nothing dead.
    const { rows: active } = await db.query(
      'SELECT count(*)::int AS n, count(executed_at)::int AS executed FROM coin_collapse_schedule WHERE cycle_id = $1',
      [cycles[3].cycle_id]
    );
    expect(active[0].n).toBe(SEEDED_COIN_COUNT);
    expect(active[0].executed).toBe(0);
    const { rows: zeros } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price = 0');
    expect(zeros[0].n).toBe(0);
  });

  test('a pre-existing Core 1 active cycle without a schedule gets one without resetting live prices', async () => {
    // Simulate the pre-Core-3 deployment state: an ACTIVE cycle exists but no
    // schedule was ever generated for it.
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'legacy-seed', '2026-08-20T10:00:00.000Z', '2026-08-20T10:30:00.000Z', 1800000, 'ACTIVE')`
    );
    await db.query('UPDATE coins SET current_price = current_price * 3');
    const { rows: before } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');

    await reconcileCycle({ now: new Date('2026-08-20T10:10:00.000Z') });

    const { rows: schedule } = await db.query(
      `SELECT cs.coin_id, cs.baseline_price FROM coin_collapse_schedule cs
       JOIN apocalypse_cycles ac ON ac.cycle_id = cs.cycle_id WHERE ac.apocalypse_id = 'APOC-0001'`
    );
    expect(schedule).toHaveLength(SEEDED_COIN_COUNT);

    // Mid-cycle recovery must not reset live prices; the schedule's baseline
    // snapshot is the live price at creation time.
    const { rows: after } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id');
    expect(after).toEqual(before);
    const priceById = new Map(before.map((c) => [c.coin_id, c.current_price]));
    for (const row of schedule) {
      expect(row.baseline_price).toBe(priceById.get(row.coin_id));
    }
  });
});
