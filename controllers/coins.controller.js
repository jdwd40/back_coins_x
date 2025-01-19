const { selectAllCoins, selectCoinById, updateCoinPrice, getCoinPriceHistory } = require('../models/coins.model');

exports.getCoins = async (req, res, next) => {
  try {
    const coins = await selectAllCoins();
    res.status(200).json({ coins });
  } catch (error) {
    next(error);
  }
};

exports.getCoinById = async (req, res, next) => {
  try {
    const { coin_id } = req.params;

    if (!Number.isInteger(parseInt(coin_id))) {
      return res.status(400).json({ error: 'Invalid coin ID' });
    }

    const coin = await selectCoinById(coin_id);

    if (!coin) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    res.status(200).json({ coin });
  } catch (error) {
    next(error);
  }
};

exports.updatePrice = async (req, res, next) => {
  try {
    const { coin_id } = req.params;
    const { current_price } = req.body;

    if (!Number.isInteger(parseInt(coin_id))) {
      return res.status(400).json({ error: 'Invalid coin ID' });
    }

    if (!current_price) {
      return res.status(400).json({ error: 'Current price is required' });
    }

    try {
      const updatedCoin = await updateCoinPrice(coin_id, current_price);
      res.status(200).json({ coin: updatedCoin });
    } catch (err) {
      if (err.message === 'Invalid price format') {
        return res.status(400).json({ error: 'Invalid price format' });
      }
      if (err.message === 'Coin not found') {
        return res.status(404).json({ error: 'Coin not found' });
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
};

exports.getPriceHistory = async (req, res, next) => {
  try {
    const { coin_id } = req.params;

    if (!Number.isInteger(parseInt(coin_id))) {
      return res.status(400).json({ error: 'Invalid coin ID' });
    }

    // Check if coin exists
    const coin = await selectCoinById(coin_id);
    if (!coin) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    const priceHistory = await getCoinPriceHistory(coin_id);
    res.status(200).json({ priceHistory });
  } catch (error) {
    next(error);
  }
};
