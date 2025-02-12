const { selectAllCoins, selectCoinById, updateCoinPrice, getCoinPriceHistory } = require('../models/coins.model');

exports.getCoins = async (req, res, next) => {
  try {
    const coins = await selectAllCoins();
    res.status(200).json({ coins });
  } catch (error) {
    console.error('Error in getCoins:', error);
    next(error);
  }
};

exports.getCoinById = async (req, res, next) => {
  try {
    const { coin_id } = req.params;

    if (!Number.isInteger(parseInt(coin_id))) {
      return res.status(400).json({ msg: 'Invalid coin ID' });
    }

    const coin = await selectCoinById(coin_id);

    if (!coin) {
      return res.status(404).json({ msg: 'Coin not found' });
    }

    res.status(200).json({ coin });
  } catch (error) {
    console.error('Error in getCoinById:', error);
    next(error);
  }
};

exports.updatePrice = async (req, res, next) => {
  try {
    const { coin_id } = req.params;
    const { current_price } = req.body;

    if (!Number.isInteger(parseInt(coin_id))) {
      return res.status(400).json({ msg: 'Invalid coin ID' });
    }

    if (current_price === undefined || current_price === null) {
      return res.status(400).json({ msg: 'Current price is required' });
    }

    const updatedCoin = await updateCoinPrice(coin_id, current_price);
    res.status(200).json({ coin: updatedCoin });
  } catch (error) {
    console.error('Error in updatePrice:', error);
    next(error);
  }
};

exports.getPriceHistory = async (req, res, next) => {
  try {
    const { coin_id } = req.params;
    const { page, limit } = req.query;
    
    // Convert to numbers if provided, otherwise pass null
    const pageNum = page ? parseInt(page) : null;
    const limitNum = limit ? parseInt(limit) : null;
    
    const priceHistory = await getCoinPriceHistory(coin_id, pageNum, limitNum);
    res.status(200).json(priceHistory);
  } catch (err) {
    next(err);
  }
};
