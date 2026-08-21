// Milestone 1 hardening: the cycle seed (and anything equivalent that enables
// future-collapse prediction) must never appear in a PUBLIC game response.
// The seed is the deterministic source of the Core 3 collapse schedule and
// the Core 5 bot randomness — publishing it lets anyone recompute exactly
// which coin dies when. The seed stays persisted internally (apocalypse_
// cycles.seed) and keeps driving schedule generation and bot decisions; it
// just never crosses the API boundary — not in state, leaderboard, results,
// participant/join/trade payloads, or error messages.
//
// jest.setup.js reseeds the disposable test database before every test.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const jwt = require('jsonwebtoken');

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET);
}

async function persistedSeed() {
  const { rows } = await db.query(
    `SELECT seed FROM apocalypse_cycles ORDER BY cycle_id DESC LIMIT 1`
  );
  return rows[0] ? rows[0].seed : null;
}

// Recursively assert no key named `seed` and no string value equal to the
// persisted seed appear anywhere in the payload.
function assertNoSeedLeak(payload, seedValue, label) {
  const json = JSON.stringify(payload);
  expect(json).not.toContain('"seed"');
  if (seedValue) {
    expect(json).not.toContain(seedValue);
  }
  // Nothing schedule-like either: no future collapse timing/order data.
  expect(json).not.toMatch(/scheduled_at|collapse_rank|scheduledAt|collapseRank/);
  expect(Object.keys(payload)).not.toContain('seed');
  void label;
}

describe('public game responses never expose the cycle seed or future-collapse data', () => {
  test('GET /api/game/state: exact public contract, no seed key, no seed value', async () => {
    const response = await request(app).get('/api/game/state').expect(200);

    expect(Object.keys(response.body).sort()).toEqual([
      'apocalypseId',
      'apocalypsePercent',
      'durationMs',
      'endTime',
      'remainingMs',
      'serverTime',
      'startTime',
      'status'
    ]);

    const seed = await persistedSeed();
    expect(seed).toBeTruthy(); // the seed still exists internally
    assertNoSeedLeak(response.body, seed);
  });

  test('GET /api/game/leaderboard: no seed even with joined participants', async () => {
    await request(app).get('/api/game/state').expect(200); // ensure cycle
    await request(app)
      .post('/api/game/join')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);

    const seed = await persistedSeed();
    const response = await request(app).get('/api/game/leaderboard').expect(200);
    assertNoSeedLeak(response.body, seed);
  });

  test('POST /api/game/join and round trade responses carry no seed', async () => {
    await request(app).get('/api/game/state').expect(200);
    const join = await request(app)
      .post('/api/game/join')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);

    const seed = await persistedSeed();
    assertNoSeedLeak(join.body, seed);

    const cycleId = join.body.data.participant.apocalypseId;
    const buy = await request(app)
      .post('/api/game/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId, coin_id: 1, amount: 10 })
      .expect(201);
    assertNoSeedLeak(buy.body, seed);
  });

  test('GET /api/game/results/:cycleId and /leaderboards/recent carry no seed for settled cycles', async () => {
    // Drive one full lifecycle: active cycle, a join, then settle it by
    // reconciling past its end via the public state endpoint.
    const t0 = new Date('2026-08-20T10:07:00.000Z');
    const gameCycleService = require('../game/gameCycleService');
    await gameCycleService.reconcileCycle({ now: t0 });
    await request(app)
      .post('/api/game/join')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);

    const seed = await persistedSeed();

    // Roll over: freezes, settles, and creates the successor.
    await gameCycleService.getGameState({ now: new Date('2026-08-20T10:31:00.000Z') });

    const results = await request(app).get('/api/game/results/APOC-0001').expect(200);
    assertNoSeedLeak(results.body, seed);

    const recent = await request(app).get('/api/game/leaderboards/recent').expect(200);
    assertNoSeedLeak(recent.body, seed);
  });

  test('the settlement-busy 409 error never embeds internal failure text (no seed/channel leak)', async () => {
    // A failing reconcileCycle over a stuck SETTLING cycle must surface a
    // generic lifecycle message, never the internal error text (which can
    // carry internals such as seeds on some failure paths).
    const marker = 'marker-secret-3cf1c63ae4d5b38047e9028d88f7500b';
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status, settlement_started_at)
       VALUES ('APOC-0001', $1, now() - interval '30 minutes', now(), 1800000, 'SETTLING', now())`,
      [marker]
    );

    let svc;
    jest.isolateModules(() => {
      jest.doMock('../game/gameCycleService', () => ({
        reconcileCycle: jest.fn().mockRejectedValue(new Error(`internal failure leaking ${marker}`)),
        deriveProgress: jest.fn()
      }));
      svc = require('../game/gameResultsService');
    });

    try {
      await expect(svc.getLiveLeaderboard({})).rejects.toMatchObject({
        name: 'GameResultsError',
        status: 409
      });
      await svc.getLiveLeaderboard({}).catch((err) => {
        expect(err.message).not.toContain(marker);
        expect(err.message).not.toContain('internal failure');
      });
    } finally {
      jest.dontMock('../game/gameCycleService');
    }
  });
});
