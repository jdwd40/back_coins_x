const marketSimulator = require('../models/market-simulator');

exports.getMarketStatus = async (req, res, next) => {
  try {
    const marketStatus = marketSimulator.getMarketStatus();
    res.status(200).json(marketStatus);
  } catch (err) {
    next(err);
  }
};

exports.startMarket = async (req, res, next) => {
  try {
    marketSimulator.start();
    res.status(200).json({ msg: 'Market simulation started', status: marketSimulator.getMarketStatus() });
  } catch (err) {
    next(err);
  }
};

exports.stopMarket = async (req, res, next) => {
  try {
    marketSimulator.stop();
    res.status(200).json({ msg: 'Market simulation stopped', status: marketSimulator.getMarketStatus() });
  } catch (err) {
    next(err);
  }
};

exports.getMarketStats = async (req, res, next) => {
  try {
    const stats = await marketSimulator.getMarketStats();
    res.status(200).json(stats);
  } catch (err) {
    next(err);
  }
};

exports.getMarketHistory = async (req, res, next) => {
  try {
    const { timeRange } = req.query;
    const { getMarketHistory } = require('../models/coins.model');
    const marketHistory = await getMarketHistory(timeRange);
    res.status(200).json(marketHistory);
  } catch (err) {
    if (err.message.startsWith('Invalid time range')) {
      res.status(400).json({ error: err.message });
    } else {
      next(err);
    }
  }
};
