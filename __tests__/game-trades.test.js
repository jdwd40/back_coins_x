// Core 4: round trade API — POST /api/game/trades/buy and /trades/sell.
// Proves: explicit cycleId requirement and stale/unknown/malformed ID
// rejection before any write; atomic buys (insufficient round cash rejected
// with full rollback); atomic sells (oversell rejected with full rollback);
// server-side pricing (client prices ignored); participant ownership via the
// auth token; and total isolation from legacy users.funds / portfolios /
// transactions (both directions). Issue #17: every registered user always
// has a current-cycle participant (no explicit join requirement), so the
// old no-participant 409 is unreachable for registered users.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound } = require('../game/gameRoundService');

const DURATION_MS = 30 * 60 * 1000;
// API tests run at the real wall clock, which may sit inside the Core 3
// collapse window (final 30%) of a default 30-minute cycle. A 7-day cycle
// keeps every coin alive for the whole test regardless of when it runs.
const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function userFunds(userId) {
  const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [userId]);
  return parseFloat(rows[0].funds);
}

async function roundCash(participantId) {
  const { rows } = await db.query(
    'SELECT current_cash FROM apocalypse_participants WHERE participant_id = $1',
    [participantId]
  );
  return parseFloat(rows[0].current_cash);
}

async function legacyRowCounts(userId) {
  const pf = await db.query('SELECT count(*)::int AS n FROM portfolios WHERE user_id = $1', [userId]);
  const tx = await db.query('SELECT count(*)::int AS n FROM transactions WHERE user_id = $1', [userId]);
  return { portfolios: pf.rows[0].n, transactions: tx.rows[0].n };
}

// Create a wall-clock cycle (the API operates at real now), join user 1,
// and return { cycle, participant }.
async function setupJoinedRound() {
  const cycle = await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
  const participant = await joinRound({ userId: 1, now: new Date() });
  return { cycle, participant };
}

