const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const persistentDiagnosticsService = require('../game/persistentDiagnosticsService');

jest.setTimeout(45000);

const TOKEN = 'persistent-diagnostics-test-token';
const WORLD_SEED = 'stage12-diagnostics-test-seed';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const PRE_EPOCH_TICK = new Date('2025-12-31T23:59:00.000Z');
const TICK = new Date('2026-01-01T00:10:00.000Z');

beforeEach(() => {
  process.env.GAME_DIAGNOSTICS_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.GAME_DIAGNOSTICS_TOKEN;
});

async function createWorldFixture() {
  const world = await persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
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
  const { rows: checkpointRows } = await db.query(
    `INSERT INTO market_price_checkpoints (
       coin_id, seed, checkpoint_ms,
       domain_cycle_index, domain_cycle_start_ms, domain_anchor, domain_boundary,
       crash_episode_index, crash_cursor_ms, crash_factor, activation_context
     ) VALUES ($1, $2, $3, 0, $4, 12.34, 13.00, 1, $4, 1.0, 'PERSISTENT')
     RETURNING updated_at`,
    [1, WORLD_SEED, TICK.getTime(), EPOCH.getTime()]
  );
  await db.query('DELETE FROM price_history WHERE coin_id IN (1, 2, 3, 4)');
  await db.query(
    `INSERT INTO price_history (coin_id, price, created_at, source, cycle_id)
     VALUES
       (1, 12.00, $1, 'MARKET_TICK', NULL),
       (1, 997.00, $2, 'MARKET_TICK', NULL),
       (1, 999.00, $3, 'MARKET_TICK', 1),
       (1, 998.00, $4, NULL, NULL),
       (2, 0.00, $1, 'MARKET_TICK', NULL)`,
    [TICK, PRE_EPOCH_TICK, new Date('2026-01-01T00:11:00.000Z'), new Date('2026-01-01T00:12:00.000Z')]
  );
  return {
    world,
    checkpointUpdatedAt: new Date(checkpointRows[0].updated_at).toISOString()
  };
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
      (SELECT count(*)::int || ':' || md5(coalesce(string_agg(row_to_json(x)::text, '' ORDER BY row_to_json(x)::text), '')) FROM market_price_checkpoints x) AS checkpoints,
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
    expect(res.body.data.market).toMatchObject({
      activeAliveCoins: 0,
      activeDeadCoins: 0,
      latestMarketTickAt: null
    });
    expect(await fingerprint()).toEqual(before);
  });

  test('reports persisted world, Director, active-roster counts, coin states, checkpoint, and tick provenance read-only', async () => {
    const { world, checkpointUpdatedAt } = await createWorldFixture();
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
      activeAliveCoins: 2,
      activeDeadCoins: 1,
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
    expect(coin1.checkpointUpdatedAt).toBe(checkpointUpdatedAt);
    expect(JSON.stringify(res.body)).not.toContain(WORLD_SEED);
    expect(responseKeys(res.body)).not.toEqual(expect.arrayContaining([
      'seed', 'rng', 'future', 'predicted', 'cycleId', 'apocalypseId'
    ]));
    expect(await fingerprint()).toEqual(before);
  });

  test('excludes a pre-world-epoch persistent MARKET_TICK from latestMarketTickAt', async () => {
    await createWorldFixture();
    await db.query('DELETE FROM price_history WHERE coin_id IN (1, 2, 3, 4)');
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at, source, cycle_id)
       VALUES (1, 777.00, $1, 'MARKET_TICK', NULL)`,
      [PRE_EPOCH_TICK]
    );

    const res = await request(app)
      .get('/api/game/diagnostics/persistent')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.world.worldId).toEqual(expect.any(Number));
    expect(res.body.data.market.latestMarketTickAt).toBeNull();
  });

  test('uses a real repeatable-read, read-only PostgreSQL snapshot across a concurrent commit', async () => {
    await db.query('UPDATE coins SET current_price = 10.00 WHERE coin_id = 1');
    const writer = await db.getClient();
    try {
      const observed = await persistentDiagnosticsService.__test.withReadOnlySnapshot(async (client) => {
        const first = await client.query('SELECT current_price FROM coins WHERE coin_id = 1');

        await writer.query('BEGIN');
        await writer.query('UPDATE coins SET current_price = 20.00 WHERE coin_id = 1');
        await writer.query('COMMIT');

        const second = await client.query('SELECT current_price FROM coins WHERE coin_id = 1');
        return [Number(first.rows[0].current_price), Number(second.rows[0].current_price)];
      });

      expect(observed).toEqual([10, 10]);
      const committed = await db.query('SELECT current_price FROM coins WHERE coin_id = 1');
      expect(Number(committed.rows[0].current_price)).toBe(20);

      await expect(
        persistentDiagnosticsService.__test.withReadOnlySnapshot((client) =>
          client.query('UPDATE coins SET current_price = 30.00 WHERE coin_id = 1')
        )
      ).rejects.toMatchObject({ code: '25006' });
    } finally {
      try { await writer.query('ROLLBACK'); } catch (_) {}
      writer.release();
    }
  });
});
