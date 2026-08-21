const express = require('express');
const {
  getGameState,
  joinGame,
  buyGameTrade,
  sellGameTrade,
  getLiveLeaderboard,
  getCycleResults,
  getRecentLeaderboards
} = require('../controllers/game.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const gameRouter = express.Router();

// Public, read-only global cycle state.
gameRouter.get('/state', getGameState);

// Core 6 public read-only leaderboard/results APIs. Reads reconcile-then-read
// (leaderboard) or serve the immutable settlement snapshot (results/recent).
gameRouter.get('/leaderboard', getLiveLeaderboard);
gameRouter.get('/leaderboards/recent', getRecentLeaderboards);
gameRouter.get('/results/:cycleId', getCycleResults);

// Core 4 round-state routes. Mutating game routes are individually mounted
// behind authentication; the GET reads above stay public.
gameRouter.post('/join', authenticateToken, joinGame);
gameRouter.post('/trades/buy', authenticateToken, buyGameTrade);
gameRouter.post('/trades/sell', authenticateToken, sellGameTrade);

exports.gameRouter = gameRouter;
