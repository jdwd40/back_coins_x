const express = require('express');
const { 
  getAllCoins,
  getCoinById
} = require('../controllers/coins.controller');

const coinsRouter = express.Router();

coinsRouter.get('/', getAllCoins);
coinsRouter.get('/:coin_id', getCoinById);

module.exports = { coinsRouter };