describe('Core 4: round trades', () => {
  test('trade endpoints require authentication', async () => {
    await request(app).post('/api/game/trades/buy').send({ cycleId: 'APOC-0001', coin_id: 1, amount: 1 }).expect(401);
    await request(app).post('/api/game/trades/sell').send({ cycleId: 'APOC-0001', coin_id: 1, amount: 1 }).expect(401);
  });

  test('buy debits round cash, upserts the round holding and appends a round transaction at the server price', async () => {
    const { cycle, participant } = await setupJoinedRound();
    const { rows: coinRows } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id LIMIT 1');
    const coin = coinRows[0];
    const price = parseFloat(coin.current_price);

    const response = await request(app)
      .post('/api/game/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coin.coin_id, amount: 10 })
      .expect(201);

    expect(response.body.status).toBe('success');
    const expectedTotal = Math.round(10 * price * 100) / 100;
    expect(response.body.data.transaction).toMatchObject({
      type: 'BUY', coinId: coin.coin_id, quantity: 10, price, totalAmount: expectedTotal
    });

    expect(await roundCash(participant.participantId)).toBeCloseTo(10000 - expectedTotal, 2);

    const { rows: holdings } = await db.query(
      'SELECT * FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
      [participant.participantId, coin.coin_id]
    );
    expect(holdings).toHaveLength(1);
    expect(parseFloat(holdings[0].quantity)).toBe(10);
    expect(holdings[0].cycle_id).toBe(cycle.cycle_id);
    expect(holdings[0].user_id).toBe(1);

    const { rows: txs } = await db.query(
      'SELECT * FROM apocalypse_transactions WHERE participant_id = $1',
      [participant.participantId]
    );
    expect(txs).toHaveLength(1);
    expect(txs[0].type).toBe('BUY');
    expect(parseFloat(txs[0].price)).toBeCloseTo(price, 2);
    expect(parseFloat(txs[0].total_amount)).toBeCloseTo(expectedTotal, 2);
    expect(txs[0].cycle_id).toBe(cycle.cycle_id);
    expect(txs[0].user_id).toBe(1);

    // Legacy account state completely untouched.
    expect(await userFunds(1)).toBe(1000); // seed default
    expect(await legacyRowCounts(1)).toEqual({ portfolios: 0, transactions: 0 });
  });

  test('a second buy of the same coin increments the single holding row (no duplicate logical holding)', async () => {
    const { cycle, participant } = await setupJoinedRound();
    const { rows: coinRows } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 1');
    const coinId = coinRows[0].coin_id;
    const auth = `Bearer ${tokenFor(1)}`;

    await request(app).post('/api/game/trades/buy').set('Authorization', auth)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coinId, amount: 4 }).expect(201);
    await request(app).post('/api/game/trades/buy').set('Authorization', auth)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coinId, amount: 6 }).expect(201);

    const { rows } = await db.query(
      'SELECT * FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
      [participant.participantId, coinId]
    );
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].quantity)).toBe(10);
  });

  test('buy with insufficient ROUND cash is rejected atomically even when users.funds could cover it', async () => {
    const { cycle, participant } = await setupJoinedRound();
    await db.query('UPDATE users SET funds = 1000000.00 WHERE user_id = 1'); // legacy wealth must not help
    const { rows: coinRows } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 1');
    const coinId = coinRows[0].coin_id;
    await db.query('UPDATE coins SET current_price = 100.00 WHERE coin_id = $1', [coinId]);

    const response = await request(app)
      .post('/api/game/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coinId, amount: 200 }) // £20,000 > £10,000 round cash
      .expect(400);

    expect(response.body.message).toMatch(/Insufficient round cash/);
    // Full rollback: no cash moved, no holding, no ledger row.
    expect(await roundCash(participant.participantId)).toBe(10000);
    const { rows: h } = await db.query('SELECT count(*)::int AS n FROM apocalypse_holdings WHERE participant_id = $1', [participant.participantId]);
    const { rows: t } = await db.query('SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1', [participant.participantId]);
    expect(h[0].n).toBe(0);
    expect(t[0].n).toBe(0);
    expect(await userFunds(1)).toBe(1000000);
  });

  test('sell credits round cash at the server price and decrements the round holding', async () => {
    const { cycle, participant } = await setupJoinedRound();
    const { rows: coinRows } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id LIMIT 1');
    const coin = coinRows[0];
    const price = parseFloat(coin.current_price);
    const auth = `Bearer ${tokenFor(1)}`;

    await request(app).post('/api/game/trades/buy').set('Authorization', auth)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coin.coin_id, amount: 10 }).expect(201);
    const cashAfterBuy = await roundCash(participant.participantId);

    const response = await request(app)
      .post('/api/game/trades/sell')
      .set('Authorization', auth)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coin.coin_id, amount: 4 })
      .expect(201);

    const expectedCredit = Math.round(4 * price * 100) / 100;
    expect(response.body.data.transaction.type).toBe('SELL');
    expect(response.body.data.transaction.totalAmount).toBeCloseTo(expectedCredit, 2);
    expect(await roundCash(participant.participantId)).toBeCloseTo(cashAfterBuy + expectedCredit, 2);

    const { rows: holdings } = await db.query(
      'SELECT quantity FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
      [participant.participantId, coin.coin_id]
    );
    expect(parseFloat(holdings[0].quantity)).toBe(6);

    expect(await userFunds(1)).toBe(1000);
    expect(await legacyRowCounts(1)).toEqual({ portfolios: 0, transactions: 0 });
  });

  test('oversell is rejected before any write: holding, cash and ledger all unchanged', async () => {
    const { cycle, participant } = await setupJoinedRound();
    const { rows: coinRows } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 1');
    const coinId = coinRows[0].coin_id;
    const auth = `Bearer ${tokenFor(1)}`;

    await request(app).post('/api/game/trades/buy').set('Authorization', auth)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coinId, amount: 5 }).expect(201);
    const cashBefore = await roundCash(participant.participantId);

    const response = await request(app)
      .post('/api/game/trades/sell')
      .set('Authorization', auth)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coinId, amount: 6 })
      .expect(400);

    expect(response.body.message).toMatch(/Insufficient round holdings/);
    expect(await roundCash(participant.participantId)).toBe(cashBefore);
    const { rows: holdings } = await db.query(
      'SELECT quantity FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
      [participant.participantId, coinId]
    );
    expect(parseFloat(holdings[0].quantity)).toBe(5);
    const { rows: txs } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1 AND type = 'SELL'`,
      [participant.participantId]
    );
    expect(txs[0].n).toBe(0);
  });

  test('selling a coin never held in this cycle is rejected', async () => {
    const { cycle } = await setupJoinedRound();
    const response = await request(app)
      .post('/api/game/trades/sell')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId: cycle.apocalypse_id, coin_id: 1, amount: 1 })
      .expect(400);
    expect(response.body.message).toMatch(/Insufficient round holdings/);
  });

  test('a client-supplied price is ignored: execution uses the authoritative DB price', async () => {
    const { cycle, participant } = await setupJoinedRound();
    const { rows: coinRows } = await db.query('SELECT coin_id, current_price FROM coins ORDER BY coin_id LIMIT 1');
    const coin = coinRows[0];
    const price = parseFloat(coin.current_price);

    const response = await request(app)
      .post('/api/game/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId: cycle.apocalypse_id, coin_id: coin.coin_id, amount: 2, price: 0.01, price_at_transaction: 0.01 })
      .expect(201);

    expect(response.body.data.transaction.price).toBe(price);
    expect(response.body.data.transaction.totalAmount).toBeCloseTo(Math.round(2 * price * 100) / 100, 2);
    expect(await roundCash(participant.participantId)).toBeCloseTo(10000 - Math.round(2 * price * 100) / 100, 2);
  });

  test('no explicit join needed: a registered user trades immediately against their server-owned participant (#17)', async () => {
    const cycle = await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
    // No join call at all — cycle reconciliation auto-initialized user 1.
    const response = await request(app)
      .post('/api/game/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId: cycle.apocalypse_id, coin_id: 1, amount: 1 })
      .expect(201);
    expect(response.body.data.participant.userId).toBe(1);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants p
       JOIN apocalypse_cycles ac ON ac.cycle_id = p.cycle_id
       WHERE ac.apocalypse_id = $1 AND p.user_id = 1`,
      [cycle.apocalypse_id]
    );
    expect(rows[0].n).toBe(1);
  });

  test('stale prior apocalypse ID is rejected before any write', async () => {
    // Default 30-minute cycle so a +31 minute reconcile rolls it over.
    const cycle = await reconcileCycle({ now: new Date() });
    const participant = await joinRound({ userId: 1, now: new Date() });
    // Roll the cycle over: the old apocalypse_id is now COMPLETED history.
    await reconcileCycle({ now: new Date(Date.now() + DURATION_MS + 1000) });

    const response = await request(app)
      .post('/api/game/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId: cycle.apocalypse_id, coin_id: 1, amount: 1 })
      .expect(409);

    expect(response.body.message).toMatch(/no longer active/);
    expect(await roundCash(participant.participantId)).toBe(10000);
    const { rows: t } = await db.query('SELECT count(*)::int AS n FROM apocalypse_transactions');
    expect(t[0].n).toBe(0);
  });

  test('nonexistent / future apocalypse IDs return 404 and write nothing', async () => {
    await setupJoinedRound();
    const response = await request(app)
      .post('/api/game/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId: 'APOC-9999', coin_id: 1, amount: 1 })
      .expect(404);
    expect(response.body.message).toMatch(/Unknown apocalypse cycle/);
  });

  test('malformed cycleId and invalid quantities/coins are rejected with 400', async () => {
    const { cycle } = await setupJoinedRound();
    const auth = `Bearer ${tokenFor(1)}`;
    await request(app).post('/api/game/trades/buy').set('Authorization', auth)
      .send({ cycleId: 'not-a-cycle', coin_id: 1, amount: 1 }).expect(400);
    await request(app).post('/api/game/trades/buy').set('Authorization', auth)
      .send({ coin_id: 1, amount: 1 }).expect(400); // missing cycleId
    for (const bad of [0, -3, NaN, 'abc', Infinity]) {
      await request(app).post('/api/game/trades/buy').set('Authorization', auth)
        .send({ cycleId: cycle.apocalypse_id, coin_id: 1, amount: bad }).expect(400);
    }
    await request(app).post('/api/game/trades/buy').set('Authorization', auth)
      .send({ cycleId: cycle.apocalypse_id, coin_id: 99999, amount: 1 }).expect(404);
  });

  test("another user's participant cannot be traded against: the token identity is the only ownership", async () => {
    const { cycle, participant } = await setupJoinedRound(); // user 1 joined
    // A user_id in the body is ignored: the token (user 2) owns the trade.
    // User 2's own auto-initialized participant (#17) has no holdings, so
    // the sell is rejected as oversell against USER 2 — user 1 untouched.
    const response = await request(app)
      .post('/api/game/trades/sell')
      .set('Authorization', `Bearer ${tokenFor(2)}`)
      .send({ cycleId: cycle.apocalypse_id, coin_id: 1, amount: 1, user_id: 1 })
      .expect(400);
    expect(response.body.message).toMatch(/Insufficient round holdings/);
    expect(await roundCash(participant.participantId)).toBe(10000);
  });

  test('legacy /api/transactions/buy still works and creates NO round state (both directions isolated)', async () => {
    const { participant } = await setupJoinedRound();
    const { rows: coinRows } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 1');
    const coinId = coinRows[0].coin_id;

    await request(app)
      .post('/api/transactions/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ user_id: 1, coin_id: coinId, amount: 1 })
      .expect(201);

    // Legacy path moved users.funds and legacy tables only.
    expect(await userFunds(1)).toBeLessThan(1000);
    expect((await legacyRowCounts(1)).transactions).toBe(1);
    // Round state completely untouched by the legacy trade.
    expect(await roundCash(participant.participantId)).toBe(10000);
    const { rows: h } = await db.query('SELECT count(*)::int AS n FROM apocalypse_holdings WHERE participant_id = $1', [participant.participantId]);
    const { rows: t } = await db.query('SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1', [participant.participantId]);
    expect(h[0].n).toBe(0);
    expect(t[0].n).toBe(0);
  });
});
