const marketSimulator = require('../models/market-simulator');
const db = require('../db/connection'); // assuming db connection is established elsewhere

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

exports.getMarketPriceHistory = async (req, res, next) => {
  try {
    const { timeRange = '30M' } = req.query;
    const timeRanges = {
      '10M': '10 minutes',
      '30M': '30 minutes',
      '1H': '1 hour',
      '2H': '2 hours',
      '12H': '12 hours',
      '24H': '24 hours',
      'ALL': null
    };

    const timeFilter = timeRanges[timeRange] 
      ? `WHERE created_at >= NOW() - INTERVAL '${timeRanges[timeRange]}'` 
      : '';

    const query = `
      SELECT 
        total_value,
        market_trend,
        created_at,
        EXTRACT(EPOCH FROM created_at) * 1000 as timestamp
      FROM market_history
      ${timeFilter}
      ORDER BY created_at ASC
    `;

    const result = await db.query(query);
    
    res.status(200).json({
      history: result.rows,
      timeRange,
      count: result.rows.length
    });
  } catch (err) {
    next(err);
  }
};
