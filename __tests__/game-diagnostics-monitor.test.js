// Apocalypse Monitor Phase 2: read-only per-cycle price-history monitor.
//
// GET /api/game/diagnostics/monitor — restricted (GAME_DIAGNOSTICS_TOKEN),
// read-only (BEGIN READ ONLY) view of the raw price_history series for one
// apocalypse cycle:
//   * exact rows are attributed by price_history.cycle_id ONLY (never by
//     timestamp matching);
//   * legacy rows (cycle_id IS NULL) are attributed by the half-open window
//     [start_time, end_time) and honestly marked derived;
//   * MARKET_TICK and COLLAPSE provenance is exposed per point; the future
//     collapse schedule and future-dated rows are never exposed;
//   * retired coins are hidden by default unless they genuinely have
//     selected-cycle exact rows or legacy rows in the selected window;
//   * optional ?coinId= positive-integer filter (400 invalid, 404 unknown);
//   * no seed, no internal cycle_id, no writes, no reconciliation.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');

jest.setTimeout(45000);

const T0 = new Date('2026-02-02T00:00:00.000Z'); // aligned 30-min boundary
const MIN = 60 * 1000;
const at = (minutes) => new Date(T0.getTime() + minutes * MIN);

const DIAG_TOKEN = 'test-diagnostics-token';
const authHeader = () => ({ Authorization: `Bearer ${DIAG_TOKEN}` });

beforeEach(() => {
  process.env.GAME_DIAGNOSTICS_TOKEN = DIAG_TOKEN;
});

afterEach(() => {
  delete process.env.GAME_DIAGNOSTICS_TOKEN;
});

// Insert a cycle directly (bypasses lifecycle) and return its internal id.
async function insertCycle({ apocalypseId, start, end, status = 'COMPLETED', settlementStartedAt = null, settledAt = null }) {
  const { rows } = await db.query(
    `INSERT INTO apocalypse_cycles
       (apocalypse_id, seed, start_time, end_time, duration_ms, status, settlement_started_at, settled_at)
     VALUES ($1, 'monitor-test-seed', $2, $3, $4, $5, $6, $7)
     RETURNING cycle_id`,
    [apocalypseId, start.toISOString(), end.toISOString(), end.getTime() - start.getTime(), status, settlementStartedAt, settledAt]
  );
  return rows[0].cycle_id;
}

// Insert one raw price_history row exactly as the writers would (or as a
// legacy pre-019 row when cycleId/source are null).
async function insertPriceRow({ coinId, cycleId = null, price, createdAt, source = null }) {
  await db.query(
    `INSERT INTO price_history (coin_id, cycle_id, price, created_at, source)
     VALUES ($1, $2, $3, $4, $5)`,
    [coinId, cycleId, price, createdAt.toISOString(), source]
  );
}

async function retireCoin(coinId) {
  await db.query('UPDATE coins SET retired = TRUE WHERE coin_id = $1', [coinId]);
}

// Whole-table content fingerprints for the read-only guarantee.
const FINGERPRINT_TABLES = [
  'apocalypse_cycles',
  'apocalypse_participants',
  'apocalypse_transactions',
  'apocalypse_cash_events',
  'apocalypse_bot_ticks',
  'apocalypse_economy_events',
  'coin_collapse_schedule',
  'price_history',
  'coins',
  'users'
];

