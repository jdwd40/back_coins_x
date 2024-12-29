const db = require('../db/connection');

exports.getCoins = async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM coins');
    res.status(200).json({ coins: result.rows });
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

    const result = await db.query(
      'SELECT * FROM coins WHERE coin_id = $1',
      [coin_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    res.status(200).json({ coin: result.rows[0] });
  } catch (error) {
    next(error);
  }
};
