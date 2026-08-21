// Milestone 1 hardening (requirement 8): simulator vs round-trade lock
// ordering.
//
// The market simulator's write transaction locks ALL coin rows (FOR UPDATE)
// and then updates apocalypse_participants (reconcileActivePeaks) — lock
// order coins -> participants. Round trades used to lock the participant row
// first and the coin row second — participant -> coin. That inversion is a
// genuine deadlock cycle: a trade holding the participant lock waits on a
// coin row held by the simulator, while the simulator waits on the
// participant row held by the trade; PostgreSQL's deadlock detector aborts
// one side (user-facing 500s under load).
//
// The fix is narrow: trades lock the coin row BEFORE the participant row, so
// every code path that touches both takes them in the same coins ->
// participants order (the settlement path already executes collapses on coins
// before finalizing participants, and the simulator's write transaction never
// takes the advisory lock or cycle row locks).
//
// This test reproduces the exact interleaving deterministically with a raw
// simulator-shaped transaction and the REAL trade service:
//   1. simulator txn: BEGIN; lock ALL coins FOR UPDATE (as updateAllPrices)
//   2. real buyRoundTrade starts; it must reach its coin lock and block
//   3. simulator txn updates the participant row (as reconcileActivePeaks)
//   4. simulator COMMITs; the blocked trade must then complete cleanly
// Pre-fix this deadlocks (one side is aborted by the deadlock detector);
// post-fix both complete and the state is coherent.
//
// jest.setup.js reseeds the disposable test database before every test.

jest.setTimeout(45000);

const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');

// Pin every lifecycle call to a controlled instant early in the cycle (3%
// progress — well before the 70% collapse window) so no collapse is due and
// the trade target is guaranteed alive, regardless of wall clock.
function cycleStartNow() {
  const boundary = Math.floor(Date.now() / (30 * 60 * 1000)) * (30 * 60 * 1000);
  return new Date(boundary + 60 * 1000);
}

async function setupLiveRound(userId, now) {
  const cycle = await reconcileCycle({ now });
  const participant = await gameRoundService.joinRound({ userId, now });
  return { apocalypseId: cycle.apocalypse_id, participantId: participant.participantId };
}

async function runSimulatorVsTrade(tradeFn, label) {
  const sim = await db.getClient();
  let tradeSettled = false;
  try {
    await sim.query('BEGIN');
    // Exactly the simulator's first write-transaction step: lock every coin.
    await sim.query('SELECT coin_id, current_price FROM coins FOR UPDATE');

    const tradePromise = tradeFn().then(
      (result) => { tradeSettled = true; return { ok: true, result }; },
      (err) => { tradeSettled = true; return { ok: false, err }; }
    );

    // Give the trade time to reach its lock acquisition and block.
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(tradeSettled).toBe(false); // it MUST be blocked behind the coin locks

    // The simulator's peak reconciliation: wants the participant rows. With
    // the corrected order the trade has NOT locked the participant yet, so
    // this proceeds; pre-fix it deadlocks against the trade.
    const { rows } = await sim.query(
      'SELECT participant_id FROM apocalypse_participants'
    );
    for (const row of rows) {
      await sim.query(
        'UPDATE apocalypse_participants SET peak_wealth = peak_wealth, updated_at = now() WHERE participant_id = $1',
        [row.participant_id]
      );
    }
    await sim.query('COMMIT');

    const trade = await tradePromise;
    if (!trade.ok) throw trade.err;
    return trade.result;
  } finally {
    // If anything above threw mid-transaction, clean up.
    try { await sim.query('ROLLBACK'); } catch (_) {}
    sim.release();
  }
}

describe('simulator vs trade lock ordering (coins -> participants everywhere)', () => {
  test('a round buy blocked behind the simulator batch completes without deadlock', async () => {
    const now = cycleStartNow();
    const { apocalypseId } = await setupLiveRound(1, now);

    const result = await runSimulatorVsTrade(
      () => gameRoundService.buyRoundTrade({ userId: 1, apocalypseId, coinId: 1, quantity: 1, now }),
      'buy'
    );

    expect(result.transaction.type).toBe('BUY');
    expect(result.transaction.coinId).toBe(1);

    // Coherent post-state: cash debited, holding present.
    const { rows } = await db.query(
      `SELECT p.current_cash,
              (SELECT quantity FROM apocalypse_holdings h WHERE h.participant_id = p.participant_id AND h.coin_id = 1) AS qty
       FROM apocalypse_participants p WHERE p.user_id = 1`
    );
    expect(parseFloat(rows[0].current_cash)).toBeLessThan(1000);
    expect(parseFloat(rows[0].qty)).toBe(1);
  });

  test('a round sell blocked behind the simulator batch completes without deadlock', async () => {
    const now = cycleStartNow();
    const { apocalypseId } = await setupLiveRound(1, now);
    await gameRoundService.buyRoundTrade({ userId: 1, apocalypseId, coinId: 1, quantity: 2, now });

    const result = await runSimulatorVsTrade(
      () => gameRoundService.sellRoundTrade({ userId: 1, apocalypseId, coinId: 1, quantity: 1, now }),
      'sell'
    );

    expect(result.transaction.type).toBe('SELL');

    const { rows } = await db.query(
      `SELECT quantity FROM apocalypse_holdings h
       JOIN apocalypse_participants p ON p.participant_id = h.participant_id
       WHERE p.user_id = 1 AND h.coin_id = 1`
    );
    expect(parseFloat(rows[0].quantity)).toBe(1);
  });
});
