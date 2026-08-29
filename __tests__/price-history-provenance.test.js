// Apocalypse Monitor persistence foundation: writer provenance coverage.
//
// The normal market writer (models/market-simulator.js:updateAllPrices) must
// stamp every price_history row with the already-reconciled authoritative
// cycle id and source='MARKET_TICK'. The collapse writer
// (game/collapseScheduleService.js:executeDueCollapses) must stamp its £0
// transition rows with the caller's authoritative cycle id and
// source='COLLAPSE'. Legacy rows with NULL cycle_id/source stay valid and
// remain readable through the unchanged public price-history API contract.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const gameCycleService = require('../game/gameCycleService');
const collapseScheduleService = require('../game/collapseScheduleService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

describe('price_history provenance: normal market tick writer', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('every normal tick row carries the reconciled cycle id and source MARKET_TICK', async () => {
    const cycle = await gameCycleService.reconcileCycle({ now: new Date('2026-08-25T10:07:00.000Z') });
    jest.spyOn(gameCycleService, 'reconcileCycle').mockResolvedValue(cycle);
    // Mid-cycle but before the collapse window: every live coin is written.
    const nowMs = new Date(cycle.start_time).getTime() + Math.floor(cycle.duration_ms * 0.3);
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    await marketSimulator.updateAllPrices();

    const { rows } = await db.query(
      `SELECT coin_id, cycle_id, source FROM price_history`
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.cycle_id).toBe(cycle.cycle_id);
      expect(row.source).toBe('MARKET_TICK');
    }
    // One row per live coin (no collapse has executed at 30% progress).
    const { rows: live } = await db.query('SELECT count(*)::int AS n FROM coins WHERE current_price > 0');
    expect(rows.length).toBe(live[0].n);
  });
});

describe('price_history provenance: collapse writer', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('the £0 transition row carries the schedule cycle id and source COLLAPSE', async () => {
    const cycle = await gameCycleService.reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    const { rows: scheduled } = await db.query(
      'SELECT coin_id, scheduled_at FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
      [cycle.cycle_id]
    );
    const dueAt = new Date(scheduled[0].scheduled_at);

    const client = await db.getClient();
    let executed;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(727001)');
      executed = await collapseScheduleService.executeDueCollapses(client, cycle.cycle_id, dueAt);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
      throw error;
    }
    client.release();

    expect(executed).toHaveLength(1);
    const { rows: history } = await db.query(
      'SELECT coin_id, cycle_id, price, created_at, source FROM price_history WHERE coin_id = $1',
      [scheduled[0].coin_id]
    );
    expect(history).toHaveLength(1);
    expect(history[0].cycle_id).toBe(cycle.cycle_id);
    expect(history[0].source).toBe('COLLAPSE');
    expect(parseFloat(history[0].price)).toBe(0);
    expect(new Date(history[0].created_at).getTime()).toBe(dueAt.getTime());
  });
});

describe('price_history provenance: legacy NULL rows and API compatibility', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('legacy NULL cycle_id/source rows remain readable through the unchanged public API', async () => {
    // A legacy row exactly as pre-019 production wrote it.
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at) VALUES (1, 42.50, CURRENT_TIMESTAMP)`
    );

    const res = await request(app).get('/api/coins/1/price-history?range=10M').expect(200);
    expect(res.body).toHaveProperty('points');
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.points.length).toBeGreaterThan(0);

    // Public contract unchanged: no provenance internals leak into responses.
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain('cycle_id');
    expect(payload).not.toContain('MARKET_TICK');
    expect(payload).not.toContain('COLLAPSE');
    expect(payload).not.toContain('source');
  });
});
