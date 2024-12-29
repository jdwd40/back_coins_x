const db = require('../db/connection');

exports.insertTransaction = async (user_id, coin_id, type, amount, price_at_transaction) => {
  const result = await db.query(
    `INSERT INTO transactions 
     (user_id, coin_id, type, amount, price_at_transaction)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [user_id, coin_id, type, amount, price_at_transaction]
  );
  
  return result.rows[0];
};

exports.selectUserTransactions = async (user_id) => {
  const result = await db.query(
    `SELECT t.*, c.name as coin_name, c.symbol
     FROM transactions t
     JOIN coins c ON t.coin_id = c.coin_id
     WHERE t.user_id = $1
     ORDER BY t.transaction_date DESC`,
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
           WHEN t.type = 'buy' THEN t.amount
           WHEN t.type = 'sell' THEN -t.amount
         END
       ) as total_amount,
       SUM(
         CASE 
           WHEN t.type = 'buy' THEN t.amount * t.price_at_transaction
           WHEN t.type = 'sell' THEN -t.amount * t.price_at_transaction
         END
       ) as total_invested
     FROM transactions t
     JOIN coins c ON t.coin_id = c.coin_id
     WHERE t.user_id = $1
     GROUP BY c.coin_id, c.name, c.symbol, c.current_price
     HAVING SUM(
       CASE 
         WHEN t.type = 'buy' THEN t.amount
         WHEN t.type = 'sell' THEN -t.amount
       END
     ) > 0`,
    [user_id]
  );
  
  return result.rows;
};

exports.updatePortfolio = async (user_id, coin_id, type, amount, price_at_transaction) => {
  // First check if there's enough balance for a sell
  if (type === 'sell') {
    const currentBalance = await db.query(
      `SELECT SUM(
         CASE 
           WHEN type = 'buy' THEN amount
           WHEN type = 'sell' THEN -amount
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
    `INSERT INTO portfolios (user_id, coin_id, amount, average_price)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, coin_id)
     DO UPDATE SET
       amount = CASE
         WHEN portfolios.amount + $3 < 0 THEN 0
         ELSE portfolios.amount + $3
       END,
       average_price = CASE
         WHEN portfolios.amount + $3 <= 0 THEN 0
         ELSE (portfolios.amount * portfolios.average_price + $3 * $4) / NULLIF(portfolios.amount + $3, 0)
       END
     RETURNING *`,
    [user_id, coin_id, type === 'buy' ? amount : -amount, price_at_transaction]
  );
  
  return result.rows[0];
};
