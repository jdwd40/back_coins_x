const express = require('express');
const { 
  getMarketStatus,
  startMarket,
  stopMarket,
  getMarketStats,
  getMarketHistory,
  getMarketPriceHistory
} = require('../controllers/market.controller');

const marketRouter = express.Router();

marketRouter.get('/status', getMarketStatus);
marketRouter.get('/stats', getMarketStats);
marketRouter.get('/history', getMarketHistory);
marketRouter.get('/price-history', getMarketPriceHistory);
marketRouter.post('/start', startMarket);
marketRouter.post('/stop', stopMarket);

exports.marketRouter = marketRouter;
