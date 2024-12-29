const db = require('../db/connection');

exports.selectAllCoins = async () => {
  const result = await db.query(
    'SELECT * FROM coins ORDER BY market_cap DESC'
  );
  return result.rows;
};

exports.selectCoinById = async (coin_id) => {
  const result = await db.query(
    'SELECT * FROM coins WHERE coin_id = $1',
    [coin_id]
  );
  return result.rows[0];
};
