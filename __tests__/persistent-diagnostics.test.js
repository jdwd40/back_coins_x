const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');

jest.setTimeout(45000);

const TOKEN = 'persistent-diagnostics-test-token';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const TICK = new Date('2026-01-01T00:10:00.000Z');

beforeEach(() => {
  process.env.GAME_DIAGNOSTICS_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.GAME_DIAGNOSTICS_TOKEN;
});

async function createWorldFixture() {
  const world = await persistentWorld.provisionWorld(db, {
    seed: 'stage12-diagnostics-test-seed',
    epochStartedAt: EPOCH
  });
  await db.query(
    `INSERT INTO market_director_state
       (world_id, regime, regime_started_at, intensity, regime_index)
     VALUES ($1, 'BEAR', $2, 0.625, 7)`,
    [world.worldId, new Date('2026-01-01T00:05:00.000Z')]
  );
  await db.query('UPDATE coins SET retired = false WHERE coin_id BETWEEN 1 AND 10');
  await db.query(
    `UPDATE coins SET current_price = CASE coin_id
       WHEN 1 THEN 12.34
       WHEN 2 THEN 56.78
       WHEN 3 THEN 91.23
       WHEN 4 THEN 45.67
       ELSE current_price END
     WHERE coin_id IN (1, 2, 3, 4)`
  );
  await db.query('UPDATE coins SET retired = true WHERE coin_id = 3');
  await db.query(
    `INSERT INTO apocalypse_cycles
       (apocalypse_id, seed, start_time, end_time, duration_ms, status, settlement_started_at, settled_at)
     VALUES (999, 'legacy-diagnostics', $1, $2, 60000, 'COMPLETED', $1, $1)`,
    [EPOCH, new Date('2026-01-01T00:01:00.000Z')]
  );
  await db.query(
    `INSERT INTO market_coin_state
       (coin_id, world_id, archetype, condition, structural_reference, peak_reference, status, died_at)
     VALUES
       (1, $1, 'ZIP', 0.25, 12.34, 13.00, 'ALIVE', NULL),
       (2, $1, 'MOON', -0.80, 56.78, 60.00, 'DEAD', $2),
       (3, $1, 'RUG', -0.10, 91.23, 95.00, 'DEAD', $3),
       (4, $1, 'ZIP', 0.10, 45.67, 46.00, 'ALIVE', NULL)`,
    [world.worldId, new Date('2026-01-01T00:08:00.000Z'), new Date('2026-01-01T00:09:00.000Z')]
  );
  await db.query('DELETE FROM price_history WHERE coin_id IN (1, 2, 3, 4)');
  await db.query(
    `INSERT INTO price_history (coin_id, price, created_at, source, cycle_id)
     VALUES
       (1, 12.00, $1, 'MARKET_TICK', NULL),
       (1, 999.00, $2, 'MARKET_TICK', 1),
       (1, 998.00, $3, NULL, NULL),
       (2, 0.00, $1, 'MARKET_TICK', NULL)`,
    [TICK, new Date('2026-01-01T00:11:00.000Z'), new Date('2026-01-01T00:12:00.000Z')]
  );
  return world;
}

function responseKeys(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    output.push(key);
    responseKeys(child, output);
  }
  return output;
}

async function fingerprint() {
  const { rows } = await db.query(`
    SELECT
      (SELECT count(*)::int || ':' || md5(coalesce(string_agg(row_to_json(x)::text, '' ORDER BY row_to_json(x)::text), '')) FROM market_worlds x) AS worlds,
      (SELECT count(*)::int || ':' || md5(coalesce(string_agg(row_to_json(x)::text, '' ORDER BY row_to_json(x)::text), '')) FROM market_director_state x) AS directors,
      (SELECT count(*)::int || ':' || md5(coalesce(string_agg(row_to_json(x)::text, '' ORDER BY row_to_json(x)::text), '')) FROM market_coin_state x) AS states,
      (SELECT count(*)::int || ':' || md5(coalesce(string_agg(row_to_json(x)::text, '' ORDER BY row_to_json(x)::text), '')) FROM price_history x) AS history,
      (SELECT count(*)::int || ':' || md5(coalesce(string_agg(row_to_json(x)::text, '' ORDER BY row_to_json(x)::text), '')) FROM coins x) AS coins
  `);
  return rows[0];
}

