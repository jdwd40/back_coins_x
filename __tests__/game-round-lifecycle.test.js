// Core 4: lifecycle coverage — Core 3 collapsed-coin behaviour in round
// trades, wealth = cash + live holdings value, monotonic peak (including the
// set-based market reconciliation), lifecycle finalization at rollover, and
// consecutive-cycle isolation (fresh £10,000, no state transfer).

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const {
  joinRound,
  buyRoundTrade,
  sellRoundTrade,
  getParticipantRoundState,
  reconcileActivePeaks
} = require('../game/gameRoundService');
const marketSimulator = require('../models/market-simulator');

const CYCLE_START_MS = new Date('2026-08-20T10:00:00.000Z').getTime();
const DURATION_MS = 30 * 60 * 1000;
const EARLY = new Date(CYCLE_START_MS + DURATION_MS * 0.10);
const WINDOW_START = new Date(CYCLE_START_MS + DURATION_MS * 0.70);
const AFTER_END = new Date(CYCLE_START_MS + DURATION_MS + 60 * 1000);

function tokenFor(userId) {
  return jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function participantRow(participantId) {
  const { rows } = await db.query(
    'SELECT * FROM apocalypse_participants WHERE participant_id = $1',
    [participantId]
  );
  return rows[0];
}

// Create the fixed-time cycle and return { cycle, firstCoinId } where
// firstCoinId is the coin scheduled to collapse first (rank 0).
async function fixedCycle() {
  const cycle = await reconcileCycle({ now: EARLY });
  const { rows } = await db.query(
    'SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND collapse_rank = 0',
    [cycle.cycle_id]
  );
  return { cycle, firstCoinId: rows[0].coin_id };
}

describe('Core 4: Core 3 collapsed-coin behaviour in round trades', () => {
  test('buying a coin collapsed in this cycle is rejected with a clear domain error, nothing written', async () => {
    const { cycle, firstCoinId } = await fixedCycle();
    const participant = await joinRound({ userId: 1, now: EARLY });
    await reconcileCycle({ now: WINDOW_START }); // rank 0 collapses to £0

    const response = await request(app)
      .post('/api/game/trades/buy')
      .set('Authorization', `Bearer ${tokenFor(1)}`)
      .send({ cycleId: cycle.apocalypse_id, coin_id: firstCoinId, amount: 1 });

    // The API runs at wall-clock now; if the fixed cycle has already rolled
    // over in real time the stale-cycle rejection (409) is equally correct —
    // assert the domain behaviour via the service at the fixed time instead.
    if (response.status === 409) {
      await expect(
        buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: firstCoinId, quantity: 1, now: WINDOW_START })
      ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/collapsed to £0/) });
    } else {
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/collapsed to £0/);
    }

    const p = await participantRow(participant.participantId);
    expect(parseFloat(p.current_cash)).toBe(10000);
    const { rows: t } = await db.query('SELECT count(*)::int AS n FROM apocalypse_transactions');
    expect(t[0].n).toBe(0);
  });

  test('a collapsed holding sells at the authoritative £0 and credits exactly zero cash', async () => {
    const { cycle, firstCoinId } = await fixedCycle();
    const participant = await joinRound({ userId: 1, now: EARLY });

    // Buy while alive (service-level, fixed time for determinism).
    const { rows: coinRows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [firstCoinId]);
    const price = parseFloat(coinRows[0].current_price);
    const buy = await buyRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: firstCoinId, quantity: 5, now: EARLY
    });
    const expectedCost = Math.round(5 * price * 100) / 100;
    expect(buy.transaction.totalAmount).toBeCloseTo(expectedCost, 2);
    const cashAfterBuy = 10000 - expectedCost;

    // The coin collapses while held.
    await reconcileCycle({ now: WINDOW_START });

    // Sell the dead holding: executed at £0, adds exactly zero cash.
    const sell = await sellRoundTrade({
      userId: 1, apocalypseId: cycle.apocalypse_id, coinId: firstCoinId, quantity: 5, now: WINDOW_START
    });
    expect(sell.transaction.price).toBe(0);
    expect(sell.transaction.totalAmount).toBe(0);

    const p = await participantRow(participant.participantId);
    expect(parseFloat(p.current_cash)).toBeCloseTo(cashAfterBuy, 2);

    const { rows: txs } = await db.query(
      `SELECT * FROM apocalypse_transactions WHERE participant_id = $1 AND type = 'SELL'`,
      [participant.participantId]
    );
    expect(txs).toHaveLength(1);
    expect(parseFloat(txs[0].price)).toBe(0);
    expect(parseFloat(txs[0].total_amount)).toBe(0);
  });
});

