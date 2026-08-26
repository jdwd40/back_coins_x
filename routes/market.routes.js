const express = require('express');
const { 
  getMarketStatus,
  getMarketStats,
  getMarketPriceHistory
} = require('../controllers/market.controller');

const marketRouter = express.Router();

marketRouter.get('/status', getMarketStatus);
marketRouter.get('/stats', getMarketStats);
// V2 legacy cleanup (#22): GET /api/market/history is deliberately REMOVED.
// No current frontend consumer exists (verified against deployed frontend
// master 79b599d3), and its controller called a getMarketHistory model
// function that coins.model.js does not export — the route could only ever
// 500. The aggregate GET /api/market/price-history below is the live,
// consumed drill-down and is untouched.
marketRouter.get('/price-history', getMarketPriceHistory);

// Milestone 1: there are deliberately NO POST /start or /stop routes. No
// legitimate consumer or admin role exists; the simulator lifecycle is owned
// solely by the server process (app.js production start, server.js shutdown).

exports.marketRouter = marketRouter;
