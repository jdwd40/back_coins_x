const express = require('express');
const { 
  getCoins,
  getCoinById,
  updatePrice,
  getPriceHistory,
  getPriceHistoryV2
} = require('../controllers/coins.controller');

const coinsRouter = express.Router();

coinsRouter.get('/', getCoins);
coinsRouter.get('/:coin_id', getCoinById);
coinsRouter.patch('/:coin_id/price', updatePrice);

// Price history endpoints (v1 for backwards compatibility, v2 for rollup data)
coinsRouter.get('/:coin_id/price-history', getPriceHistory);
coinsRouter.get('/:coin_id/price-history-v2', getPriceHistoryV2);

module.exports = { coinsRouter };
