const express = require('express');
const {
  getCoins,
  getCoinById,
  getPriceHistory
} = require('../controllers/coins.controller');

const coinsRouter = express.Router();

coinsRouter.get('/', getCoins);
coinsRouter.get('/:coin_id', getCoinById);

// Milestone 1: there is deliberately NO PATCH /:coin_id/price route. Manual
// current-price mutation had no legitimate consumer; prices are written only
// by the server-owned market simulator and the game collapse lifecycle.

coinsRouter.get('/:coin_id/price-history', getPriceHistory);

module.exports = { coinsRouter };
