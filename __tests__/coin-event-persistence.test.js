// SIM-04: coin event persistence/recovery against the disposable test
// database (guard-enforced; jest.setup.js reseeds before each test).
//
// Covered:
//   * ensureCoinEventCoverage extends each coin's persisted stream only up
//     to `now`, inside the Core 1 advisory-locked transaction shape;
//   * rolling persistence is byte-identical to the pure whole-window
//     schedule truncated at the same horizon (restart-equivalent; no
//     Math.random anywhere);
//   * repeated calls are pure no-ops (idempotent, never rerolled);
//   * expiry handling: expired events are excluded from active reads but
//     retained — never deleted, never resurrected;
//   * the 0-5 active cap holds over the persisted rows;
//   * no cross-cycle leakage;
//   * long-window safety: a 7-day cycle mints only the events due so far,
//     not weeks of future events;
//   * the full Core 1 reconcileCycle path creates/recovers event state.

const db = require('../db/connection');
const {
  buildCycleCoinEvents,
  getActiveEvents,
  getCycleCoinEvents,
  ensureCoinEventCoverage,
  getActiveCoinEvents
} = require('../game/coinEventEngine');
const { reconcileCycle } = require('../game/gameCycleService');
const { DEFAULT_SIMULATION_CONFIG } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const LOCK_KEY = 727001; // the Core 1 game-lifecycle advisory lock

const START = new Date('2026-08-20T10:00:00.000Z');
const END = new Date('2026-08-20T10:30:00.000Z');
const SEED = 'sim04-persistence-seed';

