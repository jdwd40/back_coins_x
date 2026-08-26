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

// Milestone 1: startMarket/stopMarket controllers are removed with their
// routes — simulator start/stop is owned by the server process lifecycle
// only, never by API callers.

exports.getMarketStats = async (req, res, next) => {
  try {
    const stats = await marketSimulator.getMarketStats();
    res.status(200).json(stats);
  } catch (err) {
    next(err);
  }
};

// V2 legacy cleanup (#22): exports.getMarketHistory is removed with its
// route — it lazy-required a getMarketHistory model function that
// coins.model.js does not export, so the endpoint was unreachable dead code
// (every call 500'd) with no consumer.

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