describe('Core 4: wealth and monotonic peak', () => {
  test('wealth = current cash + live holdings value; collapsed holdings count £0', async () => {
    const { cycle, firstCoinId } = await fixedCycle();
    const participant = await joinRound({ userId: 1, now: EARLY });
    const { rows: coinRows } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [firstCoinId]);
    const price = parseFloat(coinRows[0].current_price);

    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: firstCoinId, quantity: 10, now: EARLY });
    let state = await getParticipantRoundState(participant.participantId);
    const cost = Math.round(10 * price * 100) / 100;
    expect(state.currentCash).toBeCloseTo(10000 - cost, 2);
    expect(state.holdingsValue).toBeCloseTo(cost, 2);
    expect(state.wealth).toBeCloseTo(10000, 2);

    // Collapse: holdings now worth exactly £0; wealth falls to cash only.
    await reconcileCycle({ now: WINDOW_START });
    state = await getParticipantRoundState(participant.participantId);
    expect(state.holdingsValue).toBe(0);
    expect(state.wealth).toBeCloseTo(10000 - cost, 2);
  });

  test('peak is monotonic across live price movements via the set-based reconciliation', async () => {
    const { cycle, firstCoinId } = await fixedCycle();
    const participant = await joinRound({ userId: 1, now: EARLY });
    // Use a coin that is NOT rank 0 so it survives the first collapse.
    const { rows: survivors } = await db.query(
      `SELECT coin_id FROM coins WHERE coin_id <> $1 ORDER BY coin_id LIMIT 1`,
      [firstCoinId]
    );
    const coinId = survivors[0].coin_id;
    await db.query('UPDATE coins SET current_price = 50.00 WHERE coin_id = $1', [coinId]);

    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId, quantity: 10, now: EARLY });
    let p = await participantRow(participant.participantId);
    expect(parseFloat(p.current_cash)).toBe(9500);
    expect(parseFloat(p.peak_wealth)).toBe(10000);

    // Price doubles: wealth = 9500 + 10*100 = 10500 -> peak lifts to 10500.
    await db.query('UPDATE coins SET current_price = 100.00 WHERE coin_id = $1', [coinId]);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await reconcileActivePeaks(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    p = await participantRow(participant.participantId);
    expect(parseFloat(p.peak_wealth)).toBe(10500);

    // Price crashes below entry: wealth falls, peak stays at 10500 (monotonic).
    await db.query('UPDATE coins SET current_price = 10.00 WHERE coin_id = $1', [coinId]);
    const client2 = await db.getClient();
    try {
      await client2.query('BEGIN');
      await reconcileActivePeaks(client2);
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }
    p = await participantRow(participant.participantId);
    expect(parseFloat(p.peak_wealth)).toBe(10500);
    const state = await getParticipantRoundState(participant.participantId);
    expect(state.wealth).toBe(9600); // 9500 cash + 10 * £10
    expect(state.peakWealth).toBe(10500);
  });

  test('the market simulator price batch reconciles peaks atomically (peak >= wealth after every batch)', async () => {
    // Wall-clock long cycle: every coin alive, no rollover mid-test.
    const cycle = await reconcileCycle({ now: new Date(), durationMs: 7 * 24 * 60 * 60 * 1000 });
    const participant = await joinRound({ userId: 1, now: new Date() });
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 10, now: new Date() });

    // V2-1: the writer needs no in-memory initialisation — prices come from
    // the shared deterministic domain.
    marketSimulator.stop();
    await marketSimulator.updateAllPrices();

    const p = await participantRow(participant.participantId);
    const state = await getParticipantRoundState(participant.participantId);
    expect(parseFloat(p.peak_wealth)).toBeGreaterThanOrEqual(state.wealth);
  });
});