async function withLifecycleTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertCycle({ apocalypseId, seed, status = 'ACTIVE', start = START, end = END }) {
  const { rows } = await db.query(
    `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [apocalypseId, seed, start.toISOString(), end.toISOString(), end.getTime() - start.getTime(), status]
  );
  return rows[0];
}

// Canonical comparison shape: DB rows carry numerics as strings and extra
// bookkeeping columns; compare the gameplay fields exactly.
function canonical(rows) {
  return rows.map((r) => ({
    coin_id: r.coin_id,
    event_seq: r.event_seq,
    name: r.name,
    direction: r.direction,
    strength_category: r.strength_category,
    modifier: parseFloat(r.modifier),
    starts_at_ms: new Date(r.starts_at).getTime(),
    ends_at_ms: new Date(r.ends_at).getTime()
  }));
}

function canonicalPure(rows) {
  return rows.map((r) => ({
    coin_id: r.coin_id,
    event_seq: r.event_seq,
    name: r.name,
    direction: r.direction,
    strength_category: r.strength_category,
    modifier: r.modifier,
    starts_at_ms: r.starts_at.getTime(),
    ends_at_ms: r.ends_at.getTime()
  }));
}

// The pure whole-window schedule for the seeded catalogue, truncated at the
// coverage horizon: exactly what rolling persistence must have written.
async function pureCovered(seed, horizonMs) {
  const coinIds = (await db.query('SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id')).rows.map((r) => r.coin_id);
  return canonicalPure(
    buildCycleCoinEvents({ seed, coinIds, startTime: START, endTime: END })
      .filter((e) => e.starts_at.getTime() <= horizonMs)
  );
}

// Rolling persistence appends per coin: for every coin, the earlier rows
// must be an exact, untouched prefix of the later rows (streams are ordered
// by event_seq within a coin; new events never rewrite history).
function expectPerCoinPrefix(earlier, later) {
  const byCoin = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.coin_id)) map.set(r.coin_id, []);
      map.get(r.coin_id).push(r);
    }
    return map;
  };
  const early = byCoin(earlier);
  const late = byCoin(later);
  expect(late.size).toBeGreaterThanOrEqual(early.size);
  for (const [coinId, earlyRows] of early) {
    const lateRows = late.get(coinId);
    expect(lateRows).toBeDefined();
    expect(lateRows.length).toBeGreaterThanOrEqual(earlyRows.length);
    expect(lateRows.slice(0, earlyRows.length)).toEqual(earlyRows);
  }
}

describe('SIM-04: coin event persistence and recovery', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('coverage persists exactly the events due at `now`, identical to the pure schedule prefix', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date('2026-08-20T10:10:00.000Z');
    const created = await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, now));
    expect(created).toBeGreaterThan(0);

    const persisted = await getCycleCoinEvents(db, cycle.cycle_id);
    expect(canonical(persisted)).toEqual(await pureCovered(SEED, now.getTime()));

    // Every persisted event starts at or before the horizon; every active
    // catalogue coin has its own seeded stream.
    for (const r of persisted) {
      expect(new Date(r.starts_at).getTime()).toBeLessThanOrEqual(now.getTime());
    }
    const coinIds = (await db.query('SELECT coin_id FROM coins WHERE retired = FALSE')).rows.map((r) => r.coin_id);
    expect(new Set(persisted.map((r) => r.coin_id))).toEqual(new Set(coinIds));
  });

  test('repeated coverage at the same instant is a pure no-op: same rows, same identities, no reroll', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date('2026-08-20T10:10:00.000Z');
    await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, now));
    const first = await getCycleCoinEvents(db, cycle.cycle_id);
    const createdAgain = await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, now));
    expect(createdAgain).toBe(0);
    const second = await getCycleCoinEvents(db, cycle.cycle_id);
    expect(second).toEqual(first); // same durable identities — nothing reinserted
  });

  test('advancing time extends the streams deterministically without touching earlier rows', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const early = new Date('2026-08-20T10:08:00.000Z');
    const late = new Date('2026-08-20T10:22:00.000Z');
    await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, early));
    const earlyRows = await getCycleCoinEvents(db, cycle.cycle_id);

    const createdMore = await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, late));
    const lateRows = await getCycleCoinEvents(db, cycle.cycle_id);

    // Earlier rows are an exact, untouched per-coin prefix of the later stream.
    expect(lateRows.length).toBeGreaterThanOrEqual(earlyRows.length);
    expectPerCoinPrefix(earlyRows, lateRows);
    // The extended state equals the pure schedule truncated at the horizon.
    expect(canonical(lateRows)).toEqual(await pureCovered(SEED, late.getTime()));
    if (createdMore === 0) {
      // Possible only if no event starts inside (early, late] for any coin.
      expect(lateRows.length).toBe(earlyRows.length);
    }
  });

  test('expiry is time-based only: expired events are retained but never active again', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const mid = new Date('2026-08-20T10:15:00.000Z');
    await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, mid));

    const persisted = await getCycleCoinEvents(db, cycle.cycle_id);
    const active = await getActiveCoinEvents(db, cycle.cycle_id, mid);
    const pureActiveIds = getActiveEvents(persisted, mid).map((r) => r.event_id).sort((a, b) => a - b);
    expect(active.map((r) => r.event_id).sort((a, b) => a - b)).toEqual(pureActiveIds);

    // Expired rows are still persisted (never deleted) and never return.
    const expired = persisted.filter((r) => new Date(r.ends_at).getTime() <= mid.getTime());
    expect(expired.length).toBeGreaterThan(0);
    for (const ev of expired) {
      const at = await getActiveCoinEvents(db, cycle.cycle_id, new Date(new Date(ev.ends_at).getTime() + 1000));
      expect(at.find((r) => r.event_id === ev.event_id)).toBeUndefined();
    }

    // A later reconcile must not resurrect them or rewrite anything.
    await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, new Date('2026-08-20T10:25:00.000Z')));
    const after = await getCycleCoinEvents(db, cycle.cycle_id);
    expectPerCoinPrefix(persisted, after);
  });

  test('the configured 0-5 active cap holds over the persisted rows at every sampled instant', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = END; // cover the whole 30-minute window
    await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, now));
    const cap = DEFAULT_SIMULATION_CONFIG.coinEvents.maxActivePerCoin;
    const all = await getCycleCoinEvents(db, cycle.cycle_id);
    // Full-window coverage equals the pure whole-window schedule.
    expect(canonical(all)).toEqual(await pureCovered(SEED, END.getTime()));
    const byCoin = new Map();
    for (const r of all) {
      if (!byCoin.has(r.coin_id)) byCoin.set(r.coin_id, []);
      byCoin.get(r.coin_id).push(r);
    }
    for (const [, events] of byCoin) {
      for (let t = START.getTime(); t < END.getTime(); t += 15000) {
        expect(getActiveEvents(events, new Date(t)).length).toBeLessThanOrEqual(cap);
      }
    }
  });

  test('coverage never extends past the cycle end', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    await withLifecycleTransaction(
      (client) => ensureCoinEventCoverage(client, cycle, new Date(END.getTime() + 60 * 60000))
    );
    const all = await getCycleCoinEvents(db, cycle.cycle_id);
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      expect(new Date(r.starts_at).getTime()).toBeLessThan(END.getTime());
    }
    // And it equals the complete pure schedule for the window.
    expect(canonical(all)).toEqual(await pureCovered(SEED, END.getTime()));
  });

  test('long-window safety: a 7-day cycle mints only the events due so far', async () => {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const cycle = await insertCycle({
      apocalypseId: 'APOC-0001',
      seed: SEED,
      start: START,
      end: new Date(START.getTime() + weekMs)
    });
    const now = new Date(START.getTime() + 60000); // one minute into the cycle
    const t0 = Date.now();
    const created = await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, now));
    const elapsed = Date.now() - t0;
    // A week's events would be tens of thousands of rows; one minute's worth
    // is a handful per coin, and the call must be fast (well under a second).
    expect(created).toBeLessThan(100);
    expect(elapsed).toBeLessThan(1000);
    const all = await getCycleCoinEvents(db, cycle.cycle_id);
    for (const r of all) {
      expect(new Date(r.starts_at).getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  test('no cross-cycle leakage: each cycle has its own seeded event set', async () => {
    const cycleA = await insertCycle({ apocalypseId: 'APOC-0001', seed: 'cycle-a-seed' });
    await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycleA, new Date('2026-08-20T10:10:00.000Z')));
    // A completed successor window with a different seed.
    const cycleB = await insertCycle({
      apocalypseId: 'APOC-0002',
      seed: 'cycle-b-seed',
      status: 'COMPLETED',
      start: END,
      end: new Date(END.getTime() + 30 * 60000)
    });
    await withLifecycleTransaction(
      (client) => ensureCoinEventCoverage(client, cycleB, new Date(END.getTime() + 10 * 60000))
    );

    const eventsA = await getCycleCoinEvents(db, cycleA.cycle_id);
    const eventsB = await getCycleCoinEvents(db, cycleB.cycle_id);
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    expect(new Set(eventsA.map((r) => r.cycle_id))).toEqual(new Set([cycleA.cycle_id]));
    expect(new Set(eventsB.map((r) => r.cycle_id))).toEqual(new Set([cycleB.cycle_id]));
    // Different seeds -> different event identities; nothing shared.
    const idsA = new Set(eventsA.map((r) => r.event_id));
    expect(eventsB.some((r) => idsA.has(r.event_id))).toBe(false);
    // Active reads are cycle-scoped: cycle B's events never appear in A's reads.
    const activeA = await getActiveCoinEvents(db, cycleA.cycle_id, new Date('2026-08-20T10:05:00.000Z'));
    expect(activeA.every((r) => r.cycle_id === cycleA.cycle_id)).toBe(true);
  });

  test('restart-equivalent state: a fresh transaction re-derives nothing and observes the same rows', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date('2026-08-20T10:12:00.000Z');
    await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, now));
    const first = await getCycleCoinEvents(db, cycle.cycle_id);
    // Simulate a process restart: brand-new transaction, cycle re-read from
    // the DB, coverage re-ensured at the same instant.
    const created = await withLifecycleTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM apocalypse_cycles WHERE cycle_id = $1', [cycle.cycle_id]);
      return ensureCoinEventCoverage(client, rows[0], now);
    });
    expect(created).toBe(0);
    const recovered = await getCycleCoinEvents(db, cycle.cycle_id);
    expect(recovered).toEqual(first);
    // And the observed rows still equal the pure schedule prefix.
    expect(canonical(recovered)).toEqual(await pureCovered(SEED, now.getTime()));
  });

  test('the Core 1 reconcile path persists event state for the live cycle and never rerolls it', async () => {
    const now = new Date('2026-08-20T10:05:00.000Z');
    const generateSeed = () => SEED;
    const cycle = await reconcileCycle({ now, generateSeed });
    expect(cycle.status).toBe('ACTIVE');

    const afterFirst = await getCycleCoinEvents(db, cycle.cycle_id);
    expect(afterFirst.length).toBeGreaterThan(0);
    for (const r of afterFirst) {
      expect(new Date(r.starts_at).getTime()).toBeLessThanOrEqual(now.getTime());
    }

    // Reconcile again later in the same live window: existing rows
    // unchanged, stream extended only up to the new now.
    const laterNow = new Date('2026-08-20T10:20:00.000Z');
    const later = await reconcileCycle({ now: laterNow, generateSeed });
    expect(later.cycle_id).toBe(cycle.cycle_id);
    const afterSecond = await getCycleCoinEvents(db, cycle.cycle_id);
    expectPerCoinPrefix(afterFirst, afterSecond);
    expect(canonical(afterSecond)).toEqual(await pureCovered(SEED, laterNow.getTime()));
  });

  test('event state is separate from portfolio, trade, price-history and cash-event data', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    await withLifecycleTransaction((client) => ensureCoinEventCoverage(client, cycle, END));
    // Event persistence must not touch any of the existing game tables.
    for (const t of ['portfolios', 'transactions', 'price_history', 'apocalypse_cash_events', 'apocalypse_transactions', 'apocalypse_holdings']) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t}`);
      expect(rows[0].n).toBe(0);
    }
  });
});
