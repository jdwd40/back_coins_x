// Core 4 / migration 012: fractional round-trade quantities.
//
// Proves the Crypto Chaos quantity contract end-to-end against the disposable
// test database: fractional buys/sells (0.5, 0.04, 0.004, 1.25, 8-decimal
// dust) execute exactly as requested; excessive precision (> 8 significant
// decimal places) is REJECTED with an explicit precision error, never
// silently rounded; malformed/zero/negative quantities fail before any
// write; overspend/oversell protections stay atomic at fractional sizes; and
// the shared human/bot trade service accepts bot-style floored quantities.
//
// Complements __tests__/game-trades.test.js, which owns the integer-path
// contract (cycle/join/ownership/isolation, zero/negative/NaN rejection).

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound } = require('../game/gameRoundService');

// API tests run at the real wall clock, which may sit inside the Core 3
// collapse window (final 30%) of a default 30-minute cycle. A 7-day cycle
// keeps every coin alive for the whole test regardless of when it runs.
const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function roundCash(participantId) {
  const { rows } = await db.query(
    'SELECT current_cash FROM apocalypse_participants WHERE participant_id = $1',
    [participantId]
  );
  return parseFloat(rows[0].current_cash);
}

async function heldQuantity(participantId, coinId) {
  const { rows } = await db.query(
    'SELECT quantity FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = $2',
    [participantId, coinId]
  );
  return rows.length === 0 ? 0 : parseFloat(rows[0].quantity);
}

