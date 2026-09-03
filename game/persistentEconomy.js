// Persistent-market Stage 5 (master plan §11/§13): THE one writable
// persistent gameplay economy — accounts, holdings and the append-only
// trade ledger (migration 026), scoped to THE active persistent world.
//
// This module adapts the proven Apocalypse round-trade transaction
// (game/gameRoundService.js#buyRoundTrade/sellRoundTrade) to the persistent
// economy, preserving its exact safety shape:
//   * exactly ONE acquired pg client owns the whole trade: BEGIN, the
//     FOR UPDATE validation reads, the guarded cash/holding mutations, the
//     ledger insert, COMMIT or ROLLBACK, release;
//   * the execution price is ALWAYS the server-side locked coin row —
//     never client input;
//   * coins-before-account lock order (every path that touches both takes
//     coins first — the market writer's batch locks all coins first too),
//     so trades can never deadlock against the writer;
//   * guarded SQL writes are the concurrency backstop: the cash debit
//     carries `cash >= $1` and the holding decrement carries
//     `quantity >= $1`, so concurrent trades can never overspend or
//     oversell even if a row changes between the lock read and the write;
//   * validation, the £0.01 minimum notional, weighted-average cost basis
//     and ledger-after-success are all preserved.
//
// Exactly-once £10,000 (master plan §13): the account row IS the receipt.
// Provisioning inserts starting_cash = cash = £10,000 in ONE statement
// guarded by UNIQUE (world_id, user_id); any replay (retry, restart,
// double registration, concurrent first trades) is a no-op read of the
// existing row. There is no second grant path anywhere.
//
// Legacy apocalypse_* / users.funds / portfolios data is historical archive
// and is NEVER read or written here.
//
// Death semantics (Stage 9 contract, enforced here): a persistently DEAD
// coin cannot be traded in either direction — trading stops at death; its
// holdings remain on the books as history and value at £0. A coin with no
// recorded persistent state yet (the writer's first batch has not opened
// it) trades normally at the server-locked live price.

const db = require('../db/connection');
const persistentWorld = require('./persistentWorld');
const {
  GAME_MIN_TRADE_VALUE,
  GAME_QUANTITY_DECIMALS,
  GAME_QUANTITY_MAX
} = require('./gameConstants');

// The exactly-once virtual starting grant (master plan §13).
const PERSISTENT_STARTING_CASH = 10000;

// Bounded transaction-history read (Stage 6 frontend): the ledger is
// append-only and unbounded, so every read carries an explicit limit.
const PERSISTENT_TRANSACTIONS_DEFAULT_LIMIT = 50;
const PERSISTENT_TRANSACTIONS_MAX_LIMIT = 100;

// Parse the bounded-history limit. Absent → the default; present → a
// positive integer no larger than the hard cap (a larger window is a new
// contract, not silent clamping). Anything else is a loud 400.
function validateTransactionLimit(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return PERSISTENT_TRANSACTIONS_DEFAULT_LIMIT;
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new PersistentEconomyError('Invalid limit. Provide a positive whole number.', 400);
  }
  const limit = Number(text);
  if (limit < 1 || limit > PERSISTENT_TRANSACTIONS_MAX_LIMIT) {
    throw new PersistentEconomyError(
      `Invalid limit. The persistent history read returns at most ${PERSISTENT_TRANSACTIONS_MAX_LIMIT} rows per request.`,
      400
    );
  }
  return limit;
}

// Domain error carrying an HTTP status for the controller layer. Unknown
// errors still fall through to the generic 500 handler.
class PersistentEconomyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PersistentEconomyError';
    this.status = status;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function formatQuantityText(value) {
  return Number(value).toLocaleString('en-GB', { maximumFractionDigits: GAME_QUANTITY_DECIMALS });
}

// Significant decimal places of a plain decimal string (no exponent form).
function significantDecimalPlaces(text) {
  const dot = text.indexOf('.');
  if (dot === -1) return 0;
  return text.length - dot - 1;
}

const PLAIN_QUANTITY_PATTERN = /^\d+(\.\d+)?$/;

// Mirror of the round economy's quantity contract: a positive finite
// decimal with at most GAME_QUANTITY_DECIMALS places, below the storable
// maximum. Never silently rounded.
function validateQuantity(raw) {
  const invalid = () => new PersistentEconomyError(
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
    throw new PersistentEconomyError(
      `Invalid quantity. Quantities support up to ${GAME_QUANTITY_DECIMALS} decimal places; ${text} needs ${places} and would have to be rounded. Reduce the precision instead.`,
      400
    );
  }
  if (quantity >= GAME_QUANTITY_MAX) {
    throw new PersistentEconomyError(
      'Invalid quantity. Quantity exceeds the maximum storable value.',
      400
    );
  }
  return quantity;
}

