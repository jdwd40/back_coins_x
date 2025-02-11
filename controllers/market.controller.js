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
    const { page, limit } = req.query;
    
    // Convert to numbers if provided, otherwise pass null
    const pageNum = page ? parseInt(page) : null;
    const limitNum = limit ? parseInt(limit) : null;
    
    const { getMarketHistory } = require('../models/coins.model');
    const marketHistory = await getMarketHistory(pageNum, limitNum);
    res.status(200).json(marketHistory);
  } catch (err) {
    next(err);
  }
};
