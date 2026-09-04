// Persistent-market Stage 11-02: public GET /api/persistent/signals
// Real PostgreSQL tests against disposable coins_test (guard enforced).
// Covers: soft world resolve (no provision), exact DTO keys only,
// authoritative currentPrice from coins.current_price (post-writer parity),
// real Stage 9 death path (spy+writer, pre-retire), real replacement runtime,
// no mutation by GET, director redaction, recentChangePct from history (bounded),
// momentum derivation, 200 empty on no-world, snapshot consistency across
// concurrent replace tx (pre or post, never partial), recursive forbid of
// legacy/apocalypse/cycle/private keys.
//
// Uses: supertest, real marketSimulator + collapseRisk spy for death,
// real reconcilePersistentReplacements, direct DB snapshots for mutation proof.
// No mocks of DB locking for snapshot test.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const replacementRuntime = require('../game/persistentReplacementRuntime');
const persistentWorld = require('../game/persistentWorld');
const coinStateModel = require('../models/marketCoinState.model');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(120000);

const WORLD_SEED = 'stage11-02-persistent-market-signals-test';
const EPOCH = new Date('2026-09-04T00:00:00.000Z');

function round2(v) { return Math.round(v * 100) / 100; }

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
    epochStartedAt: EPOCH
  });
}

async function forceWriterDeath(coinId, nowMs) {
  const spy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore')
    .mockImplementation((opts) => (Number(opts.coinId) === Number(coinId) ? 9.5 : 0.5));
  await marketSimulator.updateAllPrices({ nowMs });
  spy.mockRestore();
}

async function cleanHighCoins() {
  await db.query('DELETE FROM price_history WHERE coin_id >= 100');
  await db.query('DELETE FROM market_coin_state WHERE coin_id >= 100');
  await db.query('DELETE FROM coins WHERE coin_id >= 100');
  await db.query('UPDATE coins SET retired = false WHERE coin_id BETWEEN 1 AND 10');
}

async function snapshotState() {
  const [prices, states, worldRows, directors, histCount, retiredRows] = await Promise.all([
    db.query('SELECT coin_id, current_price FROM coins WHERE coin_id <= 10 ORDER BY coin_id'),
    db.query('SELECT coin_id, status, retired FROM coins c LEFT JOIN market_coin_state s USING (coin_id) WHERE coin_id <= 10 ORDER BY coin_id'),
    db.query('SELECT world_id, seed, active FROM market_worlds WHERE active ORDER BY world_id'),
    db.query('SELECT regime, intensity FROM market_director_state ORDER BY world_id'),
    db.query('SELECT count(*)::int AS n FROM price_history'),
    db.query('SELECT coin_id FROM coins WHERE retired = true ORDER BY coin_id')
  ]);
  return {
    prices: prices.rows,
    states: states.rows,
    world: worldRows.rows[0] || null,
    director: directors.rows[0] || null,
    historyCount: histCount.rows[0].n,
    retiredCoins: retiredRows.rows.map(r => r.coin_id)
  };
}

function assertExactDtoKeys(data) {
  // Top level exact
  const topKeys = Object.keys(data).sort();
  expect(topKeys).toEqual(['coins', 'director', 'serverTime', 'worldId'].sort());

  // director exact (null or {regime, intensity})
  if (data.director !== null) {
    const dKeys = Object.keys(data.director).sort();
    expect(dKeys).toEqual(['intensity', 'regime'].sort());
    expect(typeof data.director.regime).toBe('string');
    expect(typeof data.director.intensity).toBe('number');
  } else {
    expect(data.director).toBeNull();
  }

  // each coin exact keys, no extras
  const coinKeys = ['archetype', 'coinId', 'currentPrice', 'dead', 'momentum', 'name', 'recentChangePct', 'status', 'symbol'].sort();
  for (const c of data.coins) {
    expect(Object.keys(c).sort()).toEqual(coinKeys);
    expect(typeof c.coinId).toBe('number');
    expect(typeof c.name).toBe('string');
    expect(typeof c.symbol).toBe('string');
    expect(typeof c.currentPrice).toBe('number');
    expect(typeof c.dead).toBe('boolean');
    expect(typeof c.status).toBe('string');
    expect(typeof c.archetype).toBe('string');
    // recentChangePct null or number
    expect(c.recentChangePct === null || typeof c.recentChangePct === 'number').toBe(true);
    expect(['UP', 'DOWN', 'FLAT']).toContain(c.momentum);
  }
}

