const express = require('express');
const { 
  getMarketStatus,
  startMarket,
  stopMarket,
  getMarketStats
} = require('../controllers/market.controller');

const marketRouter = express.Router();

marketRouter.get('/status', getMarketStatus);
marketRouter.get('/stats', getMarketStats);
marketRouter.post('/start', startMarket);
marketRouter.post('/stop', stopMarket);

exports.marketRouter = marketRouter;
