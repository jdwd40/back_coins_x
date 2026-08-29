// Apocalypse Monitor Phase 2.5: recent cycle discovery for the monitor.
//
// GET /api/game/diagnostics/monitor/cycles — restricted
// (GAME_DIAGNOSTICS_TOKEN), read-only (BEGIN READ ONLY) newest-first list of
// persisted cycles (ACTIVE / SETTLING / COMPLETED) so an operator can pick a
// cycleId for /api/game/diagnostics/monitor:
//   * GET only; optional ?limit= strict integer 1..100 (default 20; 400 on
//     invalid or excessive values — never silently coerced or capped);
//   * each entry exposes ONLY the public fields cycleId/status/startTime/
//     endTime/settledAt plus hasExactHistory;
//   * hasExactHistory is true iff at least one price_history row carries the
//     cycle's exact provenance (price_history.cycle_id); legacy-only
//     (cycle_id IS NULL) rows NEVER count — computed with one EXISTS query,
//     no N+1;
//   * no seed, no internal cycle_id, no schedule/rank/bot info, no writes,
//     no reconciliation/settlement/rollover, no locks.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');

jest.setTimeout(45000);

const T0 = new Date('2026-02-02T00:00:00.000Z'); // aligned 30-min boundary
const MIN = 60 * 1000;
const at = (minutes) => new Date(T0.getTime() + minutes * MIN);

const DIAG_TOKEN = 'test-diagnostics-token';
const URL = '/api/game/diagnostics/monitor/cycles';
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
     VALUES ($1, 'monitor-cycles-test-seed', $2, $3, $4, $5, $6, $7)
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

