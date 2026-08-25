// Crypto Chaos Core 4: player round state — participants, round holdings and
// round transactions.
//
// This module owns ALL round-scoped game state. It never reads or writes
// users.funds, legacy portfolios, or legacy transactions: a participant's
// starting cash comes from the single game constant (gameConstants.js),
// trades move only apocalypse_participants.current_cash and
// apocalypse_holdings rows, and the ledger is apocalypse_transactions.
//
// Concurrency model: every mutating operation runs inside its own PostgreSQL
// transaction guarded by the SAME transaction-scoped advisory lock Core 1
// uses for cycle reconciliation (key 727001). Joins and trades therefore
// serialise with rollover/finalization across every Node/PM2 process; no
// process-local mutexes exist anywhere in this module.
//
// Circular-import safety: gameCycleService requires gameSettlementService at
// load time and gameSettlementService requires THIS module (for the Core 4
// finalization hook inside settlement). This module therefore never requires
// gameCycleService or gameSettlementService at the top level — the one place
// that needs it (joinRound's rollover-repair retry) requires gameCycleService
// lazily inside the function, by which time the module graph is fully loaded.

const db = require('../db/connection');
const {
  GAME_STARTING_CASH,
  GAME_QUANTITY_DECIMALS,
  GAME_QUANTITY_MAX,
  GAME_MIN_TRADE_VALUE,
  resolveGameStartingCash,
  resolveGamePowerMax,
  resolveGameMaxOpenPositions
} = require('./gameConstants');
const powerDomain = require('./powerDomain');

// Must match gameCycleService's GAME_CYCLE_ADVISORY_LOCK_KEY. It is
// re-declared here (not imported) to keep this module free of any top-level
// dependency on gameCycleService.
const GAME_CYCLE_ADVISORY_LOCK_KEY = 727001;

// Canonical public cycle identifier (Core 1): e.g. 'APOC-0001'.
const APOCALYPSE_ID_PATTERN = /^APOC-\d{4,}$/;

// Domain error carrying an HTTP status for the controller layer. Unknown
// errors still fall through to the generic 500 handler.
class GameRoundError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GameRoundError';
    this.status = status;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Render a quantity in a user-facing message: plain decimal text at the
// ledger's 8-decimal precision with trailing zeros stripped — never exponent
// notation ("1e-8") and never whole-coin rounding. Messages only; trade
// quantities themselves are validated by validateQuantity.
function formatQuantityText(value) {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(GAME_QUANTITY_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
}

// Minimum-notional guard (fcoins_y #6 follow-up): a live-priced trade whose
// AUTHORITATIVE consideration (round2 of quantity × server-side locked
// price) falls below one penny is rejected BEFORE any write. Without this a
// buy mints holdings for £0.00 and a sell destroys holdings for £0.00 —
// repeatably. The rounded total is what the ledger records, so the rounded
// total is what is judged. Collapsed-coin £0 exits are exempt: see the sell
// path.
function assertMinTradeValue(total, side) {
  if (total < GAME_MIN_TRADE_VALUE) {
    throw new GameRoundError(
      `Trade value must be at least £${GAME_MIN_TRADE_VALUE.toFixed(2)}. This ${side} totals £${total.toFixed(2)} at the current price.`,
      400
    );
  }
}

// Plain decimal strings only: digits with at most one fractional part
// ("10", "1.25", "0.004", ".5", "1."). Signs, exponents, hex, thousands
// separators and blank/garbage strings are malformed input, not quantities.
const PLAIN_QUANTITY_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

// Exact significant-fractional-digit count of a validated numeric string, in
// plain ("0.004") or exponent ("1e-7", from String(number)) form. Computed
// on the DECIMAL STRING so binary floating-point representation error can
// never miscount. Trailing zeros do not count: "0.5000" is value-identical
// to "0.5" and needs only 1 decimal place.
function significantDecimalPlaces(text) {
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return Infinity; // unreachable: callers pre-validate the shape
  const intDigits = match[1] || '';
  const fracDigits = match[2] || '';
  const exponent = match[3] ? parseInt(match[3], 10) : 0;
  // value = (intDigits concatenated with fracDigits) * 10^(exponent - fracLen)
  let scale = fracDigits.length - exponent;
  if (scale <= 0) return 0;
  let digits = intDigits + fracDigits;
  let trailingZeros = 0;
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    trailingZeros += 1;
  }
  return Math.max(0, scale - trailingZeros);
}

