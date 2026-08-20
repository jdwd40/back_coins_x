// Core 4: join-anytime participation — POST /api/game/join and the
// joinRound service. Proves: authentication, identical £1,000 starting cash
// at 1%/50%/95% of the cycle, idempotent repeated joins (same row, nothing
// reset), starting cash never copied from users.funds, and zero leakage into
// legacy users/portfolios/transactions.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound } = require('../game/gameRoundService');
const {
  GAME_STARTING_CASH,
  validateGameStartingCash,
  resolveGameStartingCash
} = require('../game/gameConstants');

const CYCLE_START_MS = new Date('2026-08-20T10:00:00.000Z').getTime();
const DURATION_MS = 30 * 60 * 1000;
const atPercent = (pct) => new Date(CYCLE_START_MS + (DURATION_MS * pct) / 100);

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function createUser(username, funds = 1000) {
  const { rows } = await db.query(
    `INSERT INTO users (username, email, password_hash, funds)
     VALUES ($1, $2, 'x', $3) RETURNING user_id`,
    [username, `${username}@example.com`, funds]
  );
  return rows[0].user_id;
}

async function userFunds(userId) {
  const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [userId]);
  return parseFloat(rows[0].funds);
}

describe('Core 4: game constants', () => {
  test('GAME_STARTING_CASH is exactly 1000 and is the single source', () => {
    expect(GAME_STARTING_CASH).toBe(1000);
    expect(resolveGameStartingCash(undefined)).toBe(1000);
    expect(resolveGameStartingCash('')).toBe(1000);
  });

  test('starting cash validation rejects non-positive, non-finite and non-numeric values', () => {
    for (const bad of [0, -1, -1000, NaN, Infinity, -Infinity, 'abc', '0', '-5']) {
      expect(() => validateGameStartingCash(bad)).toThrow(/GAME_STARTING_CASH/);
      expect(() => resolveGameStartingCash(bad)).toThrow(/GAME_STARTING_CASH/);
    }
    expect(validateGameStartingCash(250)).toBe(250);
    expect(validateGameStartingCash('250')).toBe(250);
  });

  test('rejects fractional pennies instead of silently rounding to 2dp', () => {
    // DECIMAL(18,2) would silently round these; the validator must refuse.
    for (const fractional of [1000.001, 0.001, 99.999, 1.005, 123.456, '1000.001', '0.005']) {
      expect(() => validateGameStartingCash(fractional)).toThrow(/two decimal places/);
      expect(() => resolveGameStartingCash(fractional)).toThrow(/two decimal places/);
    }
  });

  test('accepts values with exact 2-decimal money precision', () => {
    for (const good of [1000, 0.01, 250.5, 999.99, '2500.50', '0.10', 12345678901234.56]) {
      const expected = typeof good === 'string' ? Number(good) : good;
      expect(validateGameStartingCash(good)).toBe(expected);
      expect(resolveGameStartingCash(good)).toBe(expected);
    }
    // Binary floating-point noise from legitimate 2dp arithmetic (0.1 + 0.2)
    // is representation error, not a fractional penny: still accepted.
    expect(validateGameStartingCash(0.1 + 0.2)).toBe(0.1 + 0.2);
  });

  test('a rejected fractional-penny env override cannot create any participant', async () => {
    const userId = await createUser('bad_override_join', 5000);
    await reconcileCycle({ now: atPercent(0.5) });
    const previous = process.env.GAME_STARTING_CASH;
    process.env.GAME_STARTING_CASH = '1000.001';
    try {
      await expect(joinRound({ userId, now: atPercent(10) }))
        .rejects.toThrow(/two decimal places/);
    } finally {
      if (previous === undefined) delete process.env.GAME_STARTING_CASH;
      else process.env.GAME_STARTING_CASH = previous;
    }
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_participants WHERE user_id = $1',
      [userId]
    );
    expect(rows[0].n).toBe(0);
  });

  test('a valid 2dp env override is stored exactly for every participant', async () => {
    const userA = await createUser('override_join_a', 5000);
    const userB = await createUser('override_join_b', 7000);
    await reconcileCycle({ now: atPercent(0.5) });
    const previous = process.env.GAME_STARTING_CASH;
    process.env.GAME_STARTING_CASH = '2500.50';
    try {
      const stateA = await joinRound({ userId: userA, now: atPercent(10) });
      const stateB = await joinRound({ userId: userB, now: atPercent(90) });
      expect(stateA.startingCash).toBe(2500.5);
      expect(stateB.startingCash).toBe(2500.5);
    } finally {
      if (previous === undefined) delete process.env.GAME_STARTING_CASH;
      else process.env.GAME_STARTING_CASH = previous;
    }
    const { rows } = await db.query(
      `SELECT starting_cash, current_cash FROM apocalypse_participants
       WHERE user_id = ANY($1) ORDER BY user_id`,
      [[userA, userB]]
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.starting_cash).toBe('2500.50'); // exact DECIMAL(18,2) storage
      expect(row.current_cash).toBe('2500.50');
    }
  });
});

