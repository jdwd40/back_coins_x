// Crypto Chaos Core 6: end-of-round settlement.
//
// This module owns the two durable lifecycle phases that sit BETWEEN an
// expired ACTIVE cycle and its COMPLETED state:
//
//   freezeExpiredActiveCycle — its own advisory-locked transaction. An
//     expired ACTIVE cycle is stamped settlement_started_at and flipped to
//     SETTLING, and that commit is durable BEFORE any settlement work runs.
//     From that instant every trade against the cycle is rejected by the
//     Core 4 live-cycle guard (status must be ACTIVE and unexpired), so the
//     freeze races trades safely: a trade either commits fully against the
//     still-ACTIVE cycle before the freeze, or mutates nothing after it.
//
//   settleSettlingCycle — its own advisory-locked transaction. A durable
//     SETTLING cycle is settled to completion: the dynamic collapse
//     engine's final safety rule runs through exactly cycle end (every
//     remaining coin reaches £0 before any value or result is read), every
//     participant is finalized through the single Core 4 finalization
//     path, the immutable ranked snapshot is written to apocalypse_results
//     exactly once per participant, and only then is the cycle marked
//     COMPLETED with settled_at stamped. A failure anywhere rolls the
//     whole transaction back, leaving the cycle observably SETTLING; the
//     next call resumes and converges to exactly one result set
//     (ON CONFLICT DO NOTHING + the completeness guard make replays
//     no-ops, never duplicates).
//
// Successor creation is deliberately NOT here: gameCycleService creates the
// successor only after this module reports the predecessor COMPLETED, so a
// failed settlement durably blocks the next round.
//
// Circular-import safety: gameCycleService requires this module at load
// time. This module never requires gameCycleService — it re-declares the
// advisory lock key locally, exactly like gameRoundService.

const db = require('../db/connection');
// SIM-13/14: the dynamic collapse engine is the SINGLE coin-death
// authority. Settlement's end-of-cycle reconciliation is its final safety
// rule: every remaining coin is forced to exactly £0 at cycle end.
const dynamicCollapseService = require('./dynamicCollapseService');
const gameRoundService = require('./gameRoundService');

// Must match gameCycleService's GAME_CYCLE_ADVISORY_LOCK_KEY. Re-declared
// (not imported) to keep this module free of any dependency on
// gameCycleService.
const GAME_CYCLE_ADVISORY_LOCK_KEY = 727001;

// Internal settlement failure — never an HTTP/domain error. Any throw from
// a settlement phase means the transaction rolled back and the cycle remains
// SETTLING for a safe retry.
class GameSettlementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameSettlementError';
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — freeze. If the live ACTIVE cycle has reached its end, flip it to
// SETTLING and COMMIT that fact durably before any settlement work exists.
// Returns the frozen cycle row, or null when there is nothing to freeze.
// Idempotent: the guarded UPDATE only ever matches a still-ACTIVE row.
// ---------------------------------------------------------------------------
async function freezeExpiredActiveCycle({ nowMs } = {}) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [GAME_CYCLE_ADVISORY_LOCK_KEY]);

    // A durable SETTLING cycle blocks everything: never freeze on top of an
    // incomplete settlement.
    const { rows: settling } = await client.query(
      `SELECT cycle_id FROM apocalypse_cycles WHERE status = 'SETTLING' LIMIT 1`
    );
    if (settling.length > 0) {
      await client.query('COMMIT');
      return null;
    }

    const { rows } = await client.query(
      `SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE' LIMIT 1 FOR UPDATE`
    );
    const active = rows[0];
    if (!active || new Date(active.end_time).getTime() > now) {
      await client.query('COMMIT');
      return null;
    }

    const { rowCount } = await client.query(
      `UPDATE apocalypse_cycles
       SET status = 'SETTLING', settlement_started_at = now(), updated_at = now()
       WHERE cycle_id = $1 AND status = 'ACTIVE'`,
      [active.cycle_id]
    );
    if (rowCount !== 1) {
      throw new GameSettlementError(
        `freeze: cycle ${active.cycle_id} changed under the freeze; aborting`
      );
    }

    await client.query('COMMIT');
    return active;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — settle. Runs entirely inside one advisory-locked transaction
