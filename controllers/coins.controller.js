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

    res.status(200).json(coin);
  } catch (error) {
    console.error('Error in getCoinById:', error);
    next(error);
  }
};

exports.updatePrice = async (req, res, next) => {
  try {
    const { coin_id } = req.params;
    const { current_price } = req.body;
    console.log('Updating price for coin:', coin_id, 'to:', current_price);

    if (!Number.isInteger(parseInt(coin_id))) {
      return res.status(400).json({ msg: 'Invalid coin ID' });
    }

    if (current_price === undefined || current_price === null) {
      return res.status(400).json({ msg: 'Current price is required' });
    }

    try {
      const updatedCoin = await updateCoinPrice(coin_id, current_price);
      console.log('Successfully updated coin:', updatedCoin);
      res.status(200).json(updatedCoin);
    } catch (err) {
      console.error('Error updating coin price:', err);
      if (err.message === 'Invalid price format') {
        return res.status(400).json({ msg: 'Invalid price format' });
      }
      if (err.message === 'Coin not found') {
        return res.status(404).json({ msg: 'Coin not found' });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in updatePrice:', error);
    next(error);
  }
};

exports.getPriceHistory = async (req, res, next) => {
  try {
    const { coin_id } = req.params;

    if (!Number.isInteger(parseInt(coin_id))) {
      return res.status(400).json({ error: 'Invalid coin ID' });
    }

    const history = await getCoinPriceHistory(coin_id);

    if (!history) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    res.status(200).json({ priceHistory: history });
  } catch (error) {
    console.error('Error in getPriceHistory:', error);
    next(error);
  }
};
