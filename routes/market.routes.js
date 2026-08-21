const express = require('express');
const { 
  getMarketStatus,
  getMarketStats,
  getMarketHistory,
  getMarketPriceHistory
} = require('../controllers/market.controller');

const marketRouter = express.Router();

marketRouter.get('/status', getMarketStatus);
marketRouter.get('/stats', getMarketStats);
marketRouter.get('/history', getMarketHistory);
marketRouter.get('/price-history', getMarketPriceHistory);

// Milestone 1: there are deliberately NO POST /start or /stop routes. No
// legitimate consumer or admin role exists; the simulator lifecycle is owned
// solely by the server process (app.js production start, server.js shutdown).

exports.marketRouter = marketRouter;
