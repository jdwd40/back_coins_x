const db = require('../db/connection');

exports.insertTransaction = async (user_id, coin_id, type, amount, price_at_transaction) => {
  // Validate inputs
  if (!user_id || !coin_id || !type || !amount || !price_at_transaction) {
    throw new Error('Missing required fields for transaction');
  }

  // Ensure type is either 'buy' or 'sell'
  const normalizedType = type.toLowerCase();
  if (!['buy', 'sell'].includes(normalizedType)) {
    throw new Error('Invalid transaction type');
  }

  try {
    const result = await db.query(
      `INSERT INTO transactions 
       (user_id, coin_id, type, amount, price_at_transaction)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING 
         transaction_id,
         user_id,
         coin_id,
         type,
         amount,
         price_at_transaction,
         transaction_date`,
      [user_id, coin_id, normalizedType, amount, price_at_transaction]
    );
    
    return result.rows[0];
  } catch (error) {
    throw new Error(`Failed to record transaction: ${error.message}`);
  }
};

exports.selectUserTransactions = async (user_id) => {
  try {
    const result = await db.query(
      `SELECT 
         t.transaction_id,
         t.user_id,
         t.coin_id,
         c.name as coin_name,
         c.symbol as coin_symbol,
         t.type,
         t.amount,
         t.price_at_transaction,
         (t.amount * t.price_at_transaction) as total_value,
         t.transaction_date
       FROM transactions t
       JOIN coins c ON t.coin_id = c.coin_id
       WHERE t.user_id = $1
       ORDER BY t.transaction_date DESC`,
      [user_id]
    );
    
    return result.rows;
  } catch (error) {
    throw new Error(`Failed to fetch user transactions: ${error.message}`);
  }
};

exports.selectTransactionById = async (transaction_id) => {
  try {
    const result = await db.query(
      `SELECT 
         t.transaction_id,
         t.user_id,
         t.coin_id,
         c.name as coin_name,
         c.symbol as coin_symbol,
         t.type,
         t.amount,
         t.price_at_transaction,
         (t.amount * t.price_at_transaction) as total_value,
         t.transaction_date
       FROM transactions t
       JOIN coins c ON t.coin_id = c.coin_id
       WHERE t.transaction_id = $1`,
      [transaction_id]
    );
    
    if (result.rows.length === 0) {
      throw new Error('Transaction not found');
    }
    
    return result.rows[0];
  } catch (error) {
    throw new Error(`Failed to fetch transaction: ${error.message}`);
  }
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
           WHEN t.type = 'BUY' THEN t.amount
           WHEN t.type = 'SELL' THEN -t.amount
         END
       ) as total_amount,
       SUM(
         CASE 
           WHEN t.type = 'BUY' THEN t.amount * t.price_at_transaction
           WHEN t.type = 'SELL' THEN -t.amount * t.price_at_transaction
         END
       ) as total_invested
     FROM transactions t
     JOIN coins c ON t.coin_id = c.coin_id
     WHERE t.user_id = $1
     GROUP BY c.coin_id, c.name, c.symbol, c.current_price
     HAVING SUM(
       CASE 
         WHEN t.type = 'BUY' THEN t.amount
         WHEN t.type = 'SELL' THEN -t.amount
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

exports.processBuyTransaction = async (user_id, coin_id, amount, price_at_transaction) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    // Calculate total cost
    const totalCost = amount * price_at_transaction;
    
    // Check user balance
    const balanceResult = await client.query(
      'SELECT balance FROM users WHERE user_id = $1 FOR UPDATE',
      [user_id]
    );
    
    if (balanceResult.rows[0].balance < totalCost) {
      throw new Error('Insufficient balance');
    }
    
    // Update user balance
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE user_id = $2',
      [totalCost, user_id]
    );
    
    // Record transaction
    const transactionResult = await client.query(
      `INSERT INTO transactions 
       (user_id, coin_id, type, amount, price_at_transaction)
       VALUES ($1, $2, 'BUY', $3, $4)
       RETURNING *`,
      [user_id, coin_id, amount, price_at_transaction]
    );
    
    // Update portfolio
    await exports.updatePortfolio(user_id, coin_id, 'BUY', amount, price_at_transaction);
    
    await client.query('COMMIT');
    return transactionResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

exports.processSellTransaction = async (user_id, coin_id, amount, price_at_transaction) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    // Calculate total value
    const totalValue = amount * price_at_transaction;
    
    // Check portfolio balance
    const portfolioResult = await client.query(
      `SELECT quantity FROM user_portfolio 
       WHERE user_id = $1 AND coin_id = $2 FOR UPDATE`,
      [user_id, coin_id]
    );
    
    if (!portfolioResult.rows[0] || portfolioResult.rows[0].quantity < amount) {
      throw new Error('Insufficient coins in portfolio');
    }
    
    // Update user balance
    await client.query(
      'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
      [totalValue, user_id]
    );
    
    // Record transaction
    const transactionResult = await client.query(
      `INSERT INTO transactions 
       (user_id, coin_id, type, amount, price_at_transaction)
       VALUES ($1, $2, 'SELL', $3, $4)
       RETURNING *`,
      [user_id, coin_id, amount, price_at_transaction]
    );
    
    // Update portfolio
    await exports.updatePortfolio(user_id, coin_id, 'SELL', amount, price_at_transaction);
    
    await client.query('COMMIT');
    return transactionResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
