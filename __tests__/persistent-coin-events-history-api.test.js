// Issue #52: public GET /api/persistent/coins/:coin_id/events?limit=N
// Real PostgreSQL tests against disposable coins_test (guard enforced;
// jest.setup.js reseeds before each test). Event windows are relative to
// a world epoch computed in beforeEach (Date.now() - 10 min).

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const service = require('../game/persistentCoinEventHistoryService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(120000);

const EVENT_KEYS = ['direction', 'endsAt', 'eventId', 'modifierPct', 'name', 'source', 'startsAt'];
const MIN = 60000;

let nowMs;
let epoch;

async function insertEvent({ worldId, coinId, seq, name = `ev-${seq}`, direction = 'POSITIVE', source = 'NORMAL', modifier = 0.05, startOffsetMin, durationMin = 5 }) {
  const startsAt = new Date(nowMs + startOffsetMin * MIN);
  const endsAt = new Date(startsAt.getTime() + durationMin * MIN);
  const { rows } = await db.query(
    `INSERT INTO persistent_coin_events (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING event_id`,
    [worldId, coinId, seq, name, direction, source, modifier, startsAt.toISOString(), endsAt.toISOString()]
  );
  return Number(rows[0].event_id);
}

async function provision() {
  const world = await persistentWorld.provisionWorld(db, { seed: 'issue-52-coin-events-history', epochStartedAt: epoch });
  return world.worldId;
}

describe('Issue #52: GET /api/persistent/coins/:coin_id/events', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
    nowMs = Date.now();
    epoch = new Date(nowMs - 10 * MIN);
  });

  test('no active world: 200 with worldId null and empty events (no auth)', async () => {
    await db.query('UPDATE market_worlds SET active = false WHERE active');
    const res = await request(app).get('/api/persistent/coins/1/events').expect(200);
    expect(res.body.status).toBe('success');
    expect(Object.keys(res.body.data).sort()).toEqual(['coinId', 'events', 'serverTime', 'worldId']);
    expect(res.body.data).toMatchObject({ worldId: null, coinId: 1, events: [] });
    expect(Number.isFinite(new Date(res.body.data.serverTime).getTime())).toBe(true);
  });

  test('returns started (active + expired) events for the coin and world only, newest first, exact allowlist', async () => {
    const worldId = await provision();
    const expired = await insertEvent({ worldId, coinId: 1, seq: 1, name: 'Old Hype', startOffsetMin: -9, durationMin: 3, modifier: 0.0312345678 });
    const active = await insertEvent({ worldId, coinId: 1, seq: 2, name: 'Crash', direction: 'NEGATIVE', source: 'DEMON', modifier: -0.07, startOffsetMin: -2, durationMin: 10 });
    await insertEvent({ worldId, coinId: 1, seq: 3, name: 'Future', startOffsetMin: 5 }); // future: excluded
    await insertEvent({ worldId, coinId: 2, seq: 1, name: 'Other Coin', startOffsetMin: -3 }); // other coin
    const { rows } = await db.query(
      `INSERT INTO market_worlds (version, seed, epoch_started_at, active) VALUES (1, 'other-world', $1, false) RETURNING world_id`,
      [epoch.toISOString()]
    );
    await insertEvent({ worldId: rows[0].world_id, coinId: 1, seq: 1, name: 'Other World', startOffsetMin: -1 });

    const res = await request(app).get('/api/persistent/coins/1/events').expect(200);
    const data = res.body.data;
    expect(data.worldId).toBe(worldId);
    expect(data.coinId).toBe(1);
    expect(data.events.map((e) => e.eventId)).toEqual([active, expired]);
    for (const e of data.events) expect(Object.keys(e).sort()).toEqual(EVENT_KEYS);
    expect(data.events[0]).toMatchObject({ name: 'Crash', direction: 'NEGATIVE', source: 'DIRECTOR', modifierPct: -7 });
    expect(data.events[1]).toMatchObject({ name: 'Old Hype', direction: 'POSITIVE', source: 'MARKET', modifierPct: 3.1235 });
    expect(new Date(data.events[1].endsAt).getTime()).toBeLessThan(new Date(data.serverTime).getTime());
    const raw = JSON.stringify(res.body);
    for (const forbidden of ['DEMON', 'GOLDEN', 'RESCUE', 'event_seq', 'eventSeq', 'seed', 'created']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  test('source mapping never exposes raw Director vocabulary', () => {
    expect(service.publicSource('NORMAL')).toBe('MARKET');
    for (const s of ['GOLDEN', 'DEMON', 'RESCUE', 'DIRECTOR']) expect(service.publicSource(s)).toBe('DIRECTOR');
  });

  test('deterministic tie-break: same start time orders by eventId desc', async () => {
    const worldId = await provision();
    const a = await insertEvent({ worldId, coinId: 3, seq: 1, startOffsetMin: -4 });
    const b = await insertEvent({ worldId, coinId: 3, seq: 2, direction: 'NEGATIVE', modifier: -0.02, startOffsetMin: -4 });
    const res = await request(app).get('/api/persistent/coins/3/events').expect(200);
    expect(res.body.data.events.map((e) => e.eventId)).toEqual([b, a]);
  });

  test('limit: default 50, max 100, bounded result', async () => {
    const worldId = await provision();
    for (let i = 1; i <= 3; i += 1) await insertEvent({ worldId, coinId: 4, seq: i, startOffsetMin: -9 + i, durationMin: 1 });
    const res = await request(app).get('/api/persistent/coins/4/events?limit=2').expect(200);
    expect(res.body.data.events).toHaveLength(2);
    await request(app).get('/api/persistent/coins/4/events?limit=100').expect(200);
    expect(service.DEFAULT_LIMIT).toBe(50);
    expect(service.MAX_LIMIT).toBe(100);
  });

  test.each([
    ['/api/persistent/coins/0/events'],
    ['/api/persistent/coins/-1/events'],
    ['/api/persistent/coins/abc/events'],
    ['/api/persistent/coins/1.5/events'],
    ['/api/persistent/coins/99999999999/events'],
    ['/api/persistent/coins/1/events?limit=0'],
    ['/api/persistent/coins/1/events?limit=101'],
    ['/api/persistent/coins/1/events?limit=abc'],
    ['/api/persistent/coins/1/events?limit=2.5'],
    ['/api/persistent/coins/1/events?limit='],
    ['/api/persistent/coins/1/events?limit=1&limit=2']
  ])('400 for invalid input %s', async (url) => {
    const res = await request(app).get(url).expect(400);
    expect(res.body.status).toBe('error');
  });

  test('404 for a coin absent from the catalogue', async () => {
    await provision();
    const res = await request(app).get('/api/persistent/coins/987654/events').expect(404);
    expect(res.body.status).toBe('error');
  });

  test('dead/retired catalogue coin keeps its history', async () => {
    const worldId = await provision();
    const id = await insertEvent({ worldId, coinId: 5, seq: 1, startOffsetMin: -8 });
    await db.query('UPDATE coins SET retired = true WHERE coin_id = 5');
    await db.query(`UPDATE market_coin_state SET status = 'DEAD' WHERE coin_id = 5 AND world_id = $1`, [worldId]).catch(() => {});
    try {
      const res = await request(app).get('/api/persistent/coins/5/events').expect(200);
      expect(res.body.data.events.map((e) => e.eventId)).toEqual([id]);
    } finally {
      await db.query('UPDATE coins SET retired = false WHERE coin_id = 5');
    }
  });

  test('real DB errors propagate rather than becoming empty success', async () => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE persistent_coin_events RENAME TO persistent_coin_events_hidden');
      await expect(service.getPersistentCoinEventHistory({ coinId: 1, queryable: client }))
        .resolves.toMatchObject({ worldId: null }); // no world in this tx -> no events read
      await persistentWorld.provisionWorld(client, { seed: 'issue-52-err', epochStartedAt: epoch });
      await expect(service.getPersistentCoinEventHistory({ coinId: 1, queryable: client })).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('read-only: no rows change', async () => {
    const worldId = await provision();
    await insertEvent({ worldId, coinId: 1, seq: 1, startOffsetMin: -3 });
    const fp = async () => (await db.query('SELECT count(*)::int n, max(event_id) m FROM persistent_coin_events')).rows[0];
    const before = await fp();
    await request(app).get('/api/persistent/coins/1/events').expect(200);
    expect(await fp()).toEqual(before);
  });
});
