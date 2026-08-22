// Milestone 1 hardening: PATCH /api/users/:user_id/funds is a self-service
// endpoint — it requires authentication AND the authenticated user must own
// the path user_id (there is no admin role, so no cross-user funds control
// exists at all). The mutation is concurrency-safe: the non-negative guard
// lives inside a single atomic UPDATE, so concurrent debits can never drive
// funds negative. Legacy account funds stay fully isolated from game round
// cash (apocalypse_participants.current_cash is never touched).
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

describe('PATCH /api/users/:user_id/funds security', () => {
  test('anonymous callers are denied (401)', async () => {
    await request(app).patch('/api/users/1/funds').send({ amount: 500 }).expect(401);
    expect(await fundsOf(1)).toBe(1000);
  });

  test('a caller cannot mutate another user\'s funds (403) and the target is untouched', async () => {
    const response = await request(app)
      .patch('/api/users/2/funds')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ amount: 500 });

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
    expect(await fundsOf(2)).toBe(1000);
    expect(await fundsOf(1)).toBe(1000);
  });

  test('the owner can still adjust their own funds', async () => {
    const response = await request(app)
      .patch('/api/users/1/funds')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ amount: 250 });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(parseFloat(response.body.user.funds)).toBe(1250);
  });

  test('a debit that would overdraw is rejected atomically (400) with funds unchanged', async () => {
    const response = await request(app)
      .patch('/api/users/1/funds')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ amount: -2000 });

    expect(response.status).toBe(400);
    expect(response.body.msg).toBe('Insufficient funds');
    expect(await fundsOf(1)).toBe(1000);
  });

  test('concurrent debits cannot overdraw: exactly one of two £800 debits lands', async () => {
    const results = await Promise.allSettled([
      request(app).patch('/api/users/1/funds').set('Authorization', `Bearer ${tokenFor(1)}`).send({ amount: -800 }),
      request(app).patch('/api/users/1/funds').set('Authorization', `Bearer ${tokenFor(1)}`).send({ amount: -800 })
    ]);

    const statuses = results.map((r) => r.status === 'fulfilled' ? r.value.status : 500).sort();
    expect(statuses).toEqual([200, 400]);
    expect(await fundsOf(1)).toBe(200);
  });

  test('legacy funds changes never touch game round cash', async () => {
    const participant = await gameRoundService.joinRound({ userId: 1 });
    expect(participant.currentCash).toBe(10000); // #17 authoritative round cash

    await request(app)
      .patch('/api/users/1/funds')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ amount: 500 })
      .expect(200);

    const { rows } = await db.query(
      'SELECT current_cash FROM apocalypse_participants WHERE participant_id = $1',
      [participant.participantId]
    );
    expect(parseFloat(rows[0].current_cash)).toBe(10000);
  });

  test('the model enforces the non-negative balance atomically (no read-then-write window)', async () => {
    // Deterministic unit-level proof: the guarded UPDATE itself rejects the
    // overdraw — correctness no longer depends on a separate read winning a
    // race against a concurrent debit.
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