async function fingerprintDatabase() {
  const fingerprint = {};
  for (const table of FINGERPRINT_TABLES) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n,
              md5(coalesce(string_agg(j, '' ORDER BY j), '')) AS h
       FROM (SELECT row_to_json(x)::text AS j FROM ${table} x) s`
    );
    fingerprint[table] = rows[0];
  }
  return fingerprint;
}

describe('Apocalypse Monitor Phase 2: GET /api/game/diagnostics/monitor', () => {
  describe('access control', () => {
    test('rejects missing, wrong and player-JWT tokens with 401', async () => {
      const url = '/api/game/diagnostics/monitor';
      expect((await request(app).get(url)).status).toBe(401);
      expect((await request(app).get(url)
        .set('Authorization', 'Bearer wrong-token')).status).toBe(401);
      expect((await request(app).get(url)
        .set('Authorization', 'Bearer')).status).toBe(401);
      const jwt = require('jsonwebtoken');
      const playerToken = jwt.sign({ user_id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
      expect((await request(app).get(url)
        .set('Authorization', `Bearer ${playerToken}`)).status).toBe(401);
    });

    test('fails closed with 404 when GAME_DIAGNOSTICS_TOKEN is unset', async () => {
      delete process.env.GAME_DIAGNOSTICS_TOKEN;
      const res = await request(app).get('/api/game/diagnostics/monitor');
      expect(res.status).toBe(404);
    });

    test('successful responses are never cacheable', async () => {
      await reconcileCycle({ now: T0 });
      const res = await request(app)
        .get('/api/game/diagnostics/monitor')
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('cycle selection and validation', () => {
    test('omitted cycleId selects the currently persisted cycle without reconciliation', async () => {
      const cycle = await reconcileCycle({ now: T0 });
      await insertPriceRow({ coinId: 1, cycleId: cycle.cycle_id, price: 10.5, createdAt: at(1), source: 'MARKET_TICK' });

      const res = await request(app)
        .get('/api/game/diagnostics/monitor')
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.cycle.cycleId).toBe(cycle.apocalypse_id);
      expect(res.body.data.cycle.status).toBe('ACTIVE');
      // Still exactly as persisted: an expired-looking ACTIVE cycle is never
      // rolled over by a diagnostic read.
    });

    test('omitted cycleId reports an expired persisted ACTIVE cycle as-is (no rollover)', async () => {
      const cycle = await reconcileCycle({ now: T0 });
      // Make the persisted cycle observably expired; reconciliation would
      // roll it over. The monitor must report it exactly as persisted.
      await db.query(
        'UPDATE apocalypse_cycles SET start_time = $1, end_time = $2 WHERE cycle_id = $3',
        [at(-120), at(-90), cycle.cycle_id]
      );
      const res = await request(app)
        .get('/api/game/diagnostics/monitor')
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.cycle.cycleId).toBe(cycle.apocalypse_id);
      expect(res.body.data.cycle.status).toBe('ACTIVE');
    });

    test('explicit completed cycle echoes settlement observability fields', async () => {
      const cycleId = await insertCycle({
        apocalypseId: 'APOC-9001',
        start: at(-120), end: at(-90),
        status: 'COMPLETED',
        settlementStartedAt: at(-90),
        settledAt: at(-85)
      });
      await insertPriceRow({ coinId: 1, cycleId, price: 7.25, createdAt: at(-100), source: 'MARKET_TICK' });

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001')
        .set(authHeader());
      expect(res.status).toBe(200);
      const c = res.body.data.cycle;
      expect(c.cycleId).toBe('APOC-9001');
      expect(c.status).toBe('COMPLETED');
      expect(c.startTime).toBe(at(-120).toISOString());
      expect(c.endTime).toBe(at(-90).toISOString());
      expect(c.settlementStartedAt).toBe(at(-90).toISOString());
      expect(c.settledAt).toBe(at(-85).toISOString());
      expect(new Date(c.observedAt).toISOString()).toBe(c.observedAt);
    });

    test('unknown cycle is 404 and malformed cycleId is 400', async () => {
      const unknown = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9999')
        .set(authHeader());
      expect(unknown.status).toBe(404);
      expect(unknown.body.status).toBe('error');

      for (const bad of ['banana', 'apoc-0001', 'APOC-1', 'APOC-00001x']) {
        const res = await request(app)
          .get(`/api/game/diagnostics/monitor?cycleId=${encodeURIComponent(bad)}`)
          .set(authHeader());
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('error');
      }
    });

    test('404 when no cycle exists at all', async () => {
      const res = await request(app)
        .get('/api/game/diagnostics/monitor')
        .set(authHeader());
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('error');
    });
  });

  describe('exact attribution', () => {
    test('returns MARKET_TICK and COLLAPSE points attributed by cycle_id', async () => {
      const cycle = await reconcileCycle({ now: T0 });
      await insertPriceRow({ coinId: 1, cycleId: cycle.cycle_id, price: 10.5, createdAt: at(1), source: 'MARKET_TICK' });
      await insertPriceRow({ coinId: 1, cycleId: cycle.cycle_id, price: 11.0, createdAt: at(2), source: 'MARKET_TICK' });
      await insertPriceRow({ coinId: 2, cycleId: cycle.cycle_id, price: 0, createdAt: at(3), source: 'COLLAPSE' });

      const res = await request(app)
        .get(`/api/game/diagnostics/monitor?cycleId=${cycle.apocalypse_id}`)
        .set(authHeader());
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.attribution).toBe('exact');
      expect(data.exact).toBe(true);
      expect(data.warnings).toEqual([]);

      const coin1 = data.coins.find((c) => c.coinId === 1);
      expect(coin1.name).toBe('FutureCoin');
      expect(coin1.symbol).toBe('FTR');
      expect(coin1.history.attribution).toBe('exact');
      expect(coin1.history.sampleCount).toBe(2);
      expect(coin1.history.firstObservedAt).toBe(at(1).toISOString());
      expect(coin1.history.lastObservedAt).toBe(at(2).toISOString());
      expect(coin1.history.points).toEqual([
        { time: at(1).toISOString(), price: 10.5, source: 'MARKET_TICK' },
        { time: at(2).toISOString(), price: 11.0, source: 'MARKET_TICK' }
      ]);

      const coin2 = data.coins.find((c) => c.coinId === 2);
      expect(coin2.history.sampleCount).toBe(1);
      expect(coin2.history.points[0]).toEqual({
        time: at(3).toISOString(), price: 0, source: 'COLLAPSE'
      });
    });

    test('exact rows are matched by cycle_id only — never by timestamp', async () => {
      // Two adjacent cycles: A = [T0, T0+30), B = [T0+30, T0+60).
      const cycleAId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      const cycleBId = await insertCycle({ apocalypseId: 'APOC-9002', start: at(30), end: at(60) });

      // Cycle B's exact row timestamped INSIDE A's window: a timestamp-based
      // matcher would wrongly attribute it to A.
      await insertPriceRow({ coinId: 1, cycleId: cycleBId, price: 99.0, createdAt: at(10), source: 'MARKET_TICK' });
      await insertPriceRow({ coinId: 1, cycleId: cycleAId, price: 5.0, createdAt: at(5), source: 'MARKET_TICK' });

      const forA = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=1')
        .set(authHeader());
      expect(forA.status).toBe(200);
      const coin1A = forA.body.data.coins.find((c) => c.coinId === 1);
      expect(coin1A.history.sampleCount).toBe(1);
      expect(coin1A.history.points[0].price).toBe(5.0);
      expect(forA.body.data.attribution).toBe('exact');

      const forB = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9002&coinId=1')
        .set(authHeader());
      const coin1B = forB.body.data.coins.find((c) => c.coinId === 1);
      expect(coin1B.history.sampleCount).toBe(1);
      expect(coin1B.history.points[0].price).toBe(99.0);
    });

    test('rows tagged to other cycles never leak into the selected cycle', async () => {
      const cycleAId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      const cycleBId = await insertCycle({ apocalypseId: 'APOC-9002', start: at(30), end: at(60) });
      await insertPriceRow({ coinId: 1, cycleId: cycleAId, price: 5.0, createdAt: at(5), source: 'MARKET_TICK' });
      await insertPriceRow({ coinId: 1, cycleId: cycleBId, price: 6.0, createdAt: at(35), source: 'MARKET_TICK' });

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=1')
        .set(authHeader());
      const prices = res.body.data.coins.find((c) => c.coinId === 1).history.points.map((p) => p.price);
      expect(prices).toEqual([5.0]);
    });
  });

  describe('legacy fallback (time-window derived)', () => {
    test('legacy NULL rows in the half-open window are derived; boundaries honoured', async () => {
      await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      // Legacy rows as written pre-019: no cycle_id, no source.
      await insertPriceRow({ coinId: 1, price: 4.0, createdAt: at(-1) });   // before window: excluded
      await insertPriceRow({ coinId: 1, price: 5.0, createdAt: at(0) });    // start boundary: included
      await insertPriceRow({ coinId: 1, price: 5.5, createdAt: at(15) });   // inside: included
      await insertPriceRow({ coinId: 1, price: 6.0, createdAt: at(30) });   // end boundary: excluded (half-open)

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=1')
        .set(authHeader());
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.attribution).toBe('time_window_derived');
      expect(data.exact).toBe(false);

      const coin1 = data.coins.find((c) => c.coinId === 1);
      expect(coin1.history.attribution).toBe('time_window_derived');
      expect(coin1.history.sampleCount).toBe(2);
      expect(coin1.history.firstObservedAt).toBe(at(0).toISOString());
      expect(coin1.history.lastObservedAt).toBe(at(15).toISOString());
      expect(coin1.history.points).toEqual([
        { time: at(0).toISOString(), price: 5.0, source: null },
        { time: at(15).toISOString(), price: 5.5, source: null }
      ]);
      // The derived attribution is disclosed, not silent.
      expect(data.warnings.join(' ')).toMatch(/derived|legacy|time window/i);
    });

    test('mixed attribution is reported honestly per dataset and per coin', async () => {
      const cycleId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      await insertPriceRow({ coinId: 1, cycleId, price: 10.0, createdAt: at(5), source: 'MARKET_TICK' });
      await insertPriceRow({ coinId: 2, price: 2.0, createdAt: at(10) }); // legacy in window

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001')
        .set(authHeader());
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.attribution).toBe('mixed');
      expect(data.exact).toBe(false);

      const coin1 = data.coins.find((c) => c.coinId === 1);
      const coin2 = data.coins.find((c) => c.coinId === 2);
      expect(coin1.history.attribution).toBe('exact');
      expect(coin1.history.points[0].source).toBe('MARKET_TICK');
      expect(coin2.history.attribution).toBe('time_window_derived');
      expect(coin2.history.points[0].source).toBeNull();
      expect(data.warnings.length).toBeGreaterThan(0);
    });

    test('legacy rows outside the window are never attributed to the cycle', async () => {
      await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      await insertPriceRow({ coinId: 1, price: 4.0, createdAt: at(-60) });
      await insertPriceRow({ coinId: 1, price: 6.0, createdAt: at(90) });

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=1')
        .set(authHeader());
      const coin1 = res.body.data.coins.find((c) => c.coinId === 1);
      expect(coin1.history.sampleCount).toBe(0);
      expect(coin1.history.points).toEqual([]);
      expect(coin1.history.firstObservedAt).toBeNull();
      expect(coin1.history.lastObservedAt).toBeNull();
      // Nothing returned at all: vacuously exact, nothing derived.
      expect(res.body.data.attribution).toBe('exact');
      expect(res.body.data.exact).toBe(true);
    });
  });

  describe('coinId filter', () => {
    test('restricts the response to the requested coin', async () => {
      const cycleId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      await insertPriceRow({ coinId: 1, cycleId, price: 10.0, createdAt: at(5), source: 'MARKET_TICK' });
      await insertPriceRow({ coinId: 2, cycleId, price: 2.0, createdAt: at(6), source: 'MARKET_TICK' });

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=2')
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.coins).toHaveLength(1);
      expect(res.body.data.coins[0].coinId).toBe(2);
      expect(res.body.data.coins[0].symbol).toBe('NVC');
      expect(res.body.data.coins[0].history.sampleCount).toBe(1);
    });

    test('rejects invalid coinId values with 400 and unknown coins with 404', async () => {
      await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      for (const bad of ['0', '-3', 'abc', '1.5', '99999999999999999999', '1e3']) {
        const res = await request(app)
          .get(`/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=${encodeURIComponent(bad)}`)
          .set(authHeader());
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('error');
      }
      const unknown = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=9999')
        .set(authHeader());
      expect(unknown.status).toBe(404);
      expect(unknown.body.status).toBe('error');
    });
  });

  describe('retired coins', () => {
    test('retired coins are hidden by default unless they genuinely have selected-cycle history', async () => {
      const cycleId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      await retireCoin(3);
      await retireCoin(4);
      await retireCoin(5);
      await retireCoin(6);
      // Coin 3: exact selected-cycle history -> included despite retired.
      await insertPriceRow({ coinId: 3, cycleId, price: 1.0, createdAt: at(5), source: 'MARKET_TICK' });
      // Coin 4: no rows at all -> excluded.
      // Coin 5: legacy row inside the window -> included (derived).
      await insertPriceRow({ coinId: 5, price: 2.0, createdAt: at(10) });
      // Coin 6: legacy row outside the window -> excluded.
      await insertPriceRow({ coinId: 6, price: 3.0, createdAt: at(90) });

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001')
        .set(authHeader());
      expect(res.status).toBe(200);
      const ids = res.body.data.coins.map((c) => c.coinId).sort((a, b) => a - b);
      expect(ids).toEqual([1, 2, 3, 5, 7, 8, 9, 10]);

      const coin3 = res.body.data.coins.find((c) => c.coinId === 3);
      expect(coin3.history.attribution).toBe('exact');
      const coin5 = res.body.data.coins.find((c) => c.coinId === 5);
      expect(coin5.history.attribution).toBe('time_window_derived');
    });

    test('an explicitly requested retired coin is returned', async () => {
      const cycleId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      await retireCoin(3);
      await insertPriceRow({ coinId: 3, cycleId, price: 1.0, createdAt: at(5), source: 'MARKET_TICK' });

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=3')
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.coins).toHaveLength(1);
      expect(res.body.data.coins[0].coinId).toBe(3);
    });

    test('non-retired coins appear even with no history in the cycle', async () => {
      await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001')
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.coins).toHaveLength(10);
      for (const coin of res.body.data.coins) {
        expect(coin.history.sampleCount).toBe(0);
        expect(coin.history.points).toEqual([]);
        expect(coin.history.firstObservedAt).toBeNull();
        expect(coin.history.lastObservedAt).toBeNull();
      }
    });
  });

  describe('collapse information hiding', () => {
    test('only executed COLLAPSE rows are exposed; the unexecuted schedule is never leaked', async () => {
      const cycleId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      // Executed collapse: the £0 transition row stamped by the schedule writer.
      await insertPriceRow({ coinId: 2, cycleId, price: 0, createdAt: at(20), source: 'COLLAPSE' });
      // An UNEXECUTED future schedule row with a distinctive timestamp: the
      // monitor must never read or expose it.
      const futureScheduleAt = at(25).toISOString();
      await db.query(
        `INSERT INTO coin_collapse_schedule (cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price)
         VALUES ($1, 7, 0, $2, 5.00)`,
        [cycleId, futureScheduleAt]
      );

      const res = await request(app)
        .get(`/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=2`)
        .set(authHeader());
      expect(res.status).toBe(200);
      const coin2 = res.body.data.coins.find((c) => c.coinId === 2);
      expect(coin2.history.points).toEqual([
        { time: at(20).toISOString(), price: 0, source: 'COLLAPSE' }
      ]);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('scheduled_at');
      expect(raw).not.toContain(futureScheduleAt);
    });

    test('future-dated rows are never exposed', async () => {
      // Manually inserted ACTIVE cycle with a window I fully control:
      // [now-15min, now+15min). A legacy row timestamped between now and
      // end_time is future-dated and must be withheld.
      const nowMs = Date.now();
      const cycleDbId = await insertCycle({
        apocalypseId: 'APOC-9001',
        start: new Date(nowMs - 15 * MIN),
        end: new Date(nowMs + 15 * MIN),
        status: 'ACTIVE'
      });
      const pastInsideWindow = new Date(nowMs - 5 * MIN);
      const futureInsideWindow = new Date(nowMs + 10 * MIN);

      await insertPriceRow({ coinId: 1, price: 5.0, createdAt: pastInsideWindow }); // legacy, past: derived
      await insertPriceRow({ coinId: 1, price: 6.0, createdAt: futureInsideWindow }); // legacy, future: hidden
      await insertPriceRow({ coinId: 2, cycleId: cycleDbId, price: 7.0, createdAt: futureInsideWindow, source: 'MARKET_TICK' }); // exact, future: hidden

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001')
        .set(authHeader());
      expect(res.status).toBe(200);
      const coin1 = res.body.data.coins.find((c) => c.coinId === 1);
      expect(coin1.history.sampleCount).toBe(1);
      expect(coin1.history.points[0].price).toBe(5.0);
      const coin2 = res.body.data.coins.find((c) => c.coinId === 2);
      expect(coin2.history.sampleCount).toBe(0);
    });
  });

  describe('information hiding', () => {
    test('responses contain no seed, internal cycle_id, schedule or auth fields', async () => {
      const cycleId = await insertCycle({
        apocalypseId: 'APOC-9001', start: at(0), end: at(30),
        settlementStartedAt: at(30), settledAt: at(31)
      });
      await insertPriceRow({ coinId: 1, cycleId, price: 10.0, createdAt: at(5), source: 'MARKET_TICK' });
      await insertPriceRow({ coinId: 2, price: 2.0, createdAt: at(6) });

      const res = await request(app)
        .get('/api/game/diagnostics/monitor?cycleId=APOC-9001')
        .set(authHeader());
      expect(res.status).toBe(200);

      expect(Object.keys(res.body.data).sort()).toEqual(
        ['attribution', 'coins', 'cycle', 'exact', 'warnings'].sort()
      );
      expect(Object.keys(res.body.data.cycle).sort()).toEqual(
        ['cycleId', 'endTime', 'observedAt', 'settlementStartedAt', 'settledAt', 'startTime', 'status'].sort()
      );
      for (const coin of res.body.data.coins) {
        expect(Object.keys(coin).sort()).toEqual(['coinId', 'history', 'name', 'symbol'].sort());
        expect(Object.keys(coin.history).sort()).toEqual(
          ['attribution', 'firstObservedAt', 'lastObservedAt', 'points', 'sampleCount'].sort()
        );
        for (const point of coin.history.points) {
          expect(Object.keys(point).sort()).toEqual(['price', 'source', 'time'].sort());
        }
      }

      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/seed/i);
      expect(raw).not.toContain('cycle_id'); // internal numeric id key never leaks
      expect(raw).not.toContain('scheduled_at');
      expect(raw).not.toMatch(/password/i);
    });
  });

  describe('read-only guarantee', () => {
    test('monitor reads perform zero writes and no reconciliation', async () => {
      const cycle = await reconcileCycle({ now: T0 });
      const cycleId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(-120), end: at(-90) });
      await insertPriceRow({ coinId: 1, cycleId, price: 1.0, createdAt: at(-100), source: 'MARKET_TICK' });
      await insertPriceRow({ coinId: 2, price: 2.0, createdAt: at(-95) });

      // Make the persisted ACTIVE cycle observably expired: any
      // reconciliation would roll it over (a write).
      await db.query(
        'UPDATE apocalypse_cycles SET start_time = $1, end_time = $2 WHERE cycle_id = $3',
        [at(-60), at(-30), cycle.cycle_id]
      );

      const before = await fingerprintDatabase();

      const urls = [
        '/api/game/diagnostics/monitor',
        `/api/game/diagnostics/monitor?cycleId=${cycle.apocalypse_id}`,
        '/api/game/diagnostics/monitor?cycleId=APOC-9001',
        '/api/game/diagnostics/monitor?cycleId=APOC-9001&coinId=1',
        '/api/game/diagnostics/monitor?coinId=2'
      ];
      for (const url of urls) {
        const res = await request(app).get(url).set(authHeader());
        expect(res.status).toBe(200);
      }

      const after = await fingerprintDatabase();
      expect(after).toEqual(before);

      // The expired ACTIVE cycle is still exactly as persisted.
      const { rows } = await db.query(
        'SELECT status FROM apocalypse_cycles WHERE cycle_id = $1', [cycle.cycle_id]
      );
      expect(rows[0].status).toBe('ACTIVE');
    });
  });
});
