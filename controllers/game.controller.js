const { getGameState } = require('../game/gameCycleService');

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
