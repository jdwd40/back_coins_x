const coinsModel = require('../models/coins.model');
const logger = require('../utils/logger');

const getCoins = async (req, res, next) => {
  try {
    const coins = await coinsModel.selectAllCoins();
    res.status(200).json({ coins });
  } catch (error) {
    logger.error('Error in getCoins:', error);
    res.status(500).json({ msg: 'Internal server error' });
  }
};

const getCoinById = async (req, res, next) => {
  try {
    const { coin_id } = req.params;

    if (!Number.isInteger(parseInt(coin_id))) {
      return res.status(400).json({ msg: 'Bad request' });
    }

    const coin = await coinsModel.selectCoinById(coin_id);

    if (!coin) {
      return res.status(404).json({ msg: 'Coin not found' });
    }

    res.status(200).json({ coin });
  } catch (error) {
    logger.error('Error in getCoinById:', error);
    res.status(500).json({ msg: 'Internal server error' });
  }
};

// Milestone 1: the updatePrice controller is removed with its route — the
// public API offers no manual current-price mutation at all.

const getPriceHistory = async (req, res, next) => {
  try {
    const { coin_id } = req.params;
    const { range = '1H' } = req.query;

    // Validate coin_id (page/limit ignored per redesign)
    const numericId = parseInt(coin_id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(400).json({ msg: 'Invalid coin ID - must be a positive integer' });
    }

    const validRanges = ['10M', '30M', '1H', '2H', '24H', '7D', '30D', 'ALL'];
    if (!validRanges.includes(range)) {
      return res.status(400).json({ 
        msg: `Invalid range parameter. Must be one of: ${validRanges.join(', ')}` 
      });
    }

    const priceHistoryModel = require('../models/priceHistory.model');
    const history = await priceHistoryModel.getPriceHistory(numericId, range);

    // Cache per design (10s)
    res.set('Cache-Control', 'public, max-age=10');
    res.status(200).json(history);
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ msg: error.message });
    }
    if (error.status === 404 || (error.message && error.message.includes('Coin not found'))) {
      return res.status(404).json({ msg: 'Coin not found' });
    }
    logger.error('Error in getPriceHistory:', error);
    res.status(500).json({ msg: 'Internal server error' });
  }
};




module.exports = {
  getCoins,
  getCoinById,
  getPriceHistory
};
