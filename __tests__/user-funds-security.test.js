// Persistent-market product rule: ordinary-player self-funding is RETIRED.
// PATCH /api/users/:user_id/funds still requires authentication (401 for
// anonymous callers), but every authenticated ordinary player — including the
// account owner — is denied with 403 and legacy `users.funds` never changes.
// There is no admin role, so no caller may mutate funds through the API at
// all; the persistent economy (server-owned accounts) is the only writable
// gameplay cash. The route is retained so previously deployed frontends get a
// clean, safe denial instead of a 404. The model-level guarded UPDATE keeps
// its atomic non-negative invariant for any internal/future callers.
//
// jest.setup.js reseeds the disposable test database before every test;
// seeded users are ids 1 (john_doe) and 2 (jane_smith) with £1,000 each.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const jwt = require('jsonwebtoken');
const gameRoundService = require('../game/gameRoundService');

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET);
}

async function fundsOf(userId) {
  const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [userId]);
  return parseFloat(rows[0].funds);
}

describe('PATCH /api/users/:user_id/funds security (self-funding retired)', () => {
  test('anonymous callers are denied (401)', async () => {
    await request(app).patch('/api/users/1/funds').send({ amount: 500 }).expect(401);
    expect(await fundsOf(1)).toBe(1000);
  });

  test('an authenticated caller cannot mutate another user\'s funds (403) and the target is untouched', async () => {
    const response = await request(app)
      .patch('/api/users/2/funds')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ amount: 500 });

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
    expect(await fundsOf(2)).toBe(1000);
    expect(await fundsOf(1)).toBe(1000);
  });

  test('the owner can no longer adjust their own funds (403) and funds are unchanged', async () => {
    const response = await request(app)
      .patch('/api/users/1/funds')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ amount: 250 });

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
    expect(response.body.msg).toBe('Self-funding is retired: funds are managed by the game economy');
    expect(await fundsOf(1)).toBe(1000);
  });

  test('a debit attempt is denied (403) with funds unchanged', async () => {
    const response = await request(app)
      .patch('/api/users/1/funds')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ amount: -2000 });

    expect(response.status).toBe(403);
    expect(await fundsOf(1)).toBe(1000);
  });

  test('denied funds attempts never touch game round cash', async () => {
    const participant = await gameRoundService.joinRound({ userId: 1 });
    expect(participant.currentCash).toBe(10000); // #17 authoritative round cash

    await request(app)
      .patch('/api/users/1/funds')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ amount: 500 })
      .expect(403);

    expect(await fundsOf(1)).toBe(1000);
    const { rows } = await db.query(
      'SELECT current_cash FROM apocalypse_participants WHERE participant_id = $1',
      [participant.participantId]
    );
    expect(parseFloat(rows[0].current_cash)).toBe(10000);
  });

  test('the model enforces the non-negative balance atomically (no read-then-write window)', async () => {
    // Deterministic unit-level proof: the guarded UPDATE itself rejects the
    // overdraw — correctness no longer depends on a separate read winning a
    // race against a concurrent debit. The model keeps this invariant for
    // internal/future callers even though API self-funding is retired.
    const usersModel = require('../models/users.model');
    await expect(usersModel.updateUserFunds(1, -2000)).rejects.toThrow('Insufficient funds');
    expect(await fundsOf(1)).toBe(1000);

    // Two truly concurrent model-level debits: exactly one lands.
    const results = await Promise.allSettled([
      usersModel.updateUserFunds(1, -800),
      usersModel.updateUserFunds(1, -800)
    ]);
    const outcomes = results.map((r) => r.status).sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    expect(await fundsOf(1)).toBe(200);
  });
});
