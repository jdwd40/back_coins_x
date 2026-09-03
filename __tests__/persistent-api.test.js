// Persistent-market Stage 6: the persistent API surface against the REAL
// disposable test database — authenticated persistent trades at the
// server-locked price, the caller's persistent account read, auth
// boundaries, and registration provisioning idempotency.
//
// Every mutating test passes through the repository's disposable test DB
// guard (jest.setup.js also reseeds before each test).

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const persistentWorld = require('../game/persistentWorld');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

const WORLD_SEED = 'stage6-api-world-seed';

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
    epochStartedAt: new Date('2026-08-31T00:00:00.000Z')
  });
}

describe('Stage 6: persistent trade API', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
  });

  test('an authenticated buy executes at the server-locked price and provisions the account exactly once', async () => {
    const res = await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 5 })
      .expect(201);

    expect(res.body.status).toBe('success');
    expect(res.body.data.transaction.type).toBe('BUY');
    expect(res.body.data.transaction.price).toBe(10); // server-owned, not client input
    expect(res.body.data.transaction.totalAmount).toBe(50);
    expect(res.body.data.account.cash).toBe(9950);
    expect(res.body.data.account.startingCash).toBe(10000);

    // Redaction: no world seed / Director internals in the payload.
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain(WORLD_SEED);
    expect(payload).not.toContain('regimeIndex');
  });

  test('an authenticated sell credits cash at the server-locked price', async () => {
    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 5 })
      .expect(201);

    const res = await request(app)
      .post('/api/persistent/trades/sell')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 2 })
      .expect(201);

    expect(res.body.data.transaction.type).toBe('SELL');
    expect(res.body.data.transaction.totalAmount).toBe(20);
    expect(res.body.data.account.cash).toBe(9970);
  });

  test('unauthenticated calls are rejected (401) and write nothing', async () => {
    await request(app)
      .post('/api/persistent/trades/buy')
      .send({ coin_id: 1, quantity: 5 })
      .expect(401);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM persistent_accounts');
    expect(rows[0].n).toBe(0);
  });

  test('the caller can only ever act on their own account (the body cannot pick another user)', async () => {
    // user 2 provisions and funds their own account
    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(2)}`)
      .send({ coin_id: 1, quantity: 1 })
      .expect(201);

    // user 1's request carries user_id: 2 in the body — the API ignores it
    // (the authenticated token is the account owner).
    const res = await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ user_id: 2, coin_id: 1, quantity: 1 })
      .expect(201);
    expect(res.body.data.account.userId).toBe(1);

    const { rows } = await db.query(
      'SELECT user_id, cash FROM persistent_accounts ORDER BY user_id'
    );
    expect(rows.map((r) => r.user_id)).toEqual([1, 2]);
    expect(parseFloat(rows[0].cash)).toBe(9990); // user 1 spent their own £10
    expect(parseFloat(rows[1].cash)).toBe(9990); // user 2 spent their own £10
  });

  test('validation failures are 400 domain errors, not 500s', async () => {
    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 0 })
      .expect(400);
    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 999, quantity: 1 })
      .expect(404);
    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 1001 }) // £10,010 > £10,000
      .expect(400);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM persistent_transactions');
    expect(rows[0].n).toBe(0);
  });

  test('GET /api/persistent/account: unprovisioned reads provisioned:false; after a trade it reads the live state', async () => {
    const before = await request(app)
      .get('/api/persistent/account')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);
    expect(before.body.data.provisioned).toBe(false);

    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 5 })
      .expect(201);

    const after = await request(app)
      .get('/api/persistent/account')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);
    expect(after.body.data.provisioned).toBe(true);
    expect(after.body.data.cash).toBe(9950);
    expect(after.body.data.wealth).toBe(10000);
    expect(after.body.data.holdings.length).toBe(1);
    expect(after.body.data.holdings[0].coinId).toBe(1);
  });

  test('holdings carry server-owned position economics (average entry, live value, unrealized P&L)', async () => {
    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 5 })
      .expect(201);

    // The market moves; the account read reprices the holding server-side.
    await db.query('UPDATE coins SET current_price = 12 WHERE coin_id = 1');

    const res = await request(app)
      .get('/api/persistent/account')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);
    const holding = res.body.data.holdings[0];
    expect(holding.costBasis).toBe(50);
    expect(holding.averageEntryPrice).toBe(10);
    expect(holding.currentPrice).toBe(12);
    expect(holding.currentValue).toBe(60);
    expect(holding.unrealizedPnl).toBe(10);
    expect(holding.unrealizedPnlPct).toBe(20);
    expect(res.body.data.holdingsValue).toBe(60);
    expect(res.body.data.wealth).toBe(10010); // 9950 cash + 60 live value
  });
});

describe('Stage 6: persistent transaction history API', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
    await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
  });

  test('unauthenticated reads are rejected (401)', async () => {
    await request(app).get('/api/persistent/transactions').expect(401);
  });

  test('an unprovisioned account reads as an empty history, never an error', async () => {
    const res = await request(app)
      .get('/api/persistent/transactions')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);
    expect(res.body.data.provisioned).toBe(false);
    expect(res.body.data.transactions).toEqual([]);
  });

  test('the caller reads only their own ledger, newest first, with public fields only', async () => {
    // user 2's trades are invisible to user 1
    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(2)}`)
      .send({ coin_id: 1, quantity: 1 })
      .expect(201);

    await request(app)
      .post('/api/persistent/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 5 })
      .expect(201);
    await request(app)
      .post('/api/persistent/trades/sell')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ coin_id: 1, quantity: 2 })
      .expect(201);

    const res = await request(app)
      .get('/api/persistent/transactions')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);

    expect(res.body.data.provisioned).toBe(true);
    expect(res.body.data.transactions.length).toBe(2);
    // newest first
    expect(res.body.data.transactions[0].type).toBe('SELL');
    expect(res.body.data.transactions[1].type).toBe('BUY');
    const sell = res.body.data.transactions[0];
    expect(sell.coinId).toBe(1);
    expect(typeof sell.symbol).toBe('string');
    expect(sell.quantity).toBe(2);
    expect(sell.price).toBe(10); // the server-locked execution price
    expect(sell.totalAmount).toBe(20);
    expect(typeof sell.createdAt).toBe('string');

    // Redaction: no world seed / Director internals in the payload.
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain(WORLD_SEED);
    expect(payload).not.toContain('regimeIndex');
  });

  test('the history read is bounded: limit validates loudly and caps the rows', async () => {
    for (const quantity of [1, 1, 1]) {
      await request(app)
        .post('/api/persistent/trades/buy')
        .set('Authorization', `Bearer ${tokenFor(1)}`)
        .send({ coin_id: 1, quantity })
        .expect(201);
    }

    const limited = await request(app)
      .get('/api/persistent/transactions?limit=1')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);
    expect(limited.body.data.transactions.length).toBe(1);

    const full = await request(app)
      .get('/api/persistent/transactions')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .expect(200);
    expect(full.body.data.transactions.length).toBe(3);

    for (const bad of ['0', 'abc', '101', '-3', '1.5']) {
      await request(app)
        .get(`/api/persistent/transactions?limit=${bad}`)
        .set('Authorization', `Bearer ${tokenFor(1)}`)
        .expect(400);
    }
  });
});

describe('Stage 6: registration provisions the persistent account idempotently', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
  });

  test('registering a new user provisions exactly one persistent account with exactly £10,000', async () => {
    const res = await request(app)
      .post('/api/users/register')
      .send({ username: 'persistent_newbie', email: 'newbie@example.com', password: 'password123' })
      .expect(201);
    const newUserId = res.body.user && res.body.user.user_id;

    const { rows } = await db.query(
      'SELECT starting_cash, cash FROM persistent_accounts WHERE user_id = $1',
      [newUserId]
    );
    expect(rows.length).toBe(1);
    expect(parseFloat(rows[0].starting_cash)).toBe(10000);
    expect(parseFloat(rows[0].cash)).toBe(10000);
  });
});
