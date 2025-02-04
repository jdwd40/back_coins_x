const express = require('express');
const { 
  getMarketStatus,
  startMarket,
  stopMarket,
  getMarketStats,
  getMarketHistory
} = require('../controllers/market.controller');

const marketRouter = express.Router();

marketRouter.get('/status', getMarketStatus);
marketRouter.get('/stats', getMarketStats);
marketRouter.get('/history', getMarketHistory);
marketRouter.post('/start', startMarket);
marketRouter.post('/stop', stopMarket);

exports.marketRouter = marketRouter;