function assertNoForbiddenKeys(obj) {
  const s = JSON.stringify(obj);
  const forbidden = [
    'apocalypse', 'cycle', 'seed', 'regimeIndex', 'collapseRisk', 'phase',
    'condition', 'endsAt', 'future', 'risk', 'botPrivate', 'settlement',
    'event', 'directorRolls', 'structuralReference', 'damage'
  ];
  for (const f of forbidden) {
    expect(s).not.toContain(f);
  }
}

describe('Stage 11-02: GET /api/persistent/signals (real PG, disposable coins_test)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await cleanHighCoins();
    await provisionedWorld();
    // Force initial states + director + history via real writer
    await marketSimulator.updateAllPrices({ nowMs: EPOCH.getTime() + 60000 });
  });

  test('1. after real writer batch, every currentPrice exactly matches DB coins.current_price', async () => {
    const res = await request(app).get('/api/persistent/signals').expect(200);
    expect(res.body.status).toBe('success');
    const data = res.body.data;
    assertExactDtoKeys(data);

    for (const c of data.coins) {
      const { rows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [c.coinId]);
      const dbPrice = parseFloat(rows[0].current_price);
      expect(c.currentPrice).toBe(dbPrice);
    }
    assertNoForbiddenKeys(res.body);
  });

  test('2. real Stage 9 death path (writer, not direct SQL): before soft-retire shows DEAD/true/0/null/FLAT, retired still false', async () => {
    await forceWriterDeath(1, Date.now());
    // Confirm DB state pre-reconcile: retired=false, status=DEAD
    const pre = await db.query('SELECT retired FROM coins WHERE coin_id=1');
    expect(pre.rows[0].retired).toBe(false);
    const st = await db.query('SELECT status FROM market_coin_state WHERE coin_id=1');
    expect(st.rows[0].status).toBe('DEAD');

    const res = await request(app).get('/api/persistent/signals').expect(200);
    const coin = res.body.data.coins.find(c => c.coinId === 1);
    expect(coin).toBeDefined();
    expect(coin.status).toBe('DEAD');
    expect(coin.dead).toBe(true);
    expect(coin.currentPrice).toBe(0);
    expect(coin.recentChangePct).toBeNull();
    expect(coin.momentum).toBe('FLAT');
    expect(coin.archetype).toBeDefined(); // persisted

    // still not retired
    const dbRet = await db.query('SELECT retired FROM coins WHERE coin_id=1');
    expect(dbRet.rows[0].retired).toBe(false);

    assertExactDtoKeys(res.body.data);
    assertNoForbiddenKeys(res.body);
  });

  test('3. real replacement runtime: predecessor disappears after soft-retire; replacement appears ALIVE/retired=false/positive DB price/exact persisted archetype; predecessor never returns', async () => {
    await forceWriterDeath(1, Date.now() - 100000);
    // delay is 6h in default config; use now + delay to make eligible immediately
    const delayMs = 6 * 60 * 60 * 1000;
    const introduced = await replacementRuntime.reconcilePersistentReplacements({
      nowMs: Date.now() - 100000 + delayMs
    });
    expect(introduced.inserted.length).toBeGreaterThan(0);
    const repl = introduced.inserted[0];
    expect(repl.archetype).toBe('ZIP');

    const res = await request(app).get('/api/persistent/signals').expect(200);
    const data = res.body.data;
    assertExactDtoKeys(data);

    // predecessor gone
    expect(data.coins.find(c => c.coinId === 1)).toBeUndefined();
    // replacement present
    const r = data.coins.find(c => c.coinId === repl.coinId);
    expect(r).toBeDefined();
    expect(r.status).toBe('ALIVE');
    expect(r.dead).toBe(false);
    expect(r.currentPrice).toBeGreaterThan(0);
    expect(r.archetype).toBe(repl.archetype); // exact persisted, not resolved default
    expect(r.recentChangePct).toBeNull();

    // DB confirms retired
    const dbPre = await db.query('SELECT retired FROM coins WHERE coin_id=1');
    expect(dbPre.rows[0].retired).toBe(true);

    assertNoForbiddenKeys(res.body);
  });

  test('4+8. recursively rejects forbidden keys; explicit exact allowed keys at every DTO level', async () => {
    const res = await request(app).get('/api/persistent/signals').expect(200);
    assertExactDtoKeys(res.body.data);
    assertNoForbiddenKeys(res.body);

    // also top level envelope
    expect(Object.keys(res.body).sort()).toEqual(['data', 'status'].sort());
  });

  test('5. director contains ONLY regime/intensity (or null); no internals/future', async () => {
    const res = await request(app).get('/api/persistent/signals').expect(200);
    const d = res.body.data.director;
    if (d) {
      const keys = Object.keys(d).sort();
      expect(keys).toEqual(['intensity', 'regime'].sort());
      expect(res.body.data).not.toHaveProperty('regimeIndex');
      expect(JSON.stringify(res.body)).not.toContain('regimeIndex');
      expect(JSON.stringify(res.body)).not.toContain('startMs');
      expect(JSON.stringify(res.body)).not.toContain('seed');
    } else {
      expect(d).toBeNull();
    }
  });

  test('6. GET captures state before/after; proves ZERO mutation to price/coin-state/world/Director/history/replacement', async () => {
    const before = await snapshotState();

    const res = await request(app).get('/api/persistent/signals').expect(200);
    expect(res.body.status).toBe('success');

    const after = await snapshotState();

    expect(after.prices).toEqual(before.prices);
    expect(after.states).toEqual(before.states);
    expect(after.world).toEqual(before.world);
    expect(after.director).toEqual(before.director);
    expect(after.historyCount).toBe(before.historyCount);
    expect(after.retiredCoins).toEqual(before.retiredCoins);
  });

  test('7. no active world returns HTTP 200 exactly {serverTime, worldId:null, director:null, coins:[] } and does not provision', async () => {
    await db.query('UPDATE market_worlds SET active = false');

    const res = await request(app).get('/api/persistent/signals').expect(200);
    expect(res.body).toMatchObject({
      status: 'success',
      data: { worldId: null, director: null, coins: [] }
    });
    expect(typeof res.body.data.serverTime).toBe('string');

    // did not create/provision
    const count = await db.query('SELECT count(*)::int AS n FROM market_worlds WHERE active');
    expect(count.rows[0].n).toBe(0);
  });

  test('9. committed history produces bounded recentChangePct; missing sample => null; DEAD => null', async () => {
    // Use coin 2: insert committed history sample 60s+ ago, set current, GET
    const pastTs = new Date(Date.now() - 90000);
    await db.query('DELETE FROM price_history WHERE coin_id = 2 AND created_at <= $1', [pastTs]);
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at, source)
       VALUES (2, 20.00, $1, 'MARKET_TICK')`,
      [pastTs]
    );
    await db.query('UPDATE coins SET current_price = 20.60 WHERE coin_id = 2');

    let res = await request(app).get('/api/persistent/signals').expect(200);
    let c2 = res.body.data.coins.find(c => c.coinId === 2);
    expect(c2).toBeDefined();
    expect(c2.currentPrice).toBe(20.6);
    expect(c2.recentChangePct).toBe(3); // (20.6-20)/20 *100 = 3
    expect(c2.momentum).toBe('UP');

    // DEAD case: force death on 3, recent must null
    await forceWriterDeath(3, Date.now());
    res = await request(app).get('/api/persistent/signals').expect(200);
    const c3 = res.body.data.coins.find(c => c.coinId === 3);
    expect(c3).toBeDefined();
    expect(c3.status).toBe('DEAD');
    expect(c3.recentChangePct).toBeNull();
    expect(c3.momentum).toBe('FLAT');

    // explicit: missing historical sample (no committed price_history row with created_at <= cutoff) => recentChangePct null
    await db.query('DELETE FROM price_history WHERE coin_id = 4');
    await db.query('UPDATE coins SET current_price = 15.00 WHERE coin_id = 4');
    res = await request(app).get('/api/persistent/signals').expect(200);
    const c4 = res.body.data.coins.find(c => c.coinId === 4);
    expect(c4).toBeDefined();
    expect(c4.recentChangePct).toBeNull();
    expect(c4.momentum).toBe('FLAT');

    // replacement also exercises recent=null for fresh intro (history at reconcile now, not <=cutoff)
    await forceWriterDeath(2, Date.now() - 200000);
    const del = await replacementRuntime.reconcilePersistentReplacements({ nowMs: Date.now() - 200000 + 7 * 3600 * 1000 });
    res = await request(app).get('/api/persistent/signals').expect(200);
    const newish = res.body.data.coins.find(c => c.coinId > 100 && c.status === 'ALIVE');
    if (newish) {
      expect(newish.recentChangePct).toBeNull();
    }
  });

  test('10. real concurrent tx snapshot: signals sees pre-commit or post-commit replace state, never partial mix (no mock of locking)', async () => {
    // Death on 1, pre-reconcile
    await forceWriterDeath(1, Date.now() - 300000);
    const preCheck = await db.query('SELECT retired FROM coins WHERE coin_id=1');
    expect(preCheck.rows[0].retired).toBe(false);

    // Start uncommitted replace tx (real DB tx, no mock)
    const writeClient = await db.getClient();
    await writeClient.query('BEGIN');
    // Retire the predecessor inside tx (uncommitted)
    await writeClient.query('UPDATE coins SET retired = true WHERE coin_id = 1');
    // Insert authored replacement inside same uncommitted tx (partial work)
    await writeClient.query(
      `INSERT INTO coins (coin_id, name, symbol, current_price, market_cap, circulating_supply, price_change_24h, founder, cycle_baseline_price, retired)
       VALUES (999, 'SnapTestRepl', 'SNAP', 0.25, 1000, 4000, 0, 'Stage11-snap', 0.25, false)
       ON CONFLICT (coin_id) DO UPDATE SET retired = EXCLUDED.retired, current_price = EXCLUDED.current_price`
    );
    await writeClient.query(
      `INSERT INTO market_coin_state (coin_id, world_id, archetype, condition, structural_reference, peak_reference, status, died_at)
       SELECT 999, world_id, 'DEGEN', 0, 0.25, 0.25, 'ALIVE', NULL
       FROM market_worlds WHERE active LIMIT 1
       ON CONFLICT (coin_id) DO NOTHING`
    );
    // Insert minimal history
    await writeClient.query(
      `INSERT INTO price_history (coin_id, price, created_at, source) VALUES (999, 0.25, now(), 'MARKET_TICK')`
    );

    // While tx uncommitted, signals (its own tx snapshot) MUST see pre state fully
    const during = await request(app).get('/api/persistent/signals').expect(200);
    const dData = during.body.data;
    const seenDead = dData.coins.find(c => c.coinId === 1);
    const seenNew = dData.coins.find(c => c.coinId === 999);
    expect(seenDead).toBeDefined(); // pre: still visible, not yet retired in snapshot
    expect(seenDead.status).toBe('DEAD');
    expect(seenNew).toBeUndefined(); // no partial insert visible

    // Commit the tx
    await writeClient.query('COMMIT');
    writeClient.release();

    // Now post
    const post = await request(app).get('/api/persistent/signals').expect(200);
    const pData = post.body.data;
    expect(pData.coins.find(c => c.coinId === 1)).toBeUndefined();
    const postNew = pData.coins.find(c => c.coinId === 999);
    expect(postNew).toBeDefined();
    expect(postNew.status).toBe('ALIVE');
    expect(postNew.archetype).toBe('DEGEN');
    expect(postNew.currentPrice).toBe(0.25);

    // cleanup the temp
    await db.query('DELETE FROM price_history WHERE coin_id=999');
    await db.query('DELETE FROM market_coin_state WHERE coin_id=999');
    await db.query('DELETE FROM coins WHERE coin_id=999');
    await db.query('UPDATE coins SET retired=false WHERE coin_id=1');
  });

  test('no-world + public 200 envelope shape', async () => {
    await db.query('UPDATE market_worlds SET active = false');
    const res = await request(app).get('/api/persistent/signals').expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('serverTime');
    expect(res.body.data.worldId).toBeNull();
    expect(res.body.data.director).toBeNull();
    expect(res.body.data.coins).toEqual([]);
  });
});