function validateIds(userId, coinId) {
  const userIdNum = Number(userId);
  if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
    throw new PersistentEconomyError('Invalid user_id.', 400);
  }
  const coinIdNum = Number(coinId);
  if (!Number.isInteger(coinIdNum) || coinIdNum <= 0) {
    throw new PersistentEconomyError('Invalid coin_id.', 400);
  }
  return { userIdNum, coinIdNum };
}

function assertMinTradeValue(total, side) {
  if (total < GAME_MIN_TRADE_VALUE) {
    throw new PersistentEconomyError(
      `Trade value must be at least £${GAME_MIN_TRADE_VALUE.toFixed(2)}. This ${side} totals £${total.toFixed(2)} at the current price.`,
      400
    );
  }
}

function rowToAccount(row) {
  return {
    accountId: Number(row.account_id),
    worldId: Number(row.world_id),
    userId: Number(row.user_id),
    startingCash: parseFloat(row.starting_cash),
    cash: parseFloat(row.cash),
    debt: parseFloat(row.debt),
    provisionedAt: new Date(row.provisioned_at).toISOString()
  };
}

// Provision THE user's persistent account in THE active world — idempotent
// and exactly-once. The INSERT carries the full £10,000 grant; the
// UNIQUE (world_id, user_id) constraint turns every replay into a no-op
// read. Runs on the caller's client when provided so it can participate in
// a surrounding transaction (the trade paths provision inside theirs).
async function provisionPersistentAccount({ userId, queryable = db } = {}) {
  const userIdNum = Number(userId);
  if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
    throw new PersistentEconomyError('Invalid user_id.', 400);
  }
  const world = await persistentWorld.resolveActiveWorld(queryable);
  await queryable.query(
    `INSERT INTO persistent_accounts (world_id, user_id, starting_cash, cash)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (world_id, user_id) DO NOTHING`,
    [world.worldId, userIdNum, PERSISTENT_STARTING_CASH]
  );
  const { rows } = await queryable.query(
    `SELECT account_id, world_id, user_id, starting_cash, cash, debt, provisioned_at
       FROM persistent_accounts
      WHERE world_id = $1 AND user_id = $2`,
    [world.worldId, userIdNum]
  );
  return rowToAccount(rows[0]);
}

// Trade-path account resolution: provision (idempotent, exactly-once) then
// lock the row FOR UPDATE inside the trade transaction. Two concurrent
// first trades serialise on the unique key's speculative insertion and then
// on the row lock — the grant can never double.
async function lockOrProvisionAccount(client, world, userIdNum) {
  await client.query(
    `INSERT INTO persistent_accounts (world_id, user_id, starting_cash, cash)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (world_id, user_id) DO NOTHING`,
    [world.worldId, userIdNum, PERSISTENT_STARTING_CASH]
  );
  const { rows } = await client.query(
    `SELECT account_id, world_id, user_id, starting_cash, cash, provisioned_at
       FROM persistent_accounts
      WHERE world_id = $1 AND user_id = $2
      FOR UPDATE`,
    [world.worldId, userIdNum]
  );
  return rows[0];
}

// The persistent death read: the coin's committed market-state status in
// this world. No row yet means the writer has not opened the state — the
// coin is tradable at the server-locked live price. DEAD stops trading in
// both directions (Stage 9 contract).
async function persistentCoinStatus(client, worldId, coinIdNum) {
  const { rows } = await client.query(
    'SELECT status FROM market_coin_state WHERE world_id = $1 AND coin_id = $2',
    [worldId, coinIdNum]
  );
  return rows.length === 0 ? 'ALIVE' : rows[0].status;
}

