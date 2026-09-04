const express = require('express');
const {
  getGameState,
  joinGame,
  buyGameTrade,
  sellGameTrade,
  getLiveLeaderboard,
  getCycleResults,
  getRecentLeaderboards,
  getMyParticipant,
  getMarketSignals,
  getPersistentLeaderboardAlias
} = require('../controllers/game.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const gameRouter = express.Router();

// Public, read-only global cycle state.
gameRouter.get('/state', getGameState);

// V2-1 public, read-only coarse market signals (price, recent movement,
// coarse current phase, momentum, archetype, approximate ranges, dead
// state). Reconcile-then-read; never carries seed or future information.
gameRouter.get('/market-signals', getMarketSignals);

// Core 6 public read-only leaderboard/results APIs. Reads reconcile-then-read
// (leaderboard) or serve the immutable settlement snapshot (results/recent).
gameRouter.get('/leaderboard', getLiveLeaderboard);
// Stage 10A alias → same handler as GET /api/persistent/leaderboard (primary).
gameRouter.get('/persistent-leaderboard', getPersistentLeaderboardAlias);
gameRouter.get('/leaderboards/recent', getRecentLeaderboards);
gameRouter.get('/results/:cycleId', getCycleResults);

// Core 4 round-state routes. Mutating game routes are individually mounted
// behind authentication; the GET reads above stay public.
gameRouter.post('/join', authenticateToken, joinGame);
gameRouter.post('/trades/buy', authenticateToken, buyGameTrade);
gameRouter.post('/trades/sell', authenticateToken, sellGameTrade);

// Issue #18 / frontend #11: authenticated player-safe Cash + recent
// FEE/TAX/EVENT cash events. Read-only; reconciles the lifecycle first.
gameRouter.get('/participant', authenticateToken, getMyParticipant);

exports.gameRouter = gameRouter;
