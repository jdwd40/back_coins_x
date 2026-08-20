const express = require('express');
const { getGameState } = require('../controllers/game.controller');

const gameRouter = express.Router();

gameRouter.get('/state', getGameState);

exports.gameRouter = gameRouter;
