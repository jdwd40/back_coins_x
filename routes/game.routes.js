const express = require('express');
const { getGameState, joinGame, buyGameTrade, sellGameTrade } = require('../controllers/game.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const gameRouter = express.Router();

// Public, read-only global cycle state.
gameRouter.get('/state', getGameState);

// Core 4 round-state routes. Mutating game routes are individually mounted
// behind authentication; GET /state above stays public.
gameRouter.post('/join', authenticateToken, joinGame);
gameRouter.post('/trades/buy', authenticateToken, buyGameTrade);
gameRouter.post('/trades/sell', authenticateToken, sellGameTrade);

exports.gameRouter = gameRouter;