// Validate a client-supplied trade quantity: finite, positive, storable, and
// at the ledger's exact fractional precision (DECIMAL(18,8) as of migration
// 012 — see gameConstants.GAME_QUANTITY_DECIMALS). Anything needing MORE
// precision is rejected with an explicit precision error, NEVER silently
// rounded into a materially different quantity. Returns the quantity as a
// number; node-pg serialises doubles shortest-round-trip (and PostgreSQL
// parses the decimal text exactly), so what was validated is what is stored.
function validateQuantity(raw) {
  const invalid = () => new GameRoundError(
    'Invalid quantity. Please provide a finite quantity greater than 0.',
    400
  );
  let text;
  if (typeof raw === 'string') {
    text = raw.trim();
    if (!PLAIN_QUANTITY_PATTERN.test(text)) throw invalid();
  } else if (typeof raw === 'number' && Number.isFinite(raw)) {
    text = String(raw); // shortest round-trip; exponent form for tiny values
  } else {
    throw invalid();
  }
  const quantity = Number(text);
  if (!(quantity > 0)) throw invalid();
  const places = significantDecimalPlaces(text);
  if (places > GAME_QUANTITY_DECIMALS) {
    throw new GameRoundError(
      `Invalid quantity. Quantities support up to ${GAME_QUANTITY_DECIMALS} decimal places; ${text} needs ${places} and would have to be rounded. Reduce the precision instead.`,
      400
    );
  }
  if (quantity >= GAME_QUANTITY_MAX) {
    throw new GameRoundError(
      'Invalid quantity. Quantity exceeds the maximum storable value.',
      400
    );
  }
  return quantity;
}

function validateApocalypseId(raw) {
  if (typeof raw !== 'string' || !APOCALYPSE_ID_PATTERN.test(raw)) {
    throw new GameRoundError('Invalid cycleId. Please provide the current apocalypse identifier (e.g. APOC-0001).', 400);
  }
  return raw;
}

// Resolve and row-lock the cycle identified by its public apocalypse_id, and
// prove it is the live round: it must exist, still be ACTIVE, and its window
// must not have expired as of `now`. Stale prior IDs, completed cycles,
// nonexistent/future IDs and expired-but-not-yet-rolled-over cycles are all
// rejected BEFORE any write.
async function lockLiveCycle(client, apocalypseId, nowMs) {
  const { rows } = await client.query(
    `SELECT * FROM apocalypse_cycles WHERE apocalypse_id = $1 FOR UPDATE`,
    [apocalypseId]
  );
  const cycle = rows[0];
  if (!cycle) {
    throw new GameRoundError(`Unknown apocalypse cycle ${apocalypseId}.`, 404);
  }
  if (cycle.status !== 'ACTIVE' || new Date(cycle.end_time).getTime() <= nowMs) {
    throw new GameRoundError(
      `Apocalypse cycle ${apocalypseId} is no longer active. Fetch GET /api/game/state for the current round.`,
      409
    );
  }
  return cycle;
}

// Resolve and row-lock the caller's participant for a live cycle. Explicit
// prior join is required: a trade without a participant row is a clear
// domain error, never an implicit state mutation.
async function lockParticipant(client, cycleId, userId) {
  const { rows } = await client.query(
    `SELECT * FROM apocalypse_participants
     WHERE cycle_id = $1 AND user_id = $2
     FOR UPDATE`,
    [cycleId, userId]
  );
  const participant = rows[0];
  if (!participant) {
    throw new GameRoundError('No participant for this apocalypse cycle. Join the round first via POST /api/game/join.', 409);
  }
  if (participant.status !== 'ACTIVE') {
    throw new GameRoundError('Your participation in this apocalypse cycle has been finalized and can no longer trade.', 409);
  }
  return participant;
}

// True when the coin has an executed Core 3 collapse in THIS cycle. Death is
// read from the persisted execution state of the given cycle only.
async function isCoinCollapsedInCycle(client, cycleId, coinId) {
  const { rows } = await client.query(
    `SELECT 1 FROM coin_collapse_schedule
     WHERE cycle_id = $1 AND coin_id = $2 AND executed_at IS NOT NULL`,
    [cycleId, coinId]
  );
  return rows.length > 0;
}

