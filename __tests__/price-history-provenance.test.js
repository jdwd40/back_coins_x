// Persistent price-history provenance.
//
// Writer INSERT coverage for world-scoped MARKET_TICK ticks lives in
// __tests__/market-persistent-writer.test.js. This suite covers:
//   * collapse writer still stamps COLLAPSE + cycle_id (unchanged);
//   * production READ paths filter to source = 'MARKET_TICK' AND cycle_id IS NULL
//     so Apocalypse / COLLAPSE / legacy NULL rows never leak into charts,
//     24h change, writer lookback, or persistent bot history windows;
//   * public API shape stays free of provenance internals.

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const gameCycleService = require('../game/gameCycleService');
const dynamicCollapseService = require('../game/dynamicCollapseService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');
const priceHistoryModel = require('../models/priceHistory.model');
const coinsModel = require('../models/coins.model');
const persistentWorld = require('../game/persistentWorld');
const persistentBots = require('../game/persistentBots');
const { reconcileCycle } = require('../game/gameCycleService');

jest.setTimeout(60000);

const PREDICATE = "source = 'MARKET_TICK' AND cycle_id IS NULL";
const WORLD_SEED = 'price-history-provenance-test-seed';
const EPOCH = new Date('2026-09-01T00:00:00.000Z');
const COIN_ID = 1;

async function insertMixedHistory(coinId) {
  const cycle = await reconcileCycle({ now: new Date('2026-09-01T12:00:00.000Z') });
  const cycleId = cycle.cycle_id;

  await db.query('DELETE FROM price_history WHERE coin_id = $1', [coinId]);

  const tPersistentOld = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const tPersistentMid = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const tPersistentNew = new Date(Date.now() - 5 * 60 * 1000);
  const tApo = new Date(Date.now() - 4 * 60 * 1000);
  const tCollapse = new Date(Date.now() - 3 * 60 * 1000);
  const tLegacy = new Date(Date.now() - 2 * 60 * 1000);

  await db.query(
    `INSERT INTO price_history (coin_id, price, created_at, source, cycle_id)
     VALUES
       ($1, 100.00, $2, 'MARKET_TICK', NULL),
       ($1, 105.00, $3, 'MARKET_TICK', NULL),
       ($1, 110.00, $4, 'MARKET_TICK', NULL),
       ($1, 999.00, $5, 'MARKET_TICK', $6),
       ($1, 0.00, $7, 'COLLAPSE', $6),
       ($1, 888.00, $8, NULL, NULL)`,
    [coinId, tPersistentOld, tPersistentMid, tPersistentNew, tApo, cycleId, tCollapse, tLegacy]
  );

  return {
    cycleId,
    persistentPrices: [100, 105, 110],
    contaminantPrices: [999, 0, 888]
  };
}

describe('price_history provenance: collapse writer', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('every £0 transition row carries the cycle id and source COLLAPSE at the death instant', async () => {
    const cycle = await gameCycleService.reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
    const deathAt = new Date('2026-08-20T10:21:00.000Z');

    const client = await db.getClient();
    let executed;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(727001)');
      executed = await dynamicCollapseService.executeRemainingCollapses(client, cycle, deathAt);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
      throw error;
    }
    client.release();

    const { rows: coinCount } = await db.query('SELECT count(*)::int AS n FROM coins WHERE retired = FALSE');
    expect(executed).toHaveLength(coinCount[0].n);
    const { rows: history } = await db.query(
      `SELECT coin_id, cycle_id, price, created_at, source FROM price_history WHERE source = 'COLLAPSE'`
    );
    expect(history).toHaveLength(coinCount[0].n);
    for (const row of history) {
      expect(row.cycle_id).toBe(cycle.cycle_id);
      expect(parseFloat(row.price)).toBe(0);
      expect(new Date(row.created_at).getTime()).toBe(deathAt.getTime());
    }
  });
});

