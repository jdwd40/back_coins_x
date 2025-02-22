const coinsModel = require('../models/coins.model');
const logger = require('../utils/logger');
const { CurrencyFormatter } = require('../utils/currency-formatter');

// Constants for validation
const PRICE_LIMITS = {
  MIN: 0.01,
  MAX: 1000000000 // 1 billion
};

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

const updatePrice = async (req, res) => {
  try {
    console.log('DEBUG: Starting updatePrice with request:', {
      params: req.params,
      body: req.body
    });

    const { coin_id } = req.params;
    // Handle both price and current_price in request body
    const priceValue = req.body.price !== undefined ? req.body.price : req.body.current_price;

    console.log('DEBUG: Extracted values:', {
      coin_id,
      priceValue,
      bodyKeys: Object.keys(req.body)
    });

    // Validate coin_id
    const numericId = parseInt(coin_id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(400).json({ msg: 'Invalid coin ID - must be a positive integer' });
    }

    // Validate price presence
    if (priceValue === undefined || priceValue === null) {
      return res.status(400).json({ 
        msg: 'Price is required in request body as either "price" or "current_price" - must be a number or GBP string (e.g., 150.00 or £150.00)' 
      });
    }

    // Convert and validate price
    let numericPrice;
    try {
      console.log('DEBUG: Converting price value:', priceValue);
      numericPrice = CurrencyFormatter.convertToNumber(priceValue);
      console.log('DEBUG: Converted to numeric price:', numericPrice);
      
      // Validate price range
      if (numericPrice < PRICE_LIMITS.MIN || numericPrice > PRICE_LIMITS.MAX) {
        return res.status(400).json({ 
          msg: `Price must be between ${CurrencyFormatter.formatGBP(PRICE_LIMITS.MIN)} and ${CurrencyFormatter.formatGBP(PRICE_LIMITS.MAX)}`
        });
      }
    } catch (err) {
      console.error('DEBUG: Price conversion error:', {
        error: err.message,
        input: priceValue,
        type: typeof priceValue
      });
      
      if (err.message === 'NEGATIVE_PRICE') {
        return res.status(400).json({ 
          msg: 'Invalid price format - must be a positive number'
        });
      }
      return res.status(400).json({ 
        msg: 'Invalid price format - must be a valid number or GBP amount'
      });
    }

    // Update the coin price
    try {
      console.log('DEBUG: Calling updateCoinPrice with:', {
        numericId,
        numericPrice
      });
      
      const updatedCoin = await coinsModel.updateCoinPrice(numericId, numericPrice);
      
      if (!updatedCoin) {
        return res.status(404).json({ msg: `Coin with ID ${numericId} not found` });
      }

      console.log('DEBUG: Successfully updated coin:', updatedCoin);

      return res.status(200).json({ coin: updatedCoin });
    } catch (dbError) {
      console.error('DEBUG: Database error in updatePrice:', { 
        error: dbError.message,
        stack: dbError.stack,
        code: dbError.code,
        detail: dbError.detail,
        coinId: numericId, 
        price: numericPrice 
      });

      // In development, include error details
      const errorResponse = {
        msg: 'Internal server error while updating coin price'
      };
      
      if (process.env.NODE_ENV === 'development') {
        errorResponse.error = dbError.message;
        errorResponse.detail = dbError.detail;
        errorResponse.code = dbError.code;
      }

      return res.status(500).json(errorResponse);
    }
  } catch (error) {
    console.error('DEBUG: Unexpected error in updatePrice:', {
      error: error.message,
      stack: error.stack,
      code: error.code,
      detail: error.detail
    });

    // In development, include error details
    const errorResponse = {
      msg: 'Internal server error'
    };
    
    if (process.env.NODE_ENV === 'development') {
      errorResponse.error = error.message;
      errorResponse.detail = error.detail;
      errorResponse.code = error.code;
    }

    return res.status(500).json(errorResponse);
  }
};

const getPriceHistory = async (req, res, next) => {
  try {
    const { coin_id } = req.params;
    const { page = 1, limit = 10 } = req.query;

    // Validate coin_id
    const numericId = parseInt(coin_id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(400).json({ msg: 'Invalid coin ID - must be a positive integer' });
    }

    // Validate pagination parameters
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    if (!Number.isInteger(pageNum) || pageNum < 1) {
      return res.status(400).json({ msg: 'Page must be a positive integer' });
    }

    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({ msg: 'Limit must be a positive integer between 1 and 100' });
    }

    // Check if coin exists first
    const coin = await coinsModel.selectCoinById(numericId);
    if (!coin) {
      return res.status(404).json({ msg: 'Coin not found' });
    }
    
    const priceHistory = await coinsModel.getCoinPriceHistory(numericId, pageNum, limitNum);
    res.status(200).json(priceHistory);
  } catch (error) {
    logger.error('Error in getPriceHistory:', error);
    res.status(500).json({ msg: 'Internal server error' });
  }
};

module.exports = {
  getCoins,
  getCoinById,
  updatePrice,
  getPriceHistory
};
