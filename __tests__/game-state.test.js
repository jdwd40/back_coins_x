const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');

describe('GET /api/game/state', () => {
  test('responds 200 with the stable public game-state contract', async () => {
    const response = await request(app)
      .get('/api/game/state')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).toMatchObject({
      apocalypseId: expect.stringMatching(/^APOC-\d{4,}$/),
      status: 'ACTIVE',
      startTime: expect.any(String),
      endTime: expect.any(String),
      durationMs: expect.any(Number),
      remainingMs: expect.any(Number),
      apocalypsePercent: expect.any(Number),
      serverTime: expect.any(String)
    });

    // Milestone 1: the cycle seed is internal-only — never in the public
    // contract (it deterministically drives future collapses and bot moves).
    expect(response.body).not.toHaveProperty('seed');

    // ISO 8601 timestamps that actually parse.
    for (const key of ['startTime', 'endTime', 'serverTime']) {
      expect(Number.isNaN(Date.parse(response.body[key]))).toBe(false);
    }
    expect(new Date(response.body.endTime).getTime())
      .toBeGreaterThan(new Date(response.body.startTime).getTime());

    // Derived values stay inside their documented bounds.
    expect(response.body.durationMs).toBeGreaterThan(0);
    expect(response.body.remainingMs).toBeGreaterThanOrEqual(0);
    expect(response.body.remainingMs).toBeLessThanOrEqual(response.body.durationMs);
    expect(response.body.apocalypsePercent).toBeGreaterThanOrEqual(0);
    expect(response.body.apocalypsePercent).toBeLessThanOrEqual(100);
  });

  test('returns the same persisted cycle on repeated requests (browser is not authoritative)', async () => {
    const first = await request(app).get('/api/game/state').expect(200);
    const second = await request(app).get('/api/game/state').expect(200);

    expect(second.body.apocalypseId).toBe(first.body.apocalypseId);
    expect(second.body.startTime).toBe(first.body.startTime);
    expect(second.body.endTime).toBe(first.body.endTime);
  });

  test('ignores any client-supplied seed or timing input', async () => {
    const response = await request(app)
      .get('/api/game/state')
      .query({ seed: 'client-seed', startTime: '1999-01-01T00:00:00.000Z' })
      .expect(200);

    // The response never carries any seed — server-generated or otherwise.
    expect(response.body).not.toHaveProperty('seed');
    expect(Date.parse(response.body.startTime)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
  });

  test('is read-only: mutating verbs are not routed', async () => {
    await request(app).post('/api/game/state').expect(404);
    await request(app).put('/api/game/state').expect(404);
    await request(app).delete('/api/game/state').expect(404);
  });

  test('state reflects the persisted row in apocalypse_cycles', async () => {
    const response = await request(app).get('/api/game/state').expect(200);
    const { rows } = await db.query("SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE'");

    expect(rows).toHaveLength(1);
    expect(response.body.apocalypseId).toBe(rows[0].apocalypse_id);
    // The persisted seed stays internal: present in the row, absent publicly.
    expect(rows[0].seed).toBeTruthy();
    expect(response.body).not.toHaveProperty('seed');
    expect(Date.parse(response.body.startTime)).toBe(new Date(rows[0].start_time).getTime());
    expect(Date.parse(response.body.endTime)).toBe(new Date(rows[0].end_time).getTime());
    expect(response.body.durationMs).toBe(Number(rows[0].duration_ms));
  });
});
