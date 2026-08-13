const express = require('express');
const {
  getCoins,
  getCoinById,
  updatePrice,
  getPriceHistory
} = require('../controllers/coins.controller');
const { requirePriceAdminOrSystem } = require('../middleware/auth.middleware');

const coinsRouter = express.Router();

coinsRouter.get('/', getCoins);
coinsRouter.get('/:coin_id', getCoinById);
// Global price mutation: system key OR configured admin JWT only (not any user)
coinsRouter.patch('/:coin_id/price', requirePriceAdminOrSystem, updatePrice);

coinsRouter.get('/:coin_id/price-history', getPriceHistory);

module.exports = { coinsRouter };