describe('Core 4: POST /api/game/join', () => {
  test('requires authentication', async () => {
    await request(app).post('/api/game/join').expect(401);
  });

  test('creates a participant with exactly £1,000 and returns round state', async () => {
    const response = await request(app)
      .post('/api/game/join')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);

    expect(response.body.status).toBe('success');
    const p = response.body.data.participant;
    expect(p).toMatchObject({
      participantId: expect.any(Number),
      cycleId: expect.any(Number),
      apocalypseId: expect.stringMatching(/^APOC-\d{4,}$/),
      userId: 1,
      startingCash: 1000,
      currentCash: 1000,
      wealth: 1000,
      peakWealth: 1000,
      status: 'ACTIVE',
      finalCash: null,
      holdings: []
    });
    expect(Number.isNaN(Date.parse(p.joinedAt))).toBe(false);

    const { rows } = await db.query(
      'SELECT * FROM apocalypse_participants WHERE participant_id = $1',
      [p.participantId]
    );
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].starting_cash)).toBe(1000);
    expect(parseFloat(rows[0].current_cash)).toBe(1000);
  });

  test('repeated joins return the same row and never reset anything', async () => {
    const first = await request(app)
      .post('/api/game/join')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);

    // Disturb the participant state; a re-join must not repair or reset it.
    await db.query(
      `UPDATE apocalypse_participants SET current_cash = 250.00, peak_wealth = 1400.00
       WHERE participant_id = $1`,
      [first.body.data.participant.participantId]
    );

    const second = await request(app)
      .post('/api/game/join')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);

    const p1 = first.body.data.participant;
    const p2 = second.body.data.participant;
    expect(p2.participantId).toBe(p1.participantId);
    expect(p2.joinedAt).toBe(p1.joinedAt);
    expect(p2.currentCash).toBe(250);
    expect(p2.peakWealth).toBe(1400);

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_participants WHERE cycle_id = $1 AND user_id = 1',
      [p1.cycleId]
    );
    expect(rows[0].n).toBe(1);
  });

  test('joining never touches users.funds, portfolios or legacy transactions', async () => {
    await db.query('UPDATE users SET funds = 4321.00 WHERE user_id = 1');
    await request(app)
      .post('/api/game/join')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);

    expect(await userFunds(1)).toBe(4321);
    const { rows: pf } = await db.query('SELECT count(*)::int AS n FROM portfolios WHERE user_id = 1');
    const { rows: tx } = await db.query('SELECT count(*)::int AS n FROM transactions WHERE user_id = 1');
    expect(pf[0].n).toBe(0);
    expect(tx[0].n).toBe(0);
  });

  test('GET /api/game/state stays public and read-only alongside the new routes', async () => {
    await request(app).get('/api/game/state').expect(200);
    await request(app).post('/api/game/state').expect(404);
  });
});

describe('Core 4: join-anytime starting cash parity (service, fixed cycle times)', () => {
  test.each([1, 50, 95])('joining at %i%% of the cycle yields exactly £1,000', async (pct) => {
    const userId = await createUser(`join_${pct}pct`, 99999); // funds must NOT be consulted
    await reconcileCycle({ now: atPercent(0.5) }); // creates the 10:00-10:30 cycle

    const state = await joinRound({ userId, now: atPercent(pct) });

    expect(state.startingCash).toBe(1000);
    expect(state.currentCash).toBe(1000);
    expect(state.wealth).toBe(1000);
    expect(state.peakWealth).toBe(1000);
    expect(state.status).toBe('ACTIVE');
    expect(await userFunds(userId)).toBe(99999); // account funds untouched
  });

  test('starting cash is never copied from users.funds', async () => {
    const userId = await createUser('rich_user', 250000);
    await reconcileCycle({ now: atPercent(0.5) });
    const state = await joinRound({ userId, now: atPercent(10) });
    expect(state.startingCash).toBe(GAME_STARTING_CASH);
    expect(state.startingCash).not.toBe(250000);
  });

  test('service-level repeated join is idempotent on the same persisted row', async () => {
    await reconcileCycle({ now: atPercent(0.5) });
    const first = await joinRound({ userId: 1, now: atPercent(10) });
    const second = await joinRound({ userId: 1, now: atPercent(60) });
    expect(second.participantId).toBe(first.participantId);
    expect(second.joinedAt).toBe(first.joinedAt);
    expect(second.startingCash).toBe(1000);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM apocalypse_participants');
    expect(rows[0].n).toBe(1);
  });
});
