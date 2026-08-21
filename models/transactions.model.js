const db = require('../db/connection');

exports.insertTransaction = async (user_id, coin_id, type, amount, price_at_transaction) => {
  // Validate inputs
  if (!user_id || !coin_id || !type || !amount || !price_at_transaction) {
    throw new Error('Missing required fields for transaction');
  }

  // Ensure type is either 'buy' or 'sell'
  const normalizedType = type.toUpperCase();
  if (!['BUY', 'SELL'].includes(normalizedType)) {
    throw new Error('Invalid transaction type');
  }

  try {
    const result = await db.query(
      `INSERT INTO transactions 
       (user_id, coin_id, type, quantity, price, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING 
         transaction_id,
         user_id,
         coin_id,
         type,
         quantity,
         price,
         total_amount,
         created_at`,
      [user_id, coin_id, normalizedType, amount, price_at_transaction, amount * price_at_transaction]
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
         c.symbol,
         t.type,
         t.quantity,
         t.price,
         t.total_amount,
         t.created_at
       FROM transactions t
       JOIN coins c ON t.coin_id = c.coin_id
       WHERE t.user_id = $1
       ORDER BY t.created_at DESC`,
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
         c.symbol,
         t.type,
         t.quantity,
         t.price,
         t.total_amount,
         t.created_at
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
           WHEN t.type = 'BUY' THEN t.quantity
           WHEN t.type = 'SELL' THEN -t.quantity
         END
       ) as total_amount,
       SUM(
         CASE 
           WHEN t.type = 'BUY' THEN t.total_amount
           WHEN t.type = 'SELL' THEN -t.total_amount
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

// Milestone 1: portfolio writes inside a buy/sell MUST run on the operation's
// own transaction client. This internal variant takes the client explicitly;
// the exported updatePortfolio below preserves the legacy pool-based API for
// any other caller.
const updatePortfolioOnClient = async (client, user_id, coin_id, type, amount) => {
  // Check if portfolio entry exists
  const portfolioResult = await client.query(
    'SELECT quantity FROM portfolios WHERE user_id = $1 AND coin_id = $2',
    [user_id, coin_id]
  );

  const quantityChange = type === 'BUY' ? amount : -amount;

  if (portfolioResult.rows.length === 0) {
    // Create new portfolio entry if it doesn't exist
    await client.query(
      `INSERT INTO portfolios (user_id, coin_id, quantity)
       VALUES ($1, $2, $3)`,
      [user_id, coin_id, quantityChange]
    );
  } else {
    // Update existing portfolio entry
    await client.query(
      `UPDATE portfolios
       SET quantity = quantity + $1
       WHERE user_id = $2 AND coin_id = $3`,
      [quantityChange, user_id, coin_id]
    );
  }
};

exports.updatePortfolio = async (user_id, coin_id, type, amount, price_at_transaction) => {
  try {
    await updatePortfolioOnClient(db, user_id, coin_id, type, amount);
  } catch (error) {
    throw error;
  }
};

// Milestone 1: exactly ONE acquired pg client owns the whole legacy buy —
// BEGIN, the FOR UPDATE validation read, the funds mutation, the ledger
// insert, the portfolio write, COMMIT or ROLLBACK, and finally release. The
// previous pool-per-statement shape made the row locks and the rollback
// illusory under concurrency. Public API and error contract are unchanged.
exports.processBuyTransaction = async (user_id, coin_id, amount, price_at_transaction) => {
  const client = await db.getClient();
  try {
    // Start a database transaction on THIS client
    await client.query('BEGIN');
    
    // Calculate total cost
    const totalCost = amount * price_at_transaction;
    
    // Check user funds (row lock held to COMMIT on this same connection)
    const fundsResult = await client.query(
      'SELECT funds FROM users WHERE user_id = $1 FOR UPDATE',
      [user_id]
    );
    
    if (!fundsResult.rows[0] || parseFloat(fundsResult.rows[0].funds) < totalCost) {
      throw new Error('Insufficient funds');
    }
    
    // Update user funds
    await client.query(
      'UPDATE users SET funds = funds - $1 WHERE user_id = $2',
      [totalCost, user_id]
    );
    
    // Record transaction
    const transactionResult = await client.query(
      `INSERT INTO transactions 
       (user_id, coin_id, type, quantity, price, total_amount)
       VALUES ($1, $2, 'BUY', $3, $4, $5)
       RETURNING *`,
      [user_id, coin_id, amount, price_at_transaction, totalCost]
    );
    
    // Update portfolio (same connection, same transaction)
    await updatePortfolioOnClient(client, user_id, coin_id, 'BUY', amount);
    
    await client.query('COMMIT');
    return transactionResult.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
};

// Milestone 1: same single-client ownership for the legacy sell — the FOR
// UPDATE holding lock is real now, so concurrent sells serialise on this
// connection's row lock and can never oversell.
exports.processSellTransaction = async (user_id, coin_id, amount, price_at_transaction) => {
  const client = await db.getClient();
  try {
    // Start a database transaction on THIS client
    await client.query('BEGIN');
    
    // Calculate total value
    const totalValue = amount * price_at_transaction;
    
    // Check portfolio balance (row lock held to COMMIT on this connection)
    const portfolioResult = await client.query(
      `SELECT quantity FROM portfolios 
       WHERE user_id = $1 AND coin_id = $2 FOR UPDATE`,
      [user_id, coin_id]
    );
    
    if (!portfolioResult.rows[0] || parseFloat(portfolioResult.rows[0].quantity) < amount) {
      throw new Error('Insufficient coins in portfolio');
    }
    
    // Update user funds
    await client.query(
      'UPDATE users SET funds = funds + $1 WHERE user_id = $2',
      [totalValue, user_id]
    );
    
    // Record transaction
    const transactionResult = await client.query(
      `INSERT INTO transactions 
       (user_id, coin_id, type, quantity, price, total_amount)
       VALUES ($1, $2, 'SELL', $3, $4, $5)
       RETURNING *`,
      [user_id, coin_id, amount, price_at_transaction, totalValue]
    );
    
    // Update portfolio (same connection, same transaction)
    await updatePortfolioOnClient(client, user_id, coin_id, 'SELL', amount);
    
    await client.query('COMMIT');
    return transactionResult.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
};
