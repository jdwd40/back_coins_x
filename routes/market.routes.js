const express = require('express');
const { getMarketStatus } = require('../controllers/market.controller');

const marketRouter = express.Router();

marketRouter.get('/status', getMarketStatus);

exports.marketRouter = marketRouter;
