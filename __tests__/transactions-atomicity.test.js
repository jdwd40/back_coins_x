// Milestone 1 hardening: legacy processBuyTransaction/processSellTransaction
// must run on ONE acquired pg client that owns BEGIN, validation/SELECT FOR
// UPDATE, mutation, ledger insert, COMMIT/ROLLBACK and final release. The old
// implementation issued every statement through db.query on the POOL, so
// BEGIN, the FOR UPDATE read, the writes and the COMMIT/ROLLBACK each landed
// on arbitrary pooled connections: the row locks were illusory and ROLLBACK
// was a no-op on the wrong connection. These tests prove atomicity,
// anti-oversell/anti-overspend under concurrency, and ledger coherence
// against the disposable test database. The game wallet (apocalypse_* round
// state) is never touched by legacy trades.
//
// jest.setup.js reseeds the disposable test database before every test;
// seeded users are ids 1-2 with £1,000 each. Coin 1 is the cheapest seeded
// coin (£0.10).

jest.setTimeout(45000);

const db = require('../db/connection');
const {
  processBuyTransaction,
  processSellTransaction
} = require('../models/transactions.model');
const { selectCoinRawById } = require('../models/coins.model');

const COIN_ID = 1;

async function fundsOf(userId) {
  const { rows } = await db.query('SELECT funds FROM users WHERE user_id = $1', [userId]);
  return parseFloat(rows[0].funds);
}

async function portfolioQuantity(userId, coinId) {
  const { rows } = await db.query(
    'SELECT quantity FROM portfolios WHERE user_id = $1 AND coin_id = $2',
    [userId, coinId]
  );
  return rows.length === 0 ? null : parseFloat(rows[0].quantity);
}

async function legacyLedger(userId) {
  const { rows } = await db.query(
    'SELECT type, quantity, price, total_amount FROM transactions WHERE user_id = $1 AND coin_id = $2 ORDER BY transaction_id',
    [userId, COIN_ID]
  );
  return rows.map((r) => ({
    type: r.type,
    quantity: parseFloat(r.quantity),
    price: parseFloat(r.price),
    total: parseFloat(r.total_amount)
  }));
}

async function coinPrice() {
  const coin = await selectCoinRawById(COIN_ID);
  return parseFloat(coin.current_price);
}