describe('price_history provenance: persistent read filter', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('source modules embed the exact persistent provenance predicate on every targeted SELECT', () => {
    const files = [
      'models/priceHistory.model.js',
      'models/coins.model.js',
      'models/market-simulator.js',
      'game/persistentBots.js'
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      expect(src).toContain(PREDICATE);
      expect(src).toContain('const PERSISTENT_PH');
    }

    const simulator = fs.readFileSync(path.join(__dirname, '..', 'models/market-simulator.js'), 'utf8');
    const selectMatches = simulator.match(/SELECT price FROM price_history[\s\S]*?LIMIT 1/g) || [];
    expect(selectMatches.length).toBeGreaterThanOrEqual(2);
    for (const chunk of selectMatches) {
      expect(chunk).toContain('${PERSISTENT_PH}');
    }

    const bots = fs.readFileSync(path.join(__dirname, '..', 'game/persistentBots.js'), 'utf8');
    expect(bots).toMatch(/FROM price_history[\s\S]*\$\{PERSISTENT_PH\}/);
  });

  test('legacy NULL cycle_id/source rows are excluded from the public price-history API (no provenance leak)', async () => {
    await db.query('DELETE FROM price_history WHERE coin_id = 1');
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at) VALUES (1, 42.50, CURRENT_TIMESTAMP)`
    );
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at, source, cycle_id)
       VALUES (1, 55.00, CURRENT_TIMESTAMP - INTERVAL '1 minute', 'MARKET_TICK', NULL)`
    );

    const res = await request(app).get('/api/coins/1/price-history?range=10M').expect(200);
    expect(res.body).toHaveProperty('points');
    expect(Array.isArray(res.body.points)).toBe(true);
    const closes = res.body.points.map((p) => p.close);
    expect(closes).toContain(55);
    expect(closes).not.toContain(42.5);

    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain('cycle_id');
    expect(payload).not.toContain('MARKET_TICK');
    expect(payload).not.toContain('COLLAPSE');
    expect(payload).not.toContain('"source"');
  });

  test('getPriceHistory (10M + ALL) returns only persistent MARKET_TICK/NULL-cycle prices', async () => {
    const { persistentPrices, contaminantPrices } = await insertMixedHistory(COIN_ID);

    const short = await priceHistoryModel.getPriceHistory(COIN_ID, '10M');
    const closes10 = short.points.map((p) => p.close);
    for (const bad of contaminantPrices) {
      expect(closes10).not.toContain(bad);
    }
    expect(closes10).toContain(110);

    const all = await priceHistoryModel.getPriceHistory(COIN_ID, 'ALL');
    const closesAll = all.points.map((p) => p.close);
    for (const bad of contaminantPrices) {
      expect(closesAll).not.toContain(bad);
    }
    for (const c of closesAll) {
      expect(persistentPrices).toContain(c);
    }
    expect(closesAll.length).toBeGreaterThan(0);
  });

  test('selectAllCoins 24h change baselines from persistent history only', async () => {
    await insertMixedHistory(COIN_ID);
    const coins = await coinsModel.selectAllCoins();
    const coin = coins.find((c) => c.coin_id === COIN_ID);
    expect(coin).toBeDefined();
    expect(coin.price_change_24h).toBeCloseTo(10, 5);
  });

  test('get24HourPriceChange via selectCoinById ignores legacy/collapse/cycle rows', async () => {
    await insertMixedHistory(COIN_ID);
    const coin = await coinsModel.selectCoinById(COIN_ID);
    expect(coin).toBeDefined();
    expect(coin.price_change_24h).toBeCloseTo(10, 5);
  });

  test('writer lookback mirror SQL and persistent bot history window ignore contaminants', async () => {
    const { persistentPrices, contaminantPrices } = await insertMixedHistory(COIN_ID);

    const lookback = await db.query(
      `SELECT price FROM price_history
        WHERE coin_id = $1 AND created_at <= $2 AND price > 0
          AND source = 'MARKET_TICK' AND cycle_id IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [COIN_ID, new Date().toISOString()]
    );
    expect(lookback.rows).toHaveLength(1);
    expect(Number(lookback.rows[0].price)).toBe(110);

    const windowOpen = await db.query(
      `SELECT price FROM price_history
        WHERE coin_id = $1 AND created_at >= $2 AND price > 0
          AND source = 'MARKET_TICK' AND cycle_id IS NULL
        ORDER BY created_at ASC LIMIT 1`,
      [COIN_ID, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
    );
    expect(windowOpen.rows).toHaveLength(1);
    expect(Number(windowOpen.rows[0].price)).toBe(105);

    const world = await persistentWorld.provisionWorld(db, {
      seed: WORLD_SEED,
      epochStartedAt: EPOCH
    });
    const state = await persistentBots.buildPublicPersistentMarketState({
      world,
      account: { cash: 0, debt: 0, holdings: [] },
      nowMs: Date.now(),
      historyWindow: 20
    });
    const botCoin = state.coins.find((c) => c.coinId === COIN_ID);
    expect(botCoin).toBeDefined();
    for (const bad of contaminantPrices) {
      expect(botCoin.history).not.toContain(bad);
    }
    for (const p of botCoin.history) {
      expect(persistentPrices).toContain(p);
    }
    expect(botCoin.history).toEqual(expect.arrayContaining([100, 105, 110]));
  });

  test('smoke: persistent market signals service still embeds provenance filter', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'game/persistentMarketSignalsService.js'),
      'utf8'
    );
    expect(src).toContain("source = 'MARKET_TICK'");
    expect(src).toContain('cycle_id IS NULL');
  });
});
