const marketSimulator = require('../models/market-simulator');

exports.getMarketStatus = async (req, res, next) => {
  try {
    const marketStatus = marketSimulator.getMarketStatus();
    res.status(200).json(marketStatus);
  } catch (err) {
    next(err);
  }
};
