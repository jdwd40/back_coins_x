const express = require('express');
const {
  getCoins,
  getCoinById,
  updatePrice,
  getPriceHistory
} = require('../controllers/coins.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const coinsRouter = express.Router();

coinsRouter.get('/', getCoins);
coinsRouter.get('/:coin_id', getCoinById);
// Price mutation can rewrite current_price and append price_history — require auth
coinsRouter.patch('/:coin_id/price', authenticateToken, updatePrice);

coinsRouter.get('/:coin_id/price-history', getPriceHistory);

module.exports = { coinsRouter };