describe('Stage 12A persistent diagnostics', () => {
  test('uses the existing diagnostics gate and fails closed when token is unset', async () => {
    delete process.env.GAME_DIAGNOSTICS_TOKEN;
    const unset = await request(app).get('/api/game/diagnostics/persistent');
    expect(unset.status).toBe(404);

    process.env.GAME_DIAGNOSTICS_TOKEN = TOKEN;
    const missing = await request(app).get('/api/game/diagnostics/persistent');
    expect(missing.status).toBe(401);

    const wrong = await request(app)
      .get('/api/game/diagnostics/persistent')
      .set('Authorization', 'Bearer wrong-token');
    expect(wrong.status).toBe(401);
  });

  test('returns a successful null-world snapshot without provisioning or mutation', async () => {
    const before = await fingerprint();
    const res = await request(app)
      .get('/api/game/diagnostics/persistent')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.status).toBe('success');
    expect(res.body.data.world).toBeNull();
    expect(res.body.data.director).toBeNull();
    expect(res.body.data.coins).toEqual([]);
    expect(res.body.data.market.latestMarketTickAt).toBeNull();
    expect(await fingerprint()).toEqual(before);
  });

  test('reports persisted world, Director, coin states, counts, and persistent tick provenance read-only', async () => {
    const world = await createWorldFixture();
    const before = await fingerprint();
    const res = await request(app)
      .get('/api/game/diagnostics/persistent')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.serverTime).toEqual(expect.any(String));
    expect(res.body.data.world).toEqual({
      worldId: world.worldId,
      version: 1,
      epochStartedAt: EPOCH.toISOString(),
      active: true
    });
    expect(res.body.data.director).toEqual({
      regime: 'BEAR',
      intensity: 0.625,
      regimeStartedAt: '2026-01-01T00:05:00.000Z',
      regimeIndex: 7
    });
    expect(res.body.data.market).toMatchObject({
      catalogueActiveCoins: 9,
      retiredCoins: 1,
      aliveCoins: 2,
      deadCoins: 2,
      latestMarketTickAt: TICK.toISOString()
    });

    const coin1 = res.body.data.coins.find((coin) => coin.coinId === 1);
    const coin2 = res.body.data.coins.find((coin) => coin.coinId === 2);
    const coin3 = res.body.data.coins.find((coin) => coin.coinId === 3);
    const coin4 = res.body.data.coins.find((coin) => coin.coinId === 4);
    expect(coin1).toMatchObject({ coinId: 1, currentPrice: 12.34, retired: false, status: 'ALIVE', archetype: 'ZIP' });
    expect(coin2).toMatchObject({ coinId: 2, currentPrice: 0, retired: false, status: 'DEAD', archetype: 'MOON' });
    expect(coin3).toMatchObject({ coinId: 3, currentPrice: 0, retired: true, status: 'DEAD', archetype: 'RUG' });
    expect(coin4).toMatchObject({ coinId: 4, currentPrice: 45.67, retired: false, status: 'ALIVE', archetype: 'ZIP' });
    expect(coin2.diedAt).toBe('2026-01-01T00:08:00.000Z');
    expect(coin1).toHaveProperty('checkpointUpdatedAt', null);
    expect(JSON.stringify(res.body)).not.toContain('stage12-diagnostics-test-seed');
    expect(responseKeys(res.body)).not.toEqual(expect.arrayContaining([
      'seed', 'rng', 'future', 'predicted', 'cycleId', 'apocalypseId'
    ]));
    expect(await fingerprint()).toEqual(before);
  });
});