describe('legacy buy/sell atomicity (single-client transaction)', () => {
  test('exactly one acquired client owns BEGIN, validation, mutation, ledger, COMMIT and release', async () => {
    // Mechanism probe (Milestone 1 contract): the whole buy must run on ONE
    // pooled client — never as loose pool queries. With the pool's LIFO idle
    // reuse, loose db.query('BEGIN') + db.query(...'SELECT ... FOR UPDATE')
    // only accidentally share a connection single-threaded and interleave
    // across connections under concurrency, making the row locks and the
    // ROLLBACK illusory.
    const realGetClient = db.getClient;
    const clientStatements = [];
    let releaseCount = 0;
    const getClientSpy = jest.spyOn(db, 'getClient').mockImplementation(async () => {
      const client = await realGetClient();
      const realQuery = client.query.bind(client);
      const realRelease = client.release.bind(client);
      client.query = (...args) => {
        clientStatements.push(String(args[0]));
        return realQuery(...args);
      };
      client.release = (...args) => {
        releaseCount += 1;
        return realRelease(...args);
      };
      return client;
    });
    const poolSpy = jest.spyOn(db, 'query');

    const price = await coinPrice();
    let getClientCalls;
    let poolStatements;
    try {
      await processBuyTransaction(1, COIN_ID, 5, price);
      await expect(processBuyTransaction(1, COIN_ID, 5, price)).resolves.toBeTruthy();
    } finally {
      // Capture BEFORE mockRestore: restore resets the mock's call registry.
      getClientCalls = getClientSpy.mock.calls.length;
      poolStatements = poolSpy.mock.calls.map((c) => String(c[0]));
      getClientSpy.mockRestore();
      poolSpy.mockRestore();
    }

    // Exactly one client acquired and released per operation (two ops above).
    expect(getClientCalls).toBe(2);
    expect(releaseCount).toBe(2);

    // The transaction lifecycle and the locked validation read ran on the
    // acquired client, in order: BEGIN -> funds SELECT FOR UPDATE -> funds
    // UPDATE -> ledger INSERT -> portfolio write -> COMMIT.
    // (Split on COMMIT boundaries: both buys record identical shapes.)
    const firstTxn = clientStatements.slice(0, clientStatements.indexOf('COMMIT') + 1);
    expect(firstTxn[0]).toBe('BEGIN');
    expect(firstTxn.some((s) => /SELECT funds FROM users WHERE user_id = \$1 FOR UPDATE/.test(s))).toBe(true);
    expect(firstTxn.some((s) => /UPDATE users SET funds = funds - \$1/.test(s))).toBe(true);
    expect(firstTxn.some((s) => /INSERT INTO transactions/.test(s))).toBe(true);
    expect(firstTxn.some((s) => /portfolios/.test(s))).toBe(true);
    expect(firstTxn[firstTxn.length - 1]).toBe('COMMIT');

    // No transactional statement may bypass the acquired client via the pool.
    expect(poolStatements.filter((s) => /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(s))).toEqual([]);
  });

  test('a mid-transaction failure rolls back funds, ledger and portfolio writes', async () => {
    // Sabotage the portfolio write for this coin only: the funds debit and
    // ledger insert have already happened by then, so a partial commit is
    // directly observable. The reseed before the next test drops the trigger.
    await db.query(`
      CREATE OR REPLACE FUNCTION test_sabotage_portfolio_write() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'test-forced portfolio write failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.query(`
      CREATE TRIGGER test_sabotage_portfolio_write
      BEFORE INSERT OR UPDATE ON portfolios
      FOR EACH ROW WHEN (NEW.coin_id = ${COIN_ID})
      EXECUTE FUNCTION test_sabotage_portfolio_write();
    `);

    const price = await coinPrice();
    await expect(processBuyTransaction(1, COIN_ID, 10, price))
      .rejects.toThrow('test-forced portfolio write failure');

    expect(await fundsOf(1)).toBe(1000); // debit rolled back
    expect(await legacyLedger(1)).toEqual([]); // ledger insert rolled back
    expect(await portfolioQuantity(1, COIN_ID)).toBeNull(); // no holding created
  });

  test('concurrent sells of the same holding cannot oversell', async () => {
    const price = await coinPrice();
    await db.query(
      'INSERT INTO portfolios (user_id, coin_id, quantity) VALUES (1, $1, 2)',
      [COIN_ID]
    );

    const results = await Promise.allSettled([
      processSellTransaction(1, COIN_ID, 2, price),
      processSellTransaction(1, COIN_ID, 2, price)
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe('Insufficient coins in portfolio');

    expect(await portfolioQuantity(1, COIN_ID)).toBe(0); // never negative
    expect(await fundsOf(1)).toBe(Math.round((1000 + 2 * price) * 100) / 100); // exactly one sale credited
    expect(await legacyLedger(1)).toHaveLength(1);
  });

  test('concurrent buys cannot overspend the funds row lock', async () => {
    const price = await coinPrice();
    const amount = Math.ceil(600 / price); // each buy costs just over half the £1,000

    const results = await Promise.allSettled([
      processBuyTransaction(1, COIN_ID, amount, price),
      processBuyTransaction(1, COIN_ID, amount, price)
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe('Insufficient funds');

    const spent = Math.round(amount * price * 100) / 100;
    expect(await fundsOf(1)).toBe(Math.round((1000 - spent) * 100) / 100);
    expect(await portfolioQuantity(1, COIN_ID)).toBe(amount);
    expect(await legacyLedger(1)).toHaveLength(1);
  });

  test('after mixed operations, funds + portfolio + ledger stay mutually coherent', async () => {
    const price = await coinPrice();
    const buy1 = 100;
    const buy2 = 50;
    const sell1 = 30;

    await processBuyTransaction(1, COIN_ID, buy1, price);
    await processBuyTransaction(1, COIN_ID, buy2, price);
    await processSellTransaction(1, COIN_ID, sell1, price);

    const ledger = await legacyLedger(1);
    expect(ledger).toHaveLength(3);

    const ledgerQuantity = ledger.reduce((sum, t) => sum + (t.type === 'BUY' ? t.quantity : -t.quantity), 0);
    const ledgerCash = ledger.reduce((sum, t) => sum + (t.type === 'BUY' ? -t.total : t.total), 0);

    expect(await portfolioQuantity(1, COIN_ID)).toBe(ledgerQuantity);
    expect(await fundsOf(1)).toBe(Math.round((1000 + ledgerCash) * 100) / 100);
  });

  test('legacy trades never touch the game wallet (apocalypse round state)', async () => {
    const price = await coinPrice();
    await processBuyTransaction(1, COIN_ID, 5, price);

    const { rows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM apocalypse_transactions WHERE user_id = 1) AS round_tx,
         (SELECT count(*)::int FROM apocalypse_participants WHERE user_id = 1) AS participants,
         (SELECT count(*)::int FROM apocalypse_holdings WHERE user_id = 1) AS holdings`
    );
    expect(rows[0]).toEqual({ round_tx: 0, participants: 0, holdings: 0 });
  });
});
