const express = require('express');
const { 
  getCoins,
  getCoinById
} = require('../controllers/coins.controller');

const coinsRouter = express.Router();

coinsRouter.get('/', getCoins);
coinsRouter.get('/:coin_id', getCoinById);

module.exports = { coinsRouter };
