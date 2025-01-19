const db = require('../db/connection');

exports.insertTransaction = async (user_id, coin_id, type, amount, price_at_transaction) => {
  const total = amount * price_at_transaction;
  
  const result = await db.query(
    `INSERT INTO transactions 
     (user_id, coin_id, type, quantity, price, total_amount)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [user_id, coin_id, type.toUpperCase(), amount, price_at_transaction, total]
  );
  
  return result.rows[0];
};

exports.selectUserTransactions = async (user_id) => {
  const result = await db.query(
    `SELECT t.*, c.name as coin_name, c.symbol
     FROM transactions t
     JOIN coins c ON t.coin_id = c.coin_id
     WHERE t.user_id = $1
     ORDER BY t.created_at DESC`,
    [user_id]
  );
  
  return result.rows;
};

exports.selectTransactionById = async (transaction_id) => {
  const result = await db.query(
    `SELECT t.*, c.name as coin_name, c.symbol
     FROM transactions t
     JOIN coins c ON t.coin_id = c.coin_id
     WHERE t.transaction_id = $1`,
    [transaction_id]
  );
  
  return result.rows[0];
};

exports.selectUserPortfolio = async (user_id) => {
  const result = await db.query(
    `SELECT 
       c.coin_id,
       c.name,
       c.symbol,
       c.current_price,
       SUM(
         CASE 
           WHEN t.type = 'BUY' THEN t.quantity
           WHEN t.type = 'SELL' THEN -t.quantity
         END
       ) as total_amount,
       SUM(
         CASE 
           WHEN t.type = 'BUY' THEN t.quantity * t.price
           WHEN t.type = 'SELL' THEN -t.quantity * t.price
         END
       ) as total_invested
     FROM transactions t
     JOIN coins c ON t.coin_id = c.coin_id
     WHERE t.user_id = $1
     GROUP BY c.coin_id, c.name, c.symbol, c.current_price
     HAVING SUM(
       CASE 
         WHEN t.type = 'BUY' THEN t.quantity
         WHEN t.type = 'SELL' THEN -t.quantity
       END
     ) > 0`,
    [user_id]
  );
  
  return result.rows;
};

exports.updatePortfolio = async (user_id, coin_id, type, amount, price) => {
  // Check if portfolio entry exists
  const portfolioResult = await db.query(
    `SELECT quantity, average_price 
     FROM user_portfolio 
     WHERE user_id = $1 AND coin_id = $2`,
    [user_id, coin_id]
  );

  const isBuy = type.toUpperCase() === 'BUY';
  
  if (portfolioResult.rows.length === 0) {
    if (!isBuy) {
      throw new Error('Cannot sell coins that are not in portfolio');
    }
    
    // Create new portfolio entry for buy
    await db.query(
      `INSERT INTO user_portfolio 
       (user_id, coin_id, quantity, average_price)
       VALUES ($1, $2, $3, $4)`,
      [user_id, coin_id, amount, price]
    );
  } else {
    const { quantity, average_price } = portfolioResult.rows[0];
    
    if (isBuy) {
      // Calculate new average price for buys
      const newQuantity = quantity + amount;
      const newAveragePrice = ((quantity * average_price) + (amount * price)) / newQuantity;
      
      await db.query(
        `UPDATE user_portfolio 
         SET quantity = $1, average_price = $2
         WHERE user_id = $3 AND coin_id = $4`,
        [newQuantity, newAveragePrice, user_id, coin_id]
      );
    } else {
      // Handle sells
      const newQuantity = quantity - amount;
      
      if (newQuantity < 0) {
        throw new Error('Insufficient coins in portfolio');
      } else if (newQuantity === 0) {
        // Remove portfolio entry if quantity becomes 0
        await db.query(
          `DELETE FROM user_portfolio 
           WHERE user_id = $1 AND coin_id = $2`,
          [user_id, coin_id]
        );
      } else {
        // Keep same average price for sells
        await db.query(
          `UPDATE user_portfolio 
           SET quantity = $1
           WHERE user_id = $2 AND coin_id = $3`,
          [newQuantity, user_id, coin_id]
        );
      }
    }
  }
};
