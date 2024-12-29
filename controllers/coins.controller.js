const { 
  selectAllCoins,
  selectCoinById
} = require('../models/coins.model');

exports.getAllCoins = async (req, res, next) => {
  try {
    const coins = await selectAllCoins();
    res.status(200).send({ coins });
  } catch (err) {
    next(err);
  }
};

exports.getCoinById = async (req, res, next) => {
  try {
    const { coin_id } = req.params;
    
    // Validate coin_id is a number
    if (isNaN(coin_id)) {
      return res.status(400).send({ msg: 'Invalid coin ID' });
    }

    const coin = await selectCoinById(coin_id);
    
    if (!coin) {
      return res.status(404).send({ msg: 'Coin not found' });
    }

    res.status(200).send({ coin });
  } catch (err) {
    next(err);
  }
};