// ---------------------------------------------------------------------------
// Persistent BUY. Atomic: server-locked price, guarded cash debit
// (cash >= total is enforced BY the debit itself), weighted-average cost
// basis upsert, ledger row after success — all in ONE transaction on ONE
// client. Any validation failure rolls back cash/holding/ledger entirely.
// ---------------------------------------------------------------------------
async function buyPersistentTrade({ userId, coinId, quantity: rawQuantity } = {}) {
  const { userIdNum, coinIdNum } = validateIds(userId, coinId);
  const quantity = validateQuantity(rawQuantity);

  const world = await persistentWorld.resolveActiveWorld(db);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock the authoritative coin row FIRST (coins-before-account order —
    // the market writer's batch locks all coins first too). The price is
    // always the server-side locked row, never client input.
    const { rows: coinRows } = await client.query(
      'SELECT coin_id, symbol, current_price, retired FROM coins WHERE coin_id = $1 FOR UPDATE',
      [coinIdNum]
    );
    const coin = coinRows[0];
    if (!coin) {
      throw new PersistentEconomyError(`Coin ${coinIdNum} not found.`, 404);
    }
    if (coin.retired) {
      throw new PersistentEconomyError(
        `Coin ${coin.symbol} has been retired from the catalogue and cannot be purchased.`,
        400
      );
    }

    // Persistent death stops trading in both directions (Stage 9 contract).
    const status = await persistentCoinStatus(client, world.worldId, coinIdNum);
    if (status === 'DEAD') {
      throw new PersistentEconomyError(
        `Coin ${coin.symbol} is permanently dead in the persistent market; trading has stopped.`,
        400
      );
    }

    const price = parseFloat(coin.current_price);
    if (!(price > 0)) {
      throw new PersistentEconomyError(
        `Coin ${coin.symbol} has no live price and cannot be purchased.`,
        400
      );
    }

    // Provision-if-needed then lock THE account (exactly-once £10,000 by
    // UNIQUE (world_id, user_id); the lock serialises concurrent trades).
    const account = await lockOrProvisionAccount(client, world, userIdNum);

    const total = round2(quantity * price);
    // Minimum notional: a positive quantity whose 2-decimal cost rounds to
    // £0.00 would mint holdings for free (repeatable). Reject before any
    // write.
    assertMinTradeValue(total, 'buy');

    // Cash affordability pre-check from the row-locked account (the atomic
    // debit below remains the concurrency backstop).
    const cash = parseFloat(account.cash);
    if (total > cash) {
      throw new PersistentEconomyError(
        `Insufficient persistent cash. You need £${total.toFixed(2)} but have £${cash.toFixed(2)}.`,
        400
      );
    }

    // Atomic affordability: the debit itself enforces sufficient cash, so
    // concurrent buys can never overspend.
    const { rowCount } = await client.query(
      `UPDATE persistent_accounts
          SET cash = cash - $1, updated_at = now()
        WHERE account_id = $2 AND cash >= $1`,
      [total, account.account_id]
    );
    if (rowCount !== 1) {
      const { rows: fresh } = await client.query(
        'SELECT cash FROM persistent_accounts WHERE account_id = $1',
        [account.account_id]
      );
      throw new PersistentEconomyError(
        `Insufficient persistent cash. You need £${total.toFixed(2)} but have £${parseFloat(fresh[0].cash).toFixed(2)}.`,
        400
      );
    }

    // Weighted-average cost basis: a BUY adds its rounded consideration to
    // the remaining basis, in the same upsert, in SQL so the DECIMAL(18,2)
    // arithmetic is exact.
    await client.query(
      `INSERT INTO persistent_holdings (account_id, world_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, coin_id)
       DO UPDATE SET quantity = persistent_holdings.quantity + EXCLUDED.quantity,
                     cost_basis = ROUND(persistent_holdings.cost_basis + EXCLUDED.cost_basis, 2),
                     updated_at = now()`,
      [account.account_id, world.worldId, userIdNum, coinIdNum, quantity, total]
    );

    // Ledger AFTER success, in the same transaction.
    const { rows: txRows } = await client.query(
      `INSERT INTO persistent_transactions
         (account_id, world_id, user_id, coin_id, type, quantity, price, total_amount)
       VALUES ($1, $2, $3, $4, 'BUY', $5, $6, $7)
       RETURNING persistent_transaction_id`,
      [account.account_id, world.worldId, userIdNum, coinIdNum, quantity, price, total]
    );

    const state = await getPersistentAccountState({ userId: userIdNum, queryable: client });
    await client.query('COMMIT');

    return {
      transaction: {
        persistentTransactionId: txRows[0].persistent_transaction_id,
        type: 'BUY',
        coinId: coinIdNum,
        quantity,
        price,
        totalAmount: total
      },
      account: state
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Persistent SELL. Atomic: server-locked price, the guarded holding
// decrement is the oversell backstop (quantity >= sold enforced BY the
// UPDATE), the same statement removes the PROPORTIONATE share of the
// remaining cost basis (a full sale zeroes it), cash credit and ledger row
// land in the same transaction.
// ---------------------------------------------------------------------------
async function sellPersistentTrade({ userId, coinId, quantity: rawQuantity } = {}) {
  const { userIdNum, coinIdNum } = validateIds(userId, coinId);
  const quantity = validateQuantity(rawQuantity);

  const world = await persistentWorld.resolveActiveWorld(db);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock the authoritative coin row; the sale price is server-side only.
    const { rows: coinRows } = await client.query(
      'SELECT coin_id, symbol, current_price FROM coins WHERE coin_id = $1 FOR UPDATE',
      [coinIdNum]
    );
    const coin = coinRows[0];
    if (!coin) {
      throw new PersistentEconomyError(`Coin ${coinIdNum} not found.`, 404);
    }

    // Persistent death stops trading in both directions (Stage 9 contract):
    // a dead holding is unsellable history valued at £0.
    const status = await persistentCoinStatus(client, world.worldId, coinIdNum);
    if (status === 'DEAD') {
      throw new PersistentEconomyError(
        `Coin ${coin.symbol} is permanently dead in the persistent market; trading has stopped.`,
        400
      );
    }

    const price = parseFloat(coin.current_price);
    if (!(price > 0)) {
      throw new PersistentEconomyError(
        `Coin ${coin.symbol} has no live price and cannot be sold.`,
        400
      );
    }

    const account = await lockOrProvisionAccount(client, world, userIdNum);

    // Lock THIS account's holding for THIS coin. Holdings from another
    // world (or another user) are invisible here.
    const { rows: holdingRows } = await client.query(
      `SELECT holding_id, quantity FROM persistent_holdings
        WHERE account_id = $1 AND coin_id = $2
        FOR UPDATE`,
      [account.account_id, coinIdNum]
    );
    const holding = holdingRows[0];
    const held = holding ? parseFloat(holding.quantity) : 0;
    if (!holding || held < quantity) {
      throw new PersistentEconomyError(
        `Insufficient persistent holdings. You have ${formatQuantityText(held)} of ${coin.symbol} available to sell.`,
        400
      );
    }

    const total = round2(quantity * price);
    // A sale whose rounded proceeds fall below one penny would silently
    // destroy holdings for £0.00 — reject it. (Live prices are always
    // strictly positive in the persistent market.)
    assertMinTradeValue(total, 'sale');

    // Atomic decrement: the guarded UPDATE is the oversell backstop even if
    // the row state changed between the lock check and the write. The same
    // statement removes the PROPORTIONATE share of the remaining basis
    // (SET expressions read the pre-update quantity; a full sale zeroes it).
    const { rowCount } = await client.query(
      `UPDATE persistent_holdings
          SET quantity = quantity - $1,
              cost_basis = ROUND(cost_basis * (quantity - $1) / quantity, 2),
              updated_at = now()
        WHERE holding_id = $2 AND quantity >= $1`,
      [quantity, holding.holding_id]
    );
    if (rowCount !== 1) {
      throw new PersistentEconomyError(
        `Insufficient persistent holdings. You have ${formatQuantityText(held)} of ${coin.symbol} available to sell.`,
        400
      );
    }

    await client.query(
      `UPDATE persistent_accounts
          SET cash = cash + $1, updated_at = now()
        WHERE account_id = $2`,
      [total, account.account_id]
    );

    const { rows: txRows } = await client.query(
      `INSERT INTO persistent_transactions
         (account_id, world_id, user_id, coin_id, type, quantity, price, total_amount)
       VALUES ($1, $2, $3, $4, 'SELL', $5, $6, $7)
       RETURNING persistent_transaction_id`,
      [account.account_id, world.worldId, userIdNum, coinIdNum, quantity, price, total]
    );

    const state = await getPersistentAccountState({ userId: userIdNum, queryable: client });
    await client.query('COMMIT');

    return {
      transaction: {
        persistentTransactionId: txRows[0].persistent_transaction_id,
        type: 'SELL',
        coinId: coinIdNum,
        quantity,
        price,
        totalAmount: total
      },
      account: state
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Player-safe reads. Wealth = cash + live holdings value at the current
// server prices (dead coins value at £0 — their price row is £0). No
// hidden state is exposed here: prices are the public coins.current_price.
// ---------------------------------------------------------------------------
async function getPersistentAccountState({ userId, queryable = db } = {}) {
  const userIdNum = Number(userId);
  if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
    throw new PersistentEconomyError('Invalid user_id.', 400);
  }
  const world = await persistentWorld.resolveActiveWorld(queryable);
  const { rows: accountRows } = await queryable.query(
    `SELECT account_id, world_id, user_id, starting_cash, cash, debt, provisioned_at
       FROM persistent_accounts
      WHERE world_id = $1 AND user_id = $2`,
    [world.worldId, userIdNum]
  );
  if (accountRows.length === 0) {
    return null; // not provisioned yet — the caller decides (Stage 6 registration provisions)
  }
  const account = rowToAccount(accountRows[0]);
  const { rows: holdingRows } = await queryable.query(
    `SELECT h.coin_id, c.symbol, h.quantity, h.cost_basis, c.current_price
       FROM persistent_holdings h
       JOIN coins c ON c.coin_id = h.coin_id
      WHERE h.account_id = $1 AND h.quantity > 0
      ORDER BY h.coin_id`,
    [account.accountId]
  );
  const holdings = holdingRows.map((row) => {
    const quantity = parseFloat(row.quantity);
    const price = parseFloat(row.current_price);
    const costBasis = parseFloat(row.cost_basis);
    const currentValue = round2(quantity * price);
    // Server-owned position economics (mirrors the V2-2 round holding
    // contract): the client never derives money. Rows are quantity > 0 by
    // the WHERE clause, so the average entry always exists here.
    const averageEntryPrice = quantity > 0 ? round2(costBasis / quantity) : null;
    const unrealizedPnl = round2(currentValue - costBasis);
    const unrealizedPnlPct = costBasis > 0 ? round2((unrealizedPnl / costBasis) * 100) : null;
    return {
      coinId: Number(row.coin_id),
      symbol: row.symbol,
      quantity,
      costBasis,
      averageEntryPrice,
      currentPrice: price,
      currentValue,
      unrealizedPnl,
      unrealizedPnlPct
    };
  });
  const holdingsValue = round2(holdings.reduce((sum, h) => sum + h.currentValue, 0));
  return {
    ...account,
    holdings,
    holdingsValue,
    wealth: round2(account.cash + holdingsValue),
    // Stage 8: debt-adjusted wealth — the Stage 10 persistent leaderboard
    // figure (cash + live holdings value - outstanding debt). Humans carry
    // debt = 0, so netWealth === wealth for them by construction.
    netWealth: round2(account.cash + holdingsValue - account.debt)
  };
}

// ---------------------------------------------------------------------------
// Bounded transaction history for the caller's own account (Stage 6 frontend
// portfolio/transactions flow). Newest first, hard-capped; public columns
// only (coin symbol via the catalogue join) — no world seed or internals.
// Returns null when the account is not provisioned yet (same convention as
// getPersistentAccountState; the controller maps it to provisioned:false).
// ---------------------------------------------------------------------------
async function getPersistentTransactions({ userId, limit, queryable = db } = {}) {
  const userIdNum = Number(userId);
  if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
    throw new PersistentEconomyError('Invalid user_id.', 400);
  }
  const bounded = validateTransactionLimit(limit);
  const world = await persistentWorld.resolveActiveWorld(queryable);
  const { rows: accountRows } = await queryable.query(
    `SELECT account_id FROM persistent_accounts
      WHERE world_id = $1 AND user_id = $2`,
    [world.worldId, userIdNum]
  );
  if (accountRows.length === 0) {
    return null;
  }
  const { rows } = await queryable.query(
    `SELECT t.persistent_transaction_id, t.type, t.coin_id, c.symbol,
            t.quantity, t.price, t.total_amount, t.created_at
       FROM persistent_transactions t
       JOIN coins c ON c.coin_id = t.coin_id
      WHERE t.account_id = $1
      ORDER BY t.persistent_transaction_id DESC
      LIMIT $2`,
    [accountRows[0].account_id, bounded]
  );
  return rows.map((row) => ({
    persistentTransactionId: Number(row.persistent_transaction_id),
    type: row.type,
    coinId: Number(row.coin_id),
    symbol: row.symbol,
    quantity: parseFloat(row.quantity),
    price: parseFloat(row.price),
    totalAmount: parseFloat(row.total_amount),
    createdAt: new Date(row.created_at).toISOString()
  }));
}

module.exports = {
  PERSISTENT_STARTING_CASH,
  PERSISTENT_TRANSACTIONS_DEFAULT_LIMIT,
  PERSISTENT_TRANSACTIONS_MAX_LIMIT,
  PersistentEconomyError,
  validateQuantity,
  validateTransactionLimit,
  provisionPersistentAccount,
  buyPersistentTrade,
  sellPersistentTrade,
  getPersistentAccountState,
  getPersistentTransactions
};