describe('Apocalypse Monitor Phase 2.5: GET /api/game/diagnostics/monitor/cycles', () => {
  describe('access control', () => {
    test('rejects missing, wrong and player-JWT tokens with 401', async () => {
      expect((await request(app).get(URL)).status).toBe(401);
      expect((await request(app).get(URL)
        .set('Authorization', 'Bearer wrong-token')).status).toBe(401);
      expect((await request(app).get(URL)
        .set('Authorization', 'Bearer')).status).toBe(401);
      const jwt = require('jsonwebtoken');
      const playerToken = jwt.sign({ user_id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
      expect((await request(app).get(URL)
        .set('Authorization', `Bearer ${playerToken}`)).status).toBe(401);
    });

    test('fails closed with 404 when GAME_DIAGNOSTICS_TOKEN is unset', async () => {
      delete process.env.GAME_DIAGNOSTICS_TOKEN;
      const res = await request(app).get(URL);
      expect(res.status).toBe(404);
    });

    test('successful responses are never cacheable', async () => {
      const res = await request(app).get(URL).set(authHeader());
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    test('supports GET only — other methods are 404', async () => {
      for (const method of ['post', 'put', 'patch', 'delete']) {
        const res = await request(app)[method](URL).set(authHeader());
        expect(res.status).toBe(404);
      }
    });
  });

  describe('listing, ordering and statuses', () => {
    test('returns an empty list when no cycle exists', async () => {
      const res = await request(app).get(URL).set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.cycles).toEqual([]);
      expect(res.body.data.returned).toBe(0);
      expect(res.body.data.limit).toBe(20);
    });

    test('lists ACTIVE, SETTLING and COMPLETED cycles newest-first', async () => {
      await insertCycle({ apocalypseId: 'APOC-9001', start: at(-120), end: at(-90), status: 'COMPLETED', settledAt: at(-85) });
      await insertCycle({ apocalypseId: 'APOC-9002', start: at(-90), end: at(-60), status: 'COMPLETED', settlementStartedAt: at(-60), settledAt: at(-55) });
      await insertCycle({ apocalypseId: 'APOC-9003', start: at(-60), end: at(-30), status: 'SETTLING', settlementStartedAt: at(-30) });
      await insertCycle({ apocalypseId: 'APOC-9004', start: at(-30), end: at(0), status: 'ACTIVE' });

      const res = await request(app).get(URL).set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.returned).toBe(4);
      expect(res.body.data.cycles.map((c) => c.cycleId)).toEqual([
        'APOC-9004', 'APOC-9003', 'APOC-9002', 'APOC-9001'
      ]);
      expect(res.body.data.cycles.map((c) => c.status)).toEqual([
        'ACTIVE', 'SETTLING', 'COMPLETED', 'COMPLETED'
      ]);

      const settling = res.body.data.cycles[1];
      expect(settling.startTime).toBe(at(-60).toISOString());
      expect(settling.endTime).toBe(at(-30).toISOString());
      expect(settling.settledAt).toBeNull();
      const completed = res.body.data.cycles[2];
      expect(completed.settledAt).toBe(at(-55).toISOString());
    });
  });

  describe('limit validation', () => {
    test('defaults to the 20 most recent cycles', async () => {
      for (let i = 1; i <= 25; i += 1) {
        await insertCycle({
          apocalypseId: `APOC-${9000 + i}`,
          start: at(i * 60), end: at(i * 60 + 30)
        });
      }
      const res = await request(app).get(URL).set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.limit).toBe(20);
      expect(res.body.data.returned).toBe(20);
      expect(res.body.data.cycles).toHaveLength(20);
      // Newest first: APOC-9025 .. APOC-9006.
      expect(res.body.data.cycles[0].cycleId).toBe('APOC-9025');
      expect(res.body.data.cycles[19].cycleId).toBe('APOC-9006');
    });

    test('honours a custom limit, including the 100 boundary', async () => {
      for (let i = 1; i <= 5; i += 1) {
        await insertCycle({ apocalypseId: `APOC-${9000 + i}`, start: at(i * 60), end: at(i * 60 + 30) });
      }
      const two = await request(app).get(`${URL}?limit=2`).set(authHeader());
      expect(two.status).toBe(200);
      expect(two.body.data.limit).toBe(2);
      expect(two.body.data.cycles.map((c) => c.cycleId)).toEqual(['APOC-9005', 'APOC-9004']);

      const one = await request(app).get(`${URL}?limit=1`).set(authHeader());
      expect(one.status).toBe(200);
      expect(one.body.data.cycles.map((c) => c.cycleId)).toEqual(['APOC-9005']);

      const max = await request(app).get(`${URL}?limit=100`).set(authHeader());
      expect(max.status).toBe(200);
      expect(max.body.data.limit).toBe(100);
      expect(max.body.data.returned).toBe(5);
    });

    test('rejects invalid limits with 400', async () => {
      for (const bad of ['abc', '0', '-5', '1.5', '1e2', '20x']) {
        const res = await request(app)
          .get(`${URL}?limit=${encodeURIComponent(bad)}`)
          .set(authHeader());
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('error');
      }
    });

    test('rejects excessive limits with 400 (never silently capped)', async () => {
      for (const bad of ['101', '1000', '99999999999999999999']) {
        const res = await request(app)
          .get(`${URL}?limit=${bad}`)
          .set(authHeader());
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('error');
      }
    });
  });

  describe('hasExactHistory', () => {
    test('true only for cycles with exact price_history provenance; legacy-only is false', async () => {
      // A: exact rows (migration 019 provenance).
      const cycleAId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      await insertPriceRow({ coinId: 1, cycleId: cycleAId, price: 10.0, createdAt: at(5), source: 'MARKET_TICK' });
      // B: legacy rows only (cycle_id IS NULL) inside its window — never exact.
      await insertCycle({ apocalypseId: 'APOC-9002', start: at(30), end: at(60) });
      await insertPriceRow({ coinId: 1, price: 11.0, createdAt: at(35) });
      // C: no rows at all.
      await insertCycle({ apocalypseId: 'APOC-9003', start: at(60), end: at(90) });

      const res = await request(app).get(URL).set(authHeader());
      expect(res.status).toBe(200);
      const byId = new Map(res.body.data.cycles.map((c) => [c.cycleId, c]));
      expect(byId.get('APOC-9001').hasExactHistory).toBe(true);
      expect(byId.get('APOC-9002').hasExactHistory).toBe(false);
      expect(byId.get('APOC-9003').hasExactHistory).toBe(false);
    });

    test('rows tagged to OTHER cycles do not count', async () => {
      const cycleAId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(0), end: at(30) });
      await insertCycle({ apocalypseId: 'APOC-9002', start: at(30), end: at(60) });
      await insertPriceRow({ coinId: 1, cycleId: cycleAId, price: 10.0, createdAt: at(5), source: 'MARKET_TICK' });

      const res = await request(app).get(URL).set(authHeader());
      const byId = new Map(res.body.data.cycles.map((c) => [c.cycleId, c]));
      expect(byId.get('APOC-9001').hasExactHistory).toBe(true);
      expect(byId.get('APOC-9002').hasExactHistory).toBe(false);
    });
  });

  describe('information hiding', () => {
    test('entries contain only the public fields — no seed, internal ids, schedule, rank or bot info', async () => {
      const cycleId = await insertCycle({
        apocalypseId: 'APOC-9001', start: at(0), end: at(30),
        settlementStartedAt: at(30), settledAt: at(31)
      });
      await insertPriceRow({ coinId: 1, cycleId, price: 10.0, createdAt: at(5), source: 'MARKET_TICK' });
      // Unexecuted future schedule + bot roster rows with distinctive values
      // that must never surface in the discovery payload.
      await db.query(
        `INSERT INTO coin_collapse_schedule (cycle_id, coin_id, collapse_rank, scheduled_at, baseline_price)
         VALUES ($1, 7, 0, $2, 5.00)`,
        [cycleId, at(25).toISOString()]
      );

      const res = await request(app).get(URL).set(authHeader());
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(['cycles', 'limit', 'returned'].sort());
      for (const cycle of res.body.data.cycles) {
        expect(Object.keys(cycle).sort()).toEqual(
          ['cycleId', 'endTime', 'hasExactHistory', 'settledAt', 'startTime', 'status'].sort()
        );
      }
      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/seed/i);
      expect(raw).not.toContain('cycle_id');
      expect(raw).not.toContain('scheduled_at');
      expect(raw).not.toContain('collapse_rank');
      expect(raw).not.toContain(at(25).toISOString());
      expect(raw).not.toMatch(/bot/i);
    });
  });

  describe('read-only guarantee', () => {
    test('discovery reads perform zero writes and no reconciliation/settlement/rollover', async () => {
      const cycle = await reconcileCycle({ now: T0 });
      const oldId = await insertCycle({ apocalypseId: 'APOC-9001', start: at(-120), end: at(-90) });
      await insertPriceRow({ coinId: 1, cycleId: oldId, price: 1.0, createdAt: at(-100), source: 'MARKET_TICK' });

      // Make the persisted ACTIVE cycle observably expired: any
      // reconciliation would roll it over (a write).
      await db.query(
        'UPDATE apocalypse_cycles SET start_time = $1, end_time = $2 WHERE cycle_id = $3',
        [at(-60), at(-30), cycle.cycle_id]
      );

      const before = await fingerprintDatabase();

      const urls = [URL, `${URL}?limit=1`, `${URL}?limit=100`];
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
