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

exports.updatePortfolio = async (user_id, coin_id, type, amount, price_at_transaction) => {
  // First check if there's enough balance for a sell
  if (type.toUpperCase() === 'SELL') {
    const currentBalance = await db.query(
      `SELECT SUM(
         CASE 
           WHEN type = 'BUY' THEN quantity
           WHEN type = 'SELL' THEN -quantity
         END
       ) as balance
       FROM transactions
       WHERE user_id = $1 AND coin_id = $2`,
      [user_id, coin_id]
    );
    
    if (!currentBalance.rows[0].balance || currentBalance.rows[0].balance < amount) {
      throw new Error('Insufficient balance');
    }
  }

  // If it's a sell and we have enough balance, or if it's a buy, proceed with portfolio update
  const result = await db.query(
    `INSERT INTO portfolios (user_id, coin_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, coin_id)
     DO UPDATE SET
       quantity = CASE
         WHEN portfolios.quantity + $3 < 0 THEN 0
         ELSE portfolios.quantity + $3
       END,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [user_id, coin_id, type.toUpperCase() === 'BUY' ? amount : -amount]
  );
  
  return result.rows[0];
};
