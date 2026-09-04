// Persistent-market Stage 6: the persistent API surface.
//
// These endpoints expose THE persistent economy (game/persistentEconomy.js)
// to clients: authenticated persistent buy/sell at the server-locked live
// price, and the authenticated caller's persistent account state (cash,
// holdings at live value, wealth). The old cycle-shaped surface
// (/api/game/*, /api/transactions/*) is UNTOUCHED and keeps serving the old
// deployed frontend exactly as before (documented compatibility debt —
// removal is a post-deploy event, Stage 13).
//
// Contract:
//   * authenticated callers only ever act on their OWN account (the
//     authenticated user id is the account owner — never a body parameter);
//   * the execution price is server-owned (never client input);
//   * domain errors carry their HTTP status (400 validation / 404 missing);
//     unknown errors fall through to the generic handler;
//   * responses carry no internal state: no world seed, no Director
//     internals, no checkpoint accumulators — public account data only.
//
// Stage 10A (S10-01): public GET /api/persistent/leaderboard — read-only
// ranking of every provisioned persistent account in THE active world.

const persistentEconomy = require('../game/persistentEconomy');
const persistentLeaderboard = require('../game/persistentLeaderboard');

function statusOf(err) {
  return Number.isInteger(err && err.status) ? err.status : 500;
}

// POST /api/persistent/trades/buy { coin_id, quantity }
exports.buyPersistent = async (req, res, next) => {
  try {
    const { coin_id, quantity } = req.body || {};
    const result = await persistentEconomy.buyPersistentTrade({
      userId: req.user.user_id,
      coinId: coin_id,
      quantity
    });
    res.status(201).json({
      status: 'success',
      message: 'Persistent buy executed at the server-locked live price',
      data: result
    });
  } catch (err) {
    if (statusOf(err) < 500) {
      return res.status(statusOf(err)).json({ status: 'error', message: err.message });
    }
    next(err);
  }
};

// POST /api/persistent/trades/sell { coin_id, quantity }
exports.sellPersistent = async (req, res, next) => {
  try {
    const { coin_id, quantity } = req.body || {};
    const result = await persistentEconomy.sellPersistentTrade({
      userId: req.user.user_id,
      coinId: coin_id,
      quantity
    });
    res.status(201).json({
      status: 'success',
      message: 'Persistent sell executed at the server-locked live price',
      data: result
    });
  } catch (err) {
    if (statusOf(err) < 500) {
      return res.status(statusOf(err)).json({ status: 'error', message: err.message });
    }
    next(err);
  }
};

// GET /api/persistent/transactions?limit=N — the caller's own persistent
// trade ledger, newest first, bounded (default/max live in the economy
// module). Unprovisioned accounts read as an empty history, never an error.
exports.getMyPersistentTransactions = async (req, res, next) => {
  try {
    const rows = await persistentEconomy.getPersistentTransactions({
      userId: req.user.user_id,
      limit: req.query.limit
    });
    if (rows === null) {
      return res.status(200).json({
        status: 'success',
        data: { provisioned: false, transactions: [] }
      });
    }
    res.status(200).json({
      status: 'success',
      data: { provisioned: true, transactions: rows }
    });
  } catch (err) {
    if (statusOf(err) < 500) {
      return res.status(statusOf(err)).json({ status: 'error', message: err.message });
    }
    next(err);
  }
};

// GET /api/persistent/account — the caller's persistent account, or
// provisioned: false when the account does not exist yet (registration and
// first trade provision it idempotently; the client shows the persistent
// starting balance only once it exists).
exports.getMyPersistentAccount = async (req, res, next) => {
  try {
    const state = await persistentEconomy.getPersistentAccountState({ userId: req.user.user_id });
    if (!state) {
      return res.status(200).json({ status: 'success', data: { provisioned: false } });
    }
    res.status(200).json({ status: 'success', data: { provisioned: true, ...state } });
  } catch (err) {
    next(err);
  }
};

// GET /api/persistent/leaderboard — public read-only ranking of every
// provisioned persistent account in THE active world (humans + bots).
// Valuation: netWorth = cash + liveHoldingsValue - debt (DEAD coins £0).
// No auth; no mutations; no seed / Director / bot-decision leakage.
exports.getPersistentLeaderboard = async (req, res, next) => {
  try {
    const board = await persistentLeaderboard.getPersistentLeaderboard({});
    res.status(200).json({ status: 'success', data: board });
  } catch (err) {
    if (statusOf(err) < 500) {
      return res.status(statusOf(err)).json({ status: 'error', message: err.message });
    }
    next(err);
  }
};
