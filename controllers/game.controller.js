const { getGameState } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');

// Map Core 4 domain errors (which carry an explicit status) to responses;
// anything else falls through to the generic error middleware.
function handleGameError(err, res, next) {
  if (err && err.name === 'GameRoundError' && err.status) {
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
