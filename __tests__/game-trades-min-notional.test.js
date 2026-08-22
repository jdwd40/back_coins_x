// Minimum-notional follow-up to fcoins_y #6: with quantities at
// DECIMAL(18,8) but money at DECIMAL(18,2), a positive quantity can have an
// authoritative 2-decimal consideration of £0.00. Such trades are rejected:
// a BUY must never mint holdings for zero round cash, and a live-priced
// SELL must never destroy holdings for zero proceeds. The rule judges the
// ROUNDED total (the number the ledger would record) and is enforced in the
// shared human/bot trade service; bots additionally skip sub-penny
// decisions at the service enforcement layer.
//
// The collapsed-coin £0 exit is deliberately UNCHANGED: a dead holding
// (price exactly £0) still sells out for exactly £0.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound, buyRoundTrade, sellRoundTrade } = require('../game/gameRoundService');
const botService = require('../game/botService');

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

async function ledgerCount(participantId) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM apocalypse_transactions WHERE participant_id = $1',
    [participantId]
  );
  return rows[0].n;
}

async function setupJoinedRound({ coinPrice = 1 } = {}) {
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

describe('minimum notional: every live-priced trade must settle for at least £0.01', () => {
  test('1+2. BUY with positive quantity but £0.00 rounded cost is rejected atomically', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 1 });
    const auth = `Bearer ${tokenFor(1)}`;

    // 0.004 @ £1.00 = £0.004 raw -> £0.00 authoritative. Repeatable free
    // holdings without the guard.
    const response = await buy(auth, cycle, coinId, 0.004).expect(400);

    expect(response.body.message).toMatch(/Trade value must be at least £0\.01/);
    expect(response.body.message).toMatch(/£0\.00/);

    // Nothing moved: cash, holdings and ledger are exactly as before.
    expect(await roundCash(participant.participantId)).toBe(10000);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
    expect(await ledgerCount(participant.participantId)).toBe(0);

    // The exploit is not repeatable even once, let alone in a loop.
    await buy(auth, cycle, coinId, 0.004).expect(400);
    expect(await roundCash(participant.participantId)).toBe(10000);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
  });

  test('3+4. SELL whose proceeds round to £0.00 is rejected atomically', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 1 });
    const auth = `Bearer ${tokenFor(1)}`;

    await buy(auth, cycle, coinId, 0.01).expect(201); // £0.01: cash £999.99
    const cashBefore = await roundCash(participant.participantId);

    // Selling 0.004 of the 0.01 holding proceeds £0.004 -> £0.00.
    const response = await sell(auth, cycle, coinId, 0.004).expect(400);

    expect(response.body.message).toMatch(/Trade value must be at least £0\.01/);

    // The holding survives intact; cash and ledger are untouched by the
    // rejected sale (the one BUY ledger row remains).
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.01);
    expect(await roundCash(participant.participantId)).toBe(cashBefore);
    expect(await ledgerCount(participant.participantId)).toBe(1);
  });

  test('5. a trade at exactly the £0.01 minimum succeeds on both sides', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 1 });
    const auth = `Bearer ${tokenFor(1)}`;

    const bought = await buy(auth, cycle, coinId, 0.01).expect(201);
    expect(bought.body.data.transaction.totalAmount).toBe(0.01);
    expect(await roundCash(participant.participantId)).toBeCloseTo(9999.99, 2);

    const sold = await sell(auth, cycle, coinId, 0.01).expect(201);
    expect(sold.body.data.transaction.totalAmount).toBe(0.01);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
    expect(await roundCash(participant.participantId)).toBeCloseTo(10000, 2);
  });

  test('6. 0.004 fractional trades still succeed whenever their value is >= £0.01', async () => {
    // £2.50/coin: 0.004 = £0.0100 exactly — the boundary case.
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 2.5 });
    const auth = `Bearer ${tokenFor(1)}`;

    const bought = await buy(auth, cycle, coinId, 0.004).expect(201);
    expect(bought.body.data.transaction).toMatchObject({ quantity: 0.004, totalAmount: 0.01 });
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.004);

    const sold = await sell(auth, cycle, coinId, 0.004).expect(201);
    expect(sold.body.data.transaction.totalAmount).toBe(0.01);
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
    expect(await roundCash(participant.participantId)).toBeCloseTo(10000, 2);
  });

  test('sub-penny rounding edge: 0.005 @ £1 rounds to £0.01 and is allowed (rounded rule, judged as recorded)', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 1 });
    const auth = `Bearer ${tokenFor(1)}`;

    const bought = await buy(auth, cycle, coinId, 0.005).expect(201);
    expect(bought.body.data.transaction.totalAmount).toBe(0.01); // round2(0.005) = 0.01
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0.005);
  });

  test('collapsed-coin £0 exit is preserved: a dead holding still sells out for exactly £0', async () => {
    const { cycle, participant, coinId } = await setupJoinedRound({ coinPrice: 2.5 });
    const auth = `Bearer ${tokenFor(1)}`;

    await buy(auth, cycle, coinId, 0.004).expect(201);
    const cashBefore = await roundCash(participant.participantId);

    // Core 3: the coin dies mid-round. Exiting the corpse must not be
    // blocked by the minimum-notional rule — the holding is worthless.
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [coinId]);

    const response = await sell(auth, cycle, coinId, 0.004).expect(201);
    expect(response.body.data.transaction).toMatchObject({ type: 'SELL', quantity: 0.004, price: 0, totalAmount: 0 });
    expect(await heldQuantity(participant.participantId, coinId)).toBe(0);
    expect(await roundCash(participant.participantId)).toBe(cashBefore); // exactly £0 credited
  });

  test('7a. bots obey the rule at the service layer: a bot user cannot buy or sell sub-penny through the shared service', async () => {
    const cycle = await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });
    await db.query('UPDATE coins SET current_price = 1 WHERE coin_id = 1');
    const bots = await botService.ensureBotsProvisioned();
    const bot = bots[0];
    const participant = await joinRound({ userId: bot.userId, now: new Date() });

    // The exact call runBotTick makes: same validation, same rejection.
    await expect(
      buyRoundTrade({ userId: bot.userId, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 0.004 })
    ).rejects.toThrow(/Trade value must be at least £0\.01/);

    await buyRoundTrade({ userId: bot.userId, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 0.01 });
    await expect(
      sellRoundTrade({ userId: bot.userId, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 0.004 })
    ).rejects.toThrow(/Trade value must be at least £0\.01/);

    expect(await heldQuantity(participant.participantId, 1)).toBe(0.01);
    expect(await ledgerCount(participant.participantId)).toBe(1); // only the valid £0.01 buy
  });

  test('7b. bot decision enforcement skips sub-penny decisions and passes valid ones through', () => {
    const state = (price) => ({
      coins: [{ coinId: 1, symbol: 'JDC', currentPrice: price, history: [1, 1] }],
      cash: 10000,
      holdings: [],
      apocalypsePercent: 10
    });

    // BUY 0.01 @ £0.40 = £0.004 -> £0.00: skipped (null) before the service call.
    expect(
      botService.enforceMinTradeValue({ type: 'BUY', coinId: 1, quantity: 0.01 }, state(0.4))
    ).toBeNull();
    // SELL of a dust holding at a live price: skipped identically.
    expect(
      botService.enforceMinTradeValue({ type: 'SELL', coinId: 1, quantity: 0.004 }, state(1))
    ).toBeNull();
    // Boundary £0.01 trades pass through unchanged.
    expect(
      botService.enforceMinTradeValue({ type: 'BUY', coinId: 1, quantity: 0.004 }, state(2.5))
    ).toEqual({ type: 'BUY', coinId: 1, quantity: 0.004 });
    expect(
      botService.enforceMinTradeValue({ type: 'SELL', coinId: 1, quantity: 0.01 }, state(1))
    ).toEqual({ type: 'SELL', coinId: 1, quantity: 0.01 });
    // Collapsed-exit exemption mirrors the service: £0-priced sells pass.
    expect(
      botService.enforceMinTradeValue({ type: 'SELL', coinId: 1, quantity: 0.004 }, state(0))
    ).toEqual({ type: 'SELL', coinId: 1, quantity: 0.004 });
    // HOLD and null decisions are untouched.
    expect(botService.enforceMinTradeValue({ type: 'HOLD' }, state(1))).toEqual({ type: 'HOLD' });
    expect(botService.enforceMinTradeValue(null, state(1))).toBeNull();
  });
});
