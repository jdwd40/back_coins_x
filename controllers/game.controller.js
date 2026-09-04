const { getGameState } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');
const gameResultsService = require('../game/gameResultsService');
const persistentLeaderboard = require('../game/persistentLeaderboard');
const economyService = require('../game/economyService');
const marketSignalsService = require('../game/marketSignalsService');

// Map Core 4/6/economy domain errors (which carry an explicit status) to
// responses; anything else falls through to the generic error middleware.
function handleGameError(err, res, next) {
  if (err && (err.name === 'GameRoundError' || err.name === 'GameResultsError' || err.name === 'GameEconomyError') && err.status) {
    return res.status(err.status).json({ status: 'error', message: err.message });
  }
  return next(err);
}

// Public read-only global apocalypse cycle state. The server/database is
// authoritative; reading also safely recovers any pending rollover.
exports.getGameState = async (req, res, next) => {
  try {
    const state = await getGameState({});
    res.status(200).json(state);
  } catch (err) {
    next(err);
  }
};

// Authenticated join-anytime: create/reuse the caller's participant for the
// authoritative active cycle. Repeated and concurrent joins return the same
// row and never reset cash, holdings, join time, or peak.
exports.joinGame = async (req, res, next) => {
  try {
    const participant = await gameRoundService.joinRound({ userId: req.user.user_id });
    res.status(200).json({ status: 'success', data: { participant } });
  } catch (err) {
    handleGameError(err, res, next);
  }
};

// Authenticated round buy. Requires an explicit cycleId (the canonical Core 1
// apocalypse_id) and an explicit prior join. The price is always the
// server-side authoritative current price; only round cash/holdings/ledger
// rows are written.
exports.buyGameTrade = async (req, res, next) => {
  try {
    const { cycleId, coin_id, amount } = req.body;
    const result = await gameRoundService.buyRoundTrade({
      userId: req.user.user_id,
      apocalypseId: cycleId,
      coinId: coin_id,
      quantity: amount
    });
    res.status(201).json({ status: 'success', message: 'Round buy completed successfully', data: result });
  } catch (err) {
    handleGameError(err, res, next);
  }
};

// Authenticated round sell. Same cycle/ownership protections as buy;
// oversell and stale cycles are rejected before any write, and a collapsed
// holding sells at the authoritative £0, crediting exactly zero cash.
exports.sellGameTrade = async (req, res, next) => {
  try {
    const { cycleId, coin_id, amount } = req.body;
    const result = await gameRoundService.sellRoundTrade({
      userId: req.user.user_id,
      apocalypseId: cycleId,
      coinId: coin_id,
      quantity: amount
    });
    res.status(201).json({ status: 'success', message: 'Round sell completed successfully', data: result });
  } catch (err) {
    handleGameError(err, res, next);
  }
};

// Public read-only live leaderboard for the current active cycle. Reading
// reconciles the lifecycle first (recovering any pending settlement), then
// reports live wealth (cash + live holdings value, collapsed coins £0),
// sorted wealth DESC / participant ASC. Informational: the final result is
// the immutable snapshot exposed by the results endpoints.
exports.getLiveLeaderboard = async (req, res, next) => {
  try {
    const leaderboard = await gameResultsService.getLiveLeaderboard({});
    res.status(200).json({ status: 'success', data: leaderboard });
  } catch (err) {
    handleGameError(err, res, next);
  }
};

// Public read-only immutable results for one COMPLETED cycle. ACTIVE or
// SETTLING cycles are clearly rejected (409); unknown ids are 404. Rows are
// the settlement snapshot, never recalculated from mutable state.
exports.getCycleResults = async (req, res, next) => {
  try {
    const results = await gameResultsService.getCycleResults(req.params.cycleId);
    res.status(200).json({ status: 'success', data: results });
  } catch (err) {
    handleGameError(err, res, next);
  }
};

// Public read-only recent completed cycles with their immutable snapshots.
// ?limit= is validated (400 on non-integer) and clamped to the documented
// bounds; it limits the read only — history is never deleted.
exports.getRecentLeaderboards = async (req, res, next) => {
  try {
    const recent = await gameResultsService.getRecentLeaderboards({ limit: req.query.limit });
    res.status(200).json({ status: 'success', data: recent });
  } catch (err) {
    handleGameError(err, res, next);
  }
};

// Issue #18 / frontend #11: authenticated player-safe view of the caller's
// current-round Cash plus their recent FEE/TAX/EVENT ledger rows (source
// type, amount, resulting balance, timestamp, public description). Only
// EXECUTED debits are returned — the internal future event schedule and the
// cycle seed are never exposed.
exports.getMyParticipant = async (req, res, next) => {
  try {
    const data = await economyService.getPlayerRoundEconomy({
      userId: req.user.user_id,
      limit: req.query.limit
    });
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    handleGameError(err, res, next);
  }
};

// V2-1: public read-only coarse market signals for the live round. The
// payload is built entirely from the shared domain's public signal shape —
// it can never contain the seed, exact timings, anchors or future state.
exports.getMarketSignals = async (req, res, next) => {
  try {
    const data = await marketSignalsService.getPublicMarketSignals({});
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
};

// Stage 10A belt-and-suspenders alias: same handler as GET /api/persistent/leaderboard.
// Primary surface remains /api/persistent/*; this alias exists so clients that
// expected /api/game/persistent-leaderboard still work. Additive only —
// legacy GET /api/game/leaderboard is untouched.
exports.getPersistentLeaderboardAlias = async (req, res, next) => {
  try {
    const board = await persistentLeaderboard.getPersistentLeaderboard({});
    res.status(200).json({ status: 'success', data: board });
  } catch (err) {
    handleGameError(err, res, next);
  }
};