// against the durable SETTLING row (locked FOR UPDATE). Order is the
// authoritative settlement order: final collapse reconciliation through
// exactly cycle end, final monotonic peak lift, Core 4 participant
// finalization, the immutable ranked snapshot, predecessor COMPLETED.
// Returns the settled cycle row, or null when no cycle is settling.
// ---------------------------------------------------------------------------
async function settleSettlingCycle() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [GAME_CYCLE_ADVISORY_LOCK_KEY]);

    const { rows } = await client.query(
      `SELECT * FROM apocalypse_cycles WHERE status = 'SETTLING' ORDER BY cycle_id LIMIT 1 FOR UPDATE`
    );
    const cycle = rows[0];
    if (!cycle) {
      await client.query('COMMIT');
      return null;
    }

    // 1. Dynamic collapse reconciliation through EXACTLY cycle end (SIM-13
    //    final safety rule): every surviving coin — however healthy its
    //    risk looked — is forced to exactly £0 at the cycle's end_time, so
    //    the last coin reaches £0 before any value or result is read.
    //    Idempotent: only not-yet-dead coins are ever touched.
    await dynamicCollapseService.executeRemainingCollapses(client, cycle, new Date(cycle.end_time));

    // 2. Final monotonic peak lift. After the final collapse every holding
    //    is worth exactly £0, so live wealth equals current cash; lifting
    //    peak to at least final cash keeps the recorded peak honest without
    //    ever lowering it.
    await client.query(
      `UPDATE apocalypse_participants
       SET peak_wealth = GREATEST(peak_wealth, current_cash), updated_at = now()
       WHERE cycle_id = $1 AND status = 'ACTIVE' AND peak_wealth < current_cash`,
      [cycle.cycle_id]
    );

    // 3. Core 4 finalization — the single authoritative finalization path:
    //    status FINALIZED, final_cash from the authoritative current_cash.
    //    Idempotent (only still-ACTIVE rows match).
    await gameRoundService.finalizeCycleParticipants(client, cycle.cycle_id);

    // 4. Immutable ranked snapshot, exactly once per participant. Rank rule
    //    (deterministic, documented): final_cash DESC, then participant_id
    //    ASC; ranks are 1..N with no gaps and no modifiers of any kind.
    //    Humans and bots rank identically; net_profit is exactly
    //    final_cash - starting_cash; trade stats come straight from the
    //    Core 4 ledger. ON CONFLICT DO NOTHING makes a settlement replay a
    //    pure no-op — rows are never rewritten.
    await client.query(
      `INSERT INTO apocalypse_results
         (cycle_id, participant_id, user_id, apocalypse_id, username, is_bot, bot_personality,
          rank, final_cash, peak_wealth, starting_cash, net_profit, joined_at,
          trade_count, buy_count, sell_count)
       SELECT p.cycle_id, p.participant_id, p.user_id, ac.apocalypse_id, u.username, u.is_bot,
              b.strategy AS bot_personality,
              ranked.rank, p.final_cash, p.peak_wealth, p.starting_cash,
              p.final_cash - p.starting_cash, p.joined_at,
              COALESCE(t.trade_count, 0), COALESCE(t.buy_count, 0), COALESCE(t.sell_count, 0)
       FROM (
         SELECT p2.participant_id,
                ROW_NUMBER() OVER (ORDER BY p2.final_cash DESC, p2.participant_id ASC)::integer AS rank
         FROM apocalypse_participants p2
         WHERE p2.cycle_id = $1
       ) ranked
       JOIN apocalypse_participants p ON p.participant_id = ranked.participant_id
       JOIN apocalypse_cycles ac ON ac.cycle_id = p.cycle_id
       JOIN users u ON u.user_id = p.user_id
       LEFT JOIN apocalypse_bots b ON b.user_id = p.user_id
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS trade_count,
                count(*) FILTER (WHERE t2.type = 'BUY')::integer AS buy_count,
                count(*) FILTER (WHERE t2.type = 'SELL')::integer AS sell_count
         FROM apocalypse_transactions t2
         WHERE t2.participant_id = p.participant_id
       ) t ON true
       ON CONFLICT (cycle_id, participant_id) DO NOTHING`,
      [cycle.cycle_id]
    );

    // Completeness guard: exactly one result row per participant. An empty
    // cycle legitimately has zero of both. Any mismatch means inconsistent
    // persisted state — roll back and stay SETTLING rather than persist a
    // partial result set.
    const { rows: counts } = await client.query(
      `SELECT
         (SELECT count(*)::int FROM apocalypse_participants WHERE cycle_id = $1) AS participants,
         (SELECT count(*)::int FROM apocalypse_results      WHERE cycle_id = $1) AS results`,
      [cycle.cycle_id]
    );
    if (counts[0].participants !== counts[0].results) {
      throw new GameSettlementError(
        `settle: cycle ${cycle.cycle_id} has ${counts[0].participants} participants but ${counts[0].results} result rows; refusing to complete a partial settlement`
      );
    }

    // 5. Predecessor COMPLETE — guarded, so a replay or a concurrently
    //    resumed settlement can never complete the same cycle twice.
    const { rowCount } = await client.query(
      `UPDATE apocalypse_cycles
       SET status = 'COMPLETED', settled_at = now(), updated_at = now()
       WHERE cycle_id = $1 AND status = 'SETTLING'`,
      [cycle.cycle_id]
    );
    if (rowCount !== 1) {
      throw new GameSettlementError(
        `settle: cycle ${cycle.cycle_id} changed under settlement; aborting`
      );
    }

    await client.query('COMMIT');
    return cycle;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  GameSettlementError,
  freezeExpiredActiveCycle,
  settleSettlingCycle
};