// Wealth = participant current cash + SQL aggregate of round holding
// quantity * current live coin price (collapsed holdings price at £0 and so
// contribute nothing). Peak is monotonic: max(existing peak, current wealth).
async function refreshWealthAndPeak(client, participantId) {
  const { rows } = await client.query(
    `WITH hv AS (
       SELECT COALESCE(SUM(h.quantity * c.current_price), 0) AS holdings_value
       FROM apocalypse_holdings h
       JOIN coins c ON c.coin_id = h.coin_id
       WHERE h.participant_id = $1
     )
     UPDATE apocalypse_participants p
     SET peak_wealth = GREATEST(p.peak_wealth, p.current_cash + hv.holdings_value),
         updated_at = now()
     FROM hv
     WHERE p.participant_id = $1
     RETURNING p.*, p.current_cash + hv.holdings_value AS wealth, hv.holdings_value`,
    [participantId]
  );
  return rows[0];
}

// Read the full public round state for a participant row. isBot is the safe
// public Core 5 marker (users.is_bot); strategy internals are never exposed.
// V2-2: also exposes the server-authoritative Power view (current effective
// Power from lazy timestamp reconciliation, max, regen cadence, the next
// regen instant and the raw stored pair so a client can interpolate) and the
// per-holding cost-basis economics (weighted-average entry, remaining basis,
// live value and unrealised P&L). Nothing here leaks the seed, future
// collapses or any other hidden state.
async function getParticipantRoundState(participantId, queryable = db) {
  const { rows } = await queryable.query(
    `SELECT p.participant_id, p.cycle_id, ac.apocalypse_id, p.user_id,
            p.joined_at, p.starting_cash, p.current_cash, p.peak_wealth,
            p.status, p.final_cash, p.power, p.power_updated_at,
            p.created_at, p.updated_at,
            u.is_bot,
            COALESCE(SUM(h.quantity * c.current_price), 0) AS holdings_value
     FROM apocalypse_participants p
     JOIN apocalypse_cycles ac ON ac.cycle_id = p.cycle_id
     JOIN users u ON u.user_id = p.user_id
     LEFT JOIN apocalypse_holdings h ON h.participant_id = p.participant_id
     LEFT JOIN coins c ON c.coin_id = h.coin_id
     WHERE p.participant_id = $1
     GROUP BY p.participant_id, ac.apocalypse_id, u.is_bot`,
    [participantId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const holdings = (await queryable.query(
    `SELECT h.coin_id, c.symbol, h.quantity, h.cost_basis, c.current_price,
            h.quantity * c.current_price AS current_value
     FROM apocalypse_holdings h
     JOIN coins c ON c.coin_id = h.coin_id
     WHERE h.participant_id = $1 AND h.quantity > 0
     ORDER BY h.coin_id`,
    [participantId]
  )).rows;
  const currentCash = parseFloat(row.current_cash);
  const holdingsValue = parseFloat(row.holdings_value);

  // V2-2 Power view: lazy reconciliation of the stored pair against the
  // authoritative read instant. Read-only — nothing is persisted here.
  const powerConfig = powerDomain.resolvePowerConfig();
  const powerReadMs = Date.now();
  const storedPower = Number(row.power);
  const powerUpdatedAtMs = new Date(row.power_updated_at).getTime();
  const reconciled = powerDomain.reconcilePower({
    storedPower,
    updatedAtMs: powerUpdatedAtMs,
    nowMs: powerReadMs,
    maxPower: powerConfig.maxPower,
    regenMsPerPoint: powerConfig.regenMsPerPoint
  });

  return {
    participantId: row.participant_id,
    cycleId: row.cycle_id,
    apocalypseId: row.apocalypse_id,
    userId: row.user_id,
    isBot: row.is_bot === true,
    joinedAt: new Date(row.joined_at).toISOString(),
    startingCash: parseFloat(row.starting_cash),
    currentCash,
    holdingsValue,
    wealth: round2(currentCash + holdingsValue),
    peakWealth: parseFloat(row.peak_wealth),
    status: row.status,
    finalCash: row.final_cash === null ? null : parseFloat(row.final_cash),
    power: {
      current: reconciled.power,
      max: powerConfig.maxPower,
      regenMsPerPoint: powerConfig.regenMsPerPoint,
      secondsPerPoint: powerConfig.regenMsPerPoint / 1000,
      nextPointAt: reconciled.nextPointAtMs === null ? null : new Date(reconciled.nextPointAtMs).toISOString(),
      storedPower,
      powerUpdatedAt: new Date(row.power_updated_at).toISOString(),
      asOf: new Date(powerReadMs).toISOString()
    },
    holdings: holdings.map((h) => {
      const quantity = parseFloat(h.quantity);
      const costBasis = parseFloat(h.cost_basis);
      const currentPrice = parseFloat(h.current_price);
      const currentValue = parseFloat(h.current_value);
      const unrealizedPnl = round2(currentValue - costBasis);
      return {
        coinId: h.coin_id,
        symbol: h.symbol,
        quantity,
        costBasis,
        averageEntryPrice: quantity > 0 ? Math.round((costBasis / quantity) * 10000) / 10000 : null,
        currentPrice,
        currentValue,
        unrealizedPnl,
        unrealizedPnlPct: costBasis > 0 ? Math.round((unrealizedPnl / costBasis) * 10000) / 100 : null
      };
    })
  };
}

// ---------------------------------------------------------------------------
// Join: create/reuse the caller's participant for the authoritative ACTIVE
// cycle. Idempotent under repetition AND genuine concurrency — the database
// UNIQUE (cycle_id, user_id) constraint is the backstop and the advisory
// lock serialises the attempt with rollover.
// ---------------------------------------------------------------------------
async function joinRound({ userId, now = new Date() } = {}) {
  const startingCash = resolveGameStartingCash();
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();

  // Retry bound: each pass reconciles the cycle first, then joins under the
  // advisory lock. A pass only retries when rollover landed between the two.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Lazy require: avoids the load-time cycle gameCycleService -> this
    // module -> gameCycleService.
    const { reconcileCycle } = require('./gameCycleService');
    await reconcileCycle({ now });

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [GAME_CYCLE_ADVISORY_LOCK_KEY]);

      const { rows: cycleRows } = await client.query(
        `SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE' LIMIT 1`
      );
      const cycle = cycleRows[0];
      if (!cycle || new Date(cycle.end_time).getTime() <= nowMs) {
        // Rollover interleaved between reconcile and lock; retry fresh.
        await client.query('ROLLBACK');
        continue;
      }

      // Create exactly once. ON CONFLICT DO NOTHING makes a repeated or
      // concurrent join a pure no-op: starting cash, cash, join time and
      // peak are never reset.
      // V2-2: the persistent Power pair (power, power_updated_at) is carried
      // VERBATIM from the user's most recent earlier-cycle participant, so
      // Power survives apocalypse rollover, restart and inactivity; lazy
      // reconciliation against real elapsed time does the rest. A user with
      // no earlier participant (new player) starts at the full game-design
      // maximum, stamped now.
      const inserted = await client.query(
        `INSERT INTO apocalypse_participants
           (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status, power, power_updated_at)
         SELECT $1, $2, $3, $3, $3, 'ACTIVE',
                COALESCE(prev.power, $4),
                COALESCE(prev.power_updated_at, now())
         FROM (SELECT 1) AS seed_row
         LEFT JOIN LATERAL (
           SELECT p.power, p.power_updated_at
           FROM apocalypse_participants p
           WHERE p.user_id = $2 AND p.cycle_id < $1
           ORDER BY p.cycle_id DESC
           LIMIT 1
         ) prev ON true
         ON CONFLICT (cycle_id, user_id) DO NOTHING
         RETURNING participant_id`,
        [cycle.cycle_id, userId, startingCash, resolveGamePowerMax()]
      );

      let participantId;
      if (inserted.rows.length > 0) {
        participantId = inserted.rows[0].participant_id;
      } else {
        const { rows: existing } = await client.query(
          `SELECT participant_id FROM apocalypse_participants
           WHERE cycle_id = $1 AND user_id = $2`,
          [cycle.cycle_id, userId]
        );
        participantId = existing[0].participant_id;
      }

      const state = await getParticipantRoundState(participantId, client);
      await client.query('COMMIT');
      return state;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error('joinRound: unable to settle on an active cycle after repeated rollover reconciliation');
}

// ---------------------------------------------------------------------------
// Buy: atomic round purchase. Debits ONLY the participant's round cash,
// upserts ONLY the round holding, and appends ONLY a round transaction — all
// at the server-side authoritative price, inside one advisory-locked
// transaction. Any validation failure rolls back cash/holding/transaction
// entirely. users.funds / portfolios / transactions are never touched.
// ---------------------------------------------------------------------------
async function buyRoundTrade({ userId, apocalypseId, coinId, quantity: rawQuantity, now = new Date() } = {}) {
  const cycleIdParam = validateApocalypseId(apocalypseId);
  const quantity = validateQuantity(rawQuantity);
  const coinIdNum = Number(coinId);
  if (!Number.isInteger(coinIdNum) || coinIdNum <= 0) {
    throw new GameRoundError('Invalid coin_id.', 400);
  }
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [GAME_CYCLE_ADVISORY_LOCK_KEY]);

    const cycle = await lockLiveCycle(client, cycleIdParam, nowMs);

    // Lock the authoritative coin row for a consistent, current price.
    // Milestone 1: the coin lock is taken BEFORE the participant lock. Every
    // path that touches both takes them in coins -> participants order (the
    // simulator's write transaction locks all coins then updates participants
    // via reconcileActivePeaks; settlement executes coin collapses before
    // finalizing participants). The previous participant -> coin order
    // deadlocked against the simulator under load.
    const { rows: coinRows } = await client.query(
      `SELECT coin_id, symbol, current_price, retired FROM coins WHERE coin_id = $1 FOR UPDATE`,
      [coinIdNum]
    );
    const coin = coinRows[0];
    if (!coin) {
      throw new GameRoundError(`Coin ${coinIdNum} not found.`, 404);
    }

    // Migration 014: retired coins are preserved history, not catalogue —
    // they can never be bought in a round (selling an existing holding
    // remains possible via the sell path).
    if (coin.retired) {
      throw new GameRoundError(
        `Coin ${coin.symbol} has been retired from the catalogue and cannot be purchased.`,
        400
      );
    }

    const participant = await lockParticipant(client, cycle.cycle_id, userId);

    // A coin collapsed in THIS cycle is dead: buying at £0 would hand out
    // free coins, and its live price is exactly 0 anyway.
    const collapsed = await isCoinCollapsedInCycle(client, cycle.cycle_id, coinIdNum);
    const price = parseFloat(coin.current_price);
    if (collapsed || !(price > 0)) {
      throw new GameRoundError(
        `Coin ${coin.symbol} has collapsed to £0 in this apocalypse cycle and cannot be purchased.`,
        400
      );
    }

    // The price is always the server-side locked row — never client input.
    const total = round2(quantity * price);

    // Minimum notional: a positive quantity whose 2-decimal cost rounds to
    // £0.00 would mint holdings for free (repeatable). Reject before any
    // write. (Buys only reach here at a live price > 0.)
    assertMinTradeValue(total, 'buy');

    // Cash affordability pre-check from the row-locked participant (the
    // atomic debit below remains the concurrency backstop). Checked before
    // Power so the rejection names the binding constraint.
    const participantCash = parseFloat(participant.current_cash);
    if (total > participantCash) {
      throw new GameRoundError(
        `Insufficient round cash. You need £${total.toFixed(2)} but have £${participantCash.toFixed(2)}.`,
        400
      );
    }

    // V2-2 position limit: at most GAME_MAX_OPEN_POSITIONS distinct OPEN
    // LIVE positions. A live position is a holding with quantity > 0 whose
    // coin has NOT collapsed in this cycle; collapsed and zero-quantity
    // holdings are history and never consume a slot. Adding to an existing
    // live position (same coin) is always allowed. Enforced HERE, inside
    // the advisory-locked transaction — never only in a controller/client.
    const { rows: liveRows } = await client.query(
      `SELECT h.coin_id
       FROM apocalypse_holdings h
       WHERE h.participant_id = $1 AND h.quantity > 0
         AND NOT EXISTS (
           SELECT 1 FROM coin_collapse_schedule s
           WHERE s.cycle_id = h.cycle_id AND s.coin_id = h.coin_id
             AND s.executed_at IS NOT NULL
         )`,
      [participant.participant_id]
    );
    const positionLimit = powerDomain.evaluatePositionLimit({
      liveCoinIds: liveRows.map((r) => r.coin_id),
      coinId: coinIdNum
    });
    if (!positionLimit.allowed) {
      throw new GameRoundError(
        `Position limit reached: you may hold at most ${resolveGameMaxOpenPositions()} different open live positions and already have ${positionLimit.openPositions}. Sell one down before opening a new coin, or add to an existing position.`,
        400
      );
    }

    // V2-2 Power: a BUY costs 1 + floor(total / divisor) Power, computed
    // by the SAME shared domain the simulator uses. The stored pair from the
    // row-locked participant is reconciled against the authoritative now;
    // the post-spend pair is written atomically with the cash debit below,
    // so a failed buy (any throw before/inside this transaction) consumes NO
    // Power. A SELL never touches this path and always costs zero Power.
    const powerCost = powerDomain.buyPowerCost(total);
    const powerSpend = powerDomain.spendPower({
      storedPower: Number(participant.power),
      updatedAtMs: new Date(participant.power_updated_at).getTime(),
      nowMs,
      cost: powerCost
    });
    if (!powerSpend) {
      const { power: effectivePower } = powerDomain.reconcilePower({
        storedPower: Number(participant.power),
        updatedAtMs: new Date(participant.power_updated_at).getTime(),
        nowMs
      });
      const regenSeconds = Math.round(powerDomain.resolvePowerConfig().regenMsPerPoint / 1000);
      throw new GameRoundError(
        `Insufficient Power. This buy costs ${powerCost} Power but you have ${effectivePower}. Power regenerates +1 every ${regenSeconds} seconds; selling is always free.`,
        400
      );
    }

    // Atomic affordability + Power spend: the debit itself enforces
    // sufficient round cash, so concurrent buys can never overspend cash OR
    // Power. The participant row is already locked FOR UPDATE and every game
    // mutation serialises on the advisory lock, so the JS-computed post-
    // spend Power pair cannot race.
    const { rowCount } = await client.query(
      `UPDATE apocalypse_participants
       SET current_cash = current_cash - $1,
           power = $2,
           power_updated_at = $3,
           updated_at = now()
       WHERE participant_id = $4 AND status = 'ACTIVE' AND current_cash >= $1`,
      [total, powerSpend.power, new Date(powerSpend.updatedAtMs), participant.participant_id]
    );
    if (rowCount !== 1) {
      const { rows: fresh } = await client.query(
        `SELECT current_cash FROM apocalypse_participants WHERE participant_id = $1`,
        [participant.participant_id]
      );
      throw new GameRoundError(
        `Insufficient round cash. You need £${total.toFixed(2)} but have £${parseFloat(fresh[0].current_cash).toFixed(2)}.`,
        400
      );
    }

    // V2-2 cost basis: a BUY adds its rounded consideration to the remaining
    // basis (weighted-average accounting), in the same upsert, in SQL so the
    // DECIMAL(18,2) arithmetic is exact.
    await client.query(
      `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (participant_id, coin_id)
       DO UPDATE SET quantity = apocalypse_holdings.quantity + EXCLUDED.quantity,
                     cost_basis = ROUND(apocalypse_holdings.cost_basis + EXCLUDED.cost_basis, 2),
                     updated_at = now()`,
      [participant.participant_id, cycle.cycle_id, userId, coinIdNum, quantity, total]
    );

    const { rows: txRows } = await client.query(
      `INSERT INTO apocalypse_transactions
         (participant_id, cycle_id, user_id, coin_id, type, quantity, price, total_amount)
       VALUES ($1, $2, $3, $4, 'BUY', $5, $6, $7)
       RETURNING round_transaction_id`,
      [participant.participant_id, cycle.cycle_id, userId, coinIdNum, quantity, price, total]
    );

    const updated = await refreshWealthAndPeak(client, participant.participant_id);
    const state = await getParticipantRoundState(participant.participant_id, client);
    await client.query('COMMIT');

    return {
      transaction: {
        roundTransactionId: txRows[0].round_transaction_id,
        type: 'BUY',
        coinId: coinIdNum,
        quantity,
        price,
        totalAmount: total
      },
      participant: state,
      peakWealth: parseFloat(updated.peak_wealth)
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Sell: atomic round sale with the same cycle/participant/ownership
// protections. Oversell is rejected by the holding-decrement itself, so
// concurrent sells can never produce negative holdings. A Core-3 collapsed
// holding sells at the authoritative £0 and credits exactly zero cash.
// ---------------------------------------------------------------------------
async function sellRoundTrade({ userId, apocalypseId, coinId, quantity: rawQuantity, now = new Date() } = {}) {
  const cycleIdParam = validateApocalypseId(apocalypseId);
  const quantity = validateQuantity(rawQuantity);
  const coinIdNum = Number(coinId);
  if (!Number.isInteger(coinIdNum) || coinIdNum <= 0) {
    throw new GameRoundError('Invalid coin_id.', 400);
  }
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [GAME_CYCLE_ADVISORY_LOCK_KEY]);

    const cycle = await lockLiveCycle(client, cycleIdParam, nowMs);

    // Lock the authoritative coin row; the sale price is server-side only.
    // Milestone 1: same coins -> participants lock order as buy (see the
    // buyRoundTrade note) — taken before the participant lock so a trade can
    // never deadlock against the simulator's coins -> participants batch.
    const { rows: coinRows } = await client.query(
      `SELECT coin_id, symbol, current_price FROM coins WHERE coin_id = $1 FOR UPDATE`,
      [coinIdNum]
    );
    const coin = coinRows[0];
    if (!coin) {
      throw new GameRoundError(`Coin ${coinIdNum} not found.`, 404);
    }
    const price = parseFloat(coin.current_price);

    const participant = await lockParticipant(client, cycle.cycle_id, userId);

    // Lock THIS participant's holding for THIS coin in THIS cycle. Holdings
    // from another cycle (or another user) are invisible here — a sale can
    // only ever touch the caller's current-round position.
    const { rows: holdingRows } = await client.query(
      `SELECT holding_id, quantity FROM apocalypse_holdings
       WHERE participant_id = $1 AND coin_id = $2
       FOR UPDATE`,
      [participant.participant_id, coinIdNum]
    );
    const holding = holdingRows[0];
    const held = holding ? parseFloat(holding.quantity) : 0;
    if (!holding || held < quantity) {
      throw new GameRoundError(
        `Insufficient round holdings. You have ${formatQuantityText(held)} of ${coin.symbol} available to sell in this cycle.`,
        400
      );
    }

    // Compute the authoritative proceeds BEFORE any write. A collapsed coin
    // has price exactly £0: the Core 3 exit path stands — total is exactly 0
    // and the credit adds exactly zero cash (a dead holding has no value to
    // protect). At any LIVE price, a sale whose rounded proceeds fall below
    // one penny would silently destroy holdings for £0.00 — reject it.
    const total = round2(quantity * price);
    if (price > 0) {
      assertMinTradeValue(total, 'sale');
    }

    // Atomic decrement: the guarded UPDATE is the oversell backstop even if
    // the row state changed between the lock check and the write.
    // V2-2 cost basis: the same statement removes the PROPORTIONATE share of
    // the remaining basis (SET expressions read the pre-update quantity, so
    // cost_basis * (quantity - $1) / quantity is exactly the weighted-
    // average remainder; a full sale zeroes it). A SELL never touches Power.
    const { rowCount } = await client.query(
      `UPDATE apocalypse_holdings
       SET quantity = quantity - $1,
           cost_basis = ROUND(cost_basis * (quantity - $1) / quantity, 2),
           updated_at = now()
       WHERE holding_id = $2 AND quantity >= $1`,
      [quantity, holding.holding_id]
    );
    if (rowCount !== 1) {
      throw new GameRoundError(
        `Insufficient round holdings. You have ${formatQuantityText(held)} of ${coin.symbol} available to sell in this cycle.`,
        400
      );
    }

    await client.query(
      `UPDATE apocalypse_participants
       SET current_cash = current_cash + $1, updated_at = now()
       WHERE participant_id = $2`,
      [total, participant.participant_id]
    );

    const { rows: txRows } = await client.query(
      `INSERT INTO apocalypse_transactions
         (participant_id, cycle_id, user_id, coin_id, type, quantity, price, total_amount)
       VALUES ($1, $2, $3, $4, 'SELL', $5, $6, $7)
       RETURNING round_transaction_id`,
      [participant.participant_id, cycle.cycle_id, userId, coinIdNum, quantity, price, total]
    );

    const updated = await refreshWealthAndPeak(client, participant.participant_id);
    const state = await getParticipantRoundState(participant.participant_id, client);
    await client.query('COMMIT');

    return {
      transaction: {
        roundTransactionId: txRows[0].round_transaction_id,
        type: 'SELL',
        coinId: coinIdNum,
        quantity,
        price,
        totalAmount: total
      },
      participant: state,
      peakWealth: parseFloat(updated.peak_wealth)
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Cycle-start participant initialization (issue #17: continuous automatic
// participation). Called by gameCycleService INSIDE the Core 1
// advisory-locked cycle transaction — both when a brand-new cycle is
// inserted and when a pre-existing ACTIVE cycle is recovered — so EVERY
// registered user (humans AND the configured bots, who are users rows with
// is_bot = true) has exactly one participant row for the current cycle with
// exactly the authoritative starting cash, whether or not any human is
// online. Set-based and idempotent: ON CONFLICT (cycle_id, user_id) DO
// NOTHING means retries, restarts, duplicate workers and the per-request
// joinRound path can never duplicate a participant or re-award starting
// cash; a mid-cycle registration is picked up by the next reconciliation.
// Nothing is read from or written to users.funds.
// ---------------------------------------------------------------------------
async function initializeCycleParticipants(client, cycleId) {
  const startingCash = resolveGameStartingCash();
  // V2-2: each new participant's Power pair is carried verbatim from the
  // user's most recent earlier-cycle participant (persistent Power across
  // rollover); brand-new players start at the full game-design maximum.
  const { rowCount } = await client.query(
    `INSERT INTO apocalypse_participants
       (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status, power, power_updated_at)
     SELECT $1, u.user_id, $2, $2, $2, 'ACTIVE',
            COALESCE(prev.power, $3),
            COALESCE(prev.power_updated_at, now())
     FROM users u
     LEFT JOIN LATERAL (
       SELECT p.power, p.power_updated_at
       FROM apocalypse_participants p
       WHERE p.user_id = u.user_id AND p.cycle_id < $1
       ORDER BY p.cycle_id DESC
       LIMIT 1
     ) prev ON true
     ORDER BY u.user_id
     ON CONFLICT (cycle_id, user_id) DO NOTHING`,
    [cycleId, startingCash, resolveGamePowerMax()]
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// Lifecycle finalization hook. Called by gameCycleService.reconcileCycle
// INSIDE the Core 1 advisory-locked transaction, AFTER Core 3 has executed
// the final £0 collapses for the expiring cycle and BEFORE the cycle is
// marked COMPLETED and its successor created. Every active participant is
// marked FINALIZED with final_cash copied from the authoritative
// current_cash. Nothing transfers to the successor cycle; a join there
// starts at the game starting cash. Idempotent: replay only ever matches
// rows still ACTIVE, so a second run is a no-op.
// ---------------------------------------------------------------------------
async function finalizeCycleParticipants(client, cycleId) {
  const { rowCount } = await client.query(
    `UPDATE apocalypse_participants
     SET status = 'FINALIZED', final_cash = current_cash, updated_at = now()
     WHERE cycle_id = $1 AND status = 'ACTIVE'`,
    [cycleId]
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// Set-based peak reconciliation for the market update architecture. One SQL
// statement recomputes wealth for every ACTIVE-cycle ACTIVE participant from
// live prices and lifts peak_wealth monotonically — no per-participant
// JavaScript loop. Called inside the market simulator's write transaction so
// peaks track price batches atomically.
// ---------------------------------------------------------------------------
async function reconcileActivePeaks(client) {
  const { rowCount } = await client.query(
    `WITH wealth AS (
       SELECT p.participant_id,
              p.current_cash + COALESCE(SUM(h.quantity * c.current_price), 0) AS wealth
       FROM apocalypse_participants p
       JOIN apocalypse_cycles ac ON ac.cycle_id = p.cycle_id AND ac.status = 'ACTIVE'
       LEFT JOIN apocalypse_holdings h ON h.participant_id = p.participant_id
       LEFT JOIN coins c ON c.coin_id = h.coin_id
       WHERE p.status = 'ACTIVE'
       GROUP BY p.participant_id, p.current_cash
     )
     UPDATE apocalypse_participants p
     SET peak_wealth = GREATEST(p.peak_wealth, w.wealth), updated_at = now()
     FROM wealth w
     WHERE p.participant_id = w.participant_id
       AND w.wealth > p.peak_wealth`,
    []
  );
  return rowCount;
}

module.exports = {
  GAME_STARTING_CASH,
  GameRoundError,
  joinRound,
  buyRoundTrade,
  sellRoundTrade,
  getParticipantRoundState,
  initializeCycleParticipants,
  finalizeCycleParticipants,
  reconcileActivePeaks
};