async function sellLedgerCount(participantId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1 AND type = 'SELL'`,
    [participantId]
  );
  return rows[0].n;
}

// Create a wall-clock cycle, join user 1, and pin coin 1's price so the
// expected totals are exact: £2,500.00 per coin mirrors the issue's worked
// example (0.004 of a £2,500 coin costs £10.00).
async function setupJoinedRound({ coinPrice = 2500 } = {}) {
  const cycle = await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
  const participant = await joinRound({ userId: 1, now: new Date() });
  await db.query('UPDATE coins SET current_price = $1 WHERE coin_id = 1', [coinPrice]);
  return { cycle, participant, coinId: 1 };
}

// NOT async: return the supertest chain itself so callers can .expect().
function buy(auth, cycle, coinId, amount) {
  return request(app)
    .post('/api/game/trades/buy')
    .set('Authorization', auth)
    .send({ cycleId: cycle.apocalypse_id, coin_id: coinId, amount });
}

function sell(auth, cycle, coinId, amount) {
  return request(app)
    .post('/api/game/trades/sell')
    .set('Authorization', auth)
    .send({ cycleId: cycle.apocalypse_id, coin_id: coinId, amount });
}

describe('Core 4 + migration 012: fractional round-trade quantities', () => {
  test('buy 0.004 of a £2,500 coin costs exactly £10.00 and stores the exact fraction', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound();
    const auth = `Bearer ${tokenFor(1)}`;

    const response = await buy(auth, cycle, coinId, 0.004).expect(201);

    expect(response.body.data.transaction).toMatchObject({
      type: 'BUY', coinId, quantity: 0.004, price: 2500, totalAmount: 10
    });
    // The participant payload carries the exact fractional holding (parsed
    // from the database decimal, never integer-truncated).
    const holding = response.body.data.participant.holdings.find((h) => h.coinId === coinId);
    expect(holding.quantity).toBe(0.004);

    expect(await roundCash(participant.participantId)).toBeCloseTo(990, 2);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.004);
    const { rows: txs } = await db.query(
      'SELECT quantity, total_amount FROM apocalypse_transactions WHERE participant_id = $1',
      [participant.participantId]
    );
    expect(parseFloat(txs[0].quantity)).toBe(0.004);
    expect(parseFloat(txs[0].total_amount)).toBeCloseTo(10, 2);
  });

  test('the required fractional examples and plain integers all trade successfully', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 10 });
    const auth = `Bearer ${tokenFor(1)}`;

    // £10/coin, £1,000 round cash: every required example is affordable, and
    // the smallest (0.004 × £10 = £0.04) clears the £0.01 minimum-notional
    // rule (fcoins_y #6 follow-up). Sub-penny rejections are covered by
    // __tests__/game-trades-min-notional.test.js.
    for (const amount of [1, 1.5, 0.5, 0.04, 0.004]) {
      const response = await buy(auth, cycle, coinId, amount).expect(201);
      expect(response.body.data.transaction.quantity).toBe(amount);
    }
    expect(await heldQuantity(participant.participantId, coinId)).toBeCloseTo(1 + 1.5 + 0.5 + 0.04 + 0.004, 8);
  });

  test('a 3-decimal quantity is stored EXACTLY — no silent rounding to 2dp (0.005 never becomes 0.01)', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound();
    const auth = `Bearer ${tokenFor(1)}`;

    const response = await buy(auth, cycle, coinId, 0.005).expect(201);

    expect(response.body.data.transaction.quantity).toBe(0.005);
    expect(response.body.data.transaction.totalAmount).toBeCloseTo(12.5, 2); // 0.005 * £2,500
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.005);
  });

  test('a fractional holding sells in part, leaving the exact remainder, then sells out entirely', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound();
    const auth = `Bearer ${tokenFor(1)}`;

    await buy(auth, cycle, coinId, 0.01).expect(201); // £25.00 -> cash £975.00
    const cashAfterBuy = await roundCash(participant.participantId);

    const partial = await sell(auth, cycle, coinId, 0.004).expect(201);
    expect(partial.body.data.transaction).toMatchObject({ type: 'SELL', quantity: 0.004, totalAmount: 10 });
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.006); // 0.010 - 0.004
    expect(await roundCash(participant.participantId)).toBeCloseTo(cashAfterBuy + 10, 2);

    await sell(auth, cycle, coinId, 0.006).expect(201); // the exact remainder
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
    expect(await roundCash(participant.participantId)).toBeCloseTo(1000, 2); // full round trip
  });

  test('fractional overspend is rejected atomically: cash, holdings and ledger unchanged', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound();
    const auth = `Bearer ${tokenFor(1)}`;

    // 0.5 * £2,500 = £1,250 > £1,000 round cash.
    const response = await buy(auth, cycle, coinId, 0.5).expect(400);

    expect(response.body.message).toMatch(/Insufficient round cash/);
    expect(await roundCash(participant.participantId)).toBe(1000);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
    const { rows: t } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1',
      [participant.participantId]
    );
    expect(t[0].n).toBe(0);
  });

  test('fractional oversell is rejected atomically: holding, cash and ledger unchanged', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound();
    const auth = `Bearer ${tokenFor(1)}`;

    await buy(auth, cycle, coinId, 0.004).expect(201);
    const cashBefore = await roundCash(participant.participantId);

    const response = await sell(auth, cycle, coinId, 0.005).expect(400);

    expect(response.body.message).toMatch(/Insufficient round holdings/);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.004);
    expect(await roundCash(participant.participantId)).toBe(cashBefore);
    expect(await sellLedgerCount(participant.participantId)).toBe(0);
  });

  test('8-decimal dust (the exact ledger precision) trades when its value >= £0.01; cash and holdings stay non-negative', async () => {
    // £1,000,000/coin: 0.00000001 costs round2(£0.01) = £0.01 — the smallest
    // possible dust quantity at exactly the minimum notional. Sub-penny dust
    // (e.g. 1e-8 @ £1) is now REJECTED by the £0.01 minimum-notional rule;
    // that contract lives in __tests__/game-trades-min-notional.test.js.
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 1000000 });
    const auth = `Bearer ${tokenFor(1)}`;

    const response = await buy(auth, cycle, coinId, 0.00000001).expect(201);
    expect(response.body.data.transaction.quantity).toBe(0.00000001);
    expect(response.body.data.transaction.totalAmount).toBeCloseTo(0.01, 2);
    expect(await roundCash(participant.participantId)).toBeCloseTo(999.99, 2);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.00000001);

    await sell(auth, cycle, coinId, 0.00000001).expect(201); // full dust exit
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
    expect(await roundCash(participant.participantId)).toBe(1000);

    // Database invariants after dust trades: never negative.
    const { rows: checks } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM apocalypse_participants WHERE current_cash < 0) AS negative_cash,
         (SELECT count(*)::int FROM apocalypse_holdings WHERE quantity < 0) AS negative_holdings`
    );
    expect(checks[0].negative_cash).toBe(0);
    expect(checks[0].negative_holdings).toBe(0);
  });

  test('precision beyond 8 significant decimal places is rejected with an explicit error, never rounded', async () => {
    // £10/coin: precision rejections fire before any value judgement, and the
    // trailing-zero buy below (0.004 × £10 = £0.04) clears the £0.01
    // minimum-notional rule.
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 10 });
    const auth = `Bearer ${tokenFor(1)}`;

    for (const excessive of [
      0.000000001,        // 9dp — one order below the ledger precision
      '0.000000001',
      '0.004000001',      // 9 significant fractional digits
      0.1 + 0.2,          // 0.30000000000000004: binary float artifact, 17dp
      0.30000000000000004
    ]) {
      const response = await buy(auth, cycle, coinId, excessive).expect(400);
      expect(response.body.message).toMatch(/up to 8 decimal places/);
    }

    // Nothing was written: rejection happens before any mutation.
    expect(await roundCash(participant.participantId)).toBe(1000);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);

    // Trailing zeros do NOT count against precision: 0.00400000 is 0.004.
    const ok = await buy(auth, cycle, coinId, '0.00400000').expect(201);
    expect(ok.body.data.transaction.quantity).toBe(0.004);
  });

  test('malformed quantity input is rejected as invalid (not parsed partially, never rounded)', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 1 });
    const auth = `Bearer ${tokenFor(1)}`;

    for (const malformed of ['', '   ', 'abc', '1.2.3', '-0.5', '+1', '1e-3', '1,5', '0x10', 'NaN', 'Infinity', true, null, {}]) {
      const response = await buy(auth, cycle, coinId, malformed).expect(400);
      expect(response.body.message).toMatch(/Invalid quantity/);
    }

    expect(await roundCash(participant.participantId)).toBe(1000);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
  });

  test('a quantity beyond the storable range is a clean 400, not a database overflow', async () => {
    const { cycle, coinId } = await setupJoinedRound({ coinPrice: 1 });
    const auth = `Bearer ${tokenFor(1)}`;

    // DECIMAL(18,8) holds at most 9,999,999,999.99999999.
    const response = await buy(auth, cycle, coinId, 10000000000).expect(400);
    expect(response.body.message).toMatch(/maximum storable/);
  });

  test('the shared human/bot trade service accepts bot-style floored quantities unchanged', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 3 });
    const auth = `Bearer ${tokenFor(1)}`;

    // Core 5 bots size trades with Math.floor(v * 100) / 100 (botService
    // floor2): a conservative 2-decimal quantity. It must pass the shared
    // validator exactly as before — bot balancing is untouched by 012.
    const botStyleQuantity = Math.floor(0.28999999999999996 * 100) / 100; // 0.28
    const response = await buy(auth, cycle, coinId, botStyleQuantity).expect(201);
    expect(response.body.data.transaction.quantity).toBe(0.28);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.28);
  });
});
