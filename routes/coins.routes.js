const express = require('express');
const { 
  getCoins,
  getCoinById,
  updatePrice,
  getPriceHistory
} = require('../controllers/coins.controller');

const coinsRouter = express.Router();

coinsRouter.get('/', getCoins);
coinsRouter.get('/:coin_id', getCoinById);
coinsRouter.patch('/:coin_id/price', updatePrice);
coinsRouter.get('/:coin_id/price-history', getPriceHistory);

module.exports = { coinsRouter };