describe('Core 4: finalization and consecutive-cycle isolation', () => {
  test('rollover finalizes participants (final_cash = current_cash), creates no successor state, and the next join starts fresh £10,000', async () => {
    const { cycle, firstCoinId } = await fixedCycle();
    const participant = await joinRound({ userId: 1, now: EARLY });
    // Trade so finalization is observably copied from authoritative cash.
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: firstCoinId, quantity: 2, now: EARLY });
    const before = await participantRow(participant.participantId);

    // Roll over past the end: Core 3 final collapses execute first, then
    // finalization, then the successor — atomically.
    const successor = await reconcileCycle({ now: AFTER_END });
    expect(successor.cycle_id).not.toBe(cycle.cycle_id);
    expect(successor.status).toBe('ACTIVE');

    const old = await participantRow(participant.participantId);
    expect(old.status).toBe('FINALIZED');
    expect(parseFloat(old.final_cash)).toBeCloseTo(parseFloat(before.current_cash), 2);
    expect(parseFloat(old.current_cash)).toBeCloseTo(parseFloat(before.current_cash), 2);

    // users.funds untouched by finalization.
    const { rows: u } = await db.query('SELECT funds FROM users WHERE user_id = 1');
    expect(parseFloat(u[0].funds)).toBe(1000);

    // Finalization is idempotent: reconciling again changes nothing.
    await reconcileCycle({ now: new Date(AFTER_END.getTime() + 1000) });
    const oldAgain = await participantRow(participant.participantId);
    expect(oldAgain.status).toBe('FINALIZED');
    expect(parseFloat(oldAgain.final_cash)).toBeCloseTo(parseFloat(before.current_cash), 2);

    // Join the successor round: a NEW participant, fresh £10,000, no holdings.
    const next = await joinRound({ userId: 1, now: AFTER_END });
    expect(next.participantId).not.toBe(participant.participantId);
    expect(next.apocalypseId).toBe(successor.apocalypse_id);
    expect(next.startingCash).toBe(10000);
    expect(next.currentCash).toBe(10000);
    expect(next.peakWealth).toBe(10000);
    expect(next.holdings).toEqual([]);

    // Exactly one participant per cycle for this user.
    const { rows: counts } = await db.query(
      'SELECT cycle_id, count(*)::int AS n FROM apocalypse_participants WHERE user_id = 1 GROUP BY cycle_id ORDER BY cycle_id'
    );
    expect(counts).toHaveLength(2);
    expect(counts.every((r) => r.n === 1)).toBe(true);
  });

  test("previous cycle's holdings cannot be sold in the successor cycle", async () => {
    const { cycle, firstCoinId } = await fixedCycle();
    await joinRound({ userId: 1, now: EARLY });
    // Buy a coin that survives the whole first cycle? All coins collapse by
    // cycle end — but the HOLDING row persists regardless; cross-cycle
    // isolation must still reject the sale in the successor.
    await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: firstCoinId, quantity: 3, now: EARLY });

    const successor = await reconcileCycle({ now: AFTER_END });
    const next = await joinRound({ userId: 1, now: AFTER_END });

    await expect(
      sellRoundTrade({ userId: 1, apocalypseId: successor.apocalypse_id, coinId: firstCoinId, quantity: 3, now: AFTER_END })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Insufficient round holdings/) });

    // Successor state untouched.
    expect(next.currentCash).toBe(10000);
    const { rows: h } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_holdings WHERE participant_id = $1',
      [next.participantId]
    );
    expect(h[0].n).toBe(0);
    // Old holding row still belongs to the old cycle.
    const { rows: oldH } = await db.query(
      'SELECT cycle_id FROM apocalypse_holdings WHERE coin_id = $1',
      [firstCoinId]
    );
    expect(oldH[0].cycle_id).toBe(cycle.cycle_id);
  });

  test('a finalized participant can never trade again even while its cycle row lingers ACTIVE', async () => {
    const { cycle } = await fixedCycle();
    const participant = await joinRound({ userId: 1, now: EARLY });
    // Force-finalize directly (simulates post-rollover state) while the
    // cycle row itself is still ACTIVE and unexpired at the trade's `now`.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE apocalypse_participants SET status = 'FINALIZED', final_cash = current_cash WHERE participant_id = $1`,
        [participant.participantId]
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await expect(
      buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 1, now: EARLY })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/finalized/) });
  });

  test('join after rollover does not resurrect or mutate the finalized previous participant', async () => {
    const { cycle } = await fixedCycle();
    const participant = await joinRound({ userId: 1, now: EARLY });
    await reconcileCycle({ now: AFTER_END });
    await joinRound({ userId: 1, now: AFTER_END });

    const old = await participantRow(participant.participantId);
    expect(old.status).toBe('FINALIZED');
    expect(parseFloat(old.final_cash)).toBe(10000);
    expect(parseFloat(old.current_cash)).toBe(10000);
  });
});
