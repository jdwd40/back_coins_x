const { 
  insertTransaction,
  selectUserTransactions,
  selectTransactionById,
  selectUserPortfolio,
  updatePortfolio
} = require('../models/transactions.model');

exports.createTransaction = async (req, res, next) => {
  try {
    const { user_id, coin_id, type, amount } = req.body;
    
    if (!user_id || !coin_id || !type || !amount) {
      return res.status(400).json({ msg: 'Missing required fields' });
    }

    // Check if the authenticated user matches the user_id in the request
    if (req.user.user_id !== user_id) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    if (!['BUY', 'SELL'].includes(type.toUpperCase())) {
      return res.status(400).json({ msg: 'Invalid transaction type' });
    }

    // Validate amount
    if (amount <= 0) {
      return res.status(400).json({ msg: 'Amount must be greater than 0' });
    }

    // Get current coin price and supply
    const coinResult = await db.query(
      'SELECT current_price, available_supply FROM coins WHERE coin_id = $1',
      [coin_id]
    );

    if (coinResult.rows.length === 0) {
      return res.status(404).json({ msg: 'Coin not found' });
    }

    const { current_price, available_supply } = coinResult.rows[0];
    const total_amount = amount * current_price;

    // Get user's current balance
    const userResult = await db.query(
      'SELECT balance FROM users WHERE user_id = $1',
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ msg: 'User not found' });
    }

    const { balance } = userResult.rows[0];

    if (type.toUpperCase() === 'BUY') {
      // Check if user has enough balance
      if (balance < total_amount) {
        return res.status(400).json({ msg: 'Insufficient balance' });
      }

      // Check if there's enough supply
      if (amount > available_supply) {
        return res.status(400).json({ msg: 'Insufficient coin supply' });
      }
    } else {
      // For SELL operations, check if user has enough coins
      const portfolioResult = await db.query(
        `SELECT quantity FROM user_portfolio 
         WHERE user_id = $1 AND coin_id = $2`,
        [user_id, coin_id]
      );

      const userCoins = portfolioResult.rows[0]?.quantity || 0;
      if (amount > userCoins) {
        return res.status(400).json({ msg: 'Insufficient coins in portfolio' });
      }
    }

    // Start a database transaction
    await db.query('BEGIN');

    try {
      // Record the transaction
      const transaction = await insertTransaction(
        user_id,
        coin_id,
        type,
        amount,
        current_price
      );

      // Update the user's portfolio
      await updatePortfolio(
        user_id,
        coin_id,
        type,
        amount,
        current_price
      );

      // Update user's balance
      await db.query(
        `UPDATE users 
         SET balance = balance ${type.toUpperCase() === 'BUY' ? '-' : '+'} $1
         WHERE user_id = $2`,
        [total_amount, user_id]
      );

      // Update coin supply
      await db.query(
        `UPDATE coins 
         SET available_supply = available_supply ${type.toUpperCase() === 'BUY' ? '-' : '+'} $1
         WHERE coin_id = $2`,
        [amount, coin_id]
      );

      await db.query('COMMIT');

      // Fetch the complete transaction details with coin information
      const completedTransaction = await selectTransactionById(transaction.transaction_id);
      
      res.status(201).json({
        msg: `Successfully ${type.toLowerCase()}ed coins`,
        transaction: completedTransaction
      });
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    next(err);
  }
};

exports.getUserTransactions = async (req, res, next) => {
  try {
    const { user_id } = req.params;

    // Check if the authenticated user matches the requested user_id
    if (req.user.user_id !== parseInt(user_id)) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    const transactions = await selectUserTransactions(parseInt(user_id));
    res.status(200).json({ transactions });
  } catch (err) {
    next(err);
  }
};

exports.getTransactionById = async (req, res, next) => {
  try {
    const { transaction_id } = req.params;
    const transaction = await selectTransactionById(parseInt(transaction_id));

    // Check if the authenticated user matches the transaction's user_id
    if (req.user.user_id !== transaction.user_id) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    if (!transaction) {
      return res.status(404).json({ msg: 'Transaction not found' });
    }

    res.status(200).json({ transaction });
  } catch (err) {
    next(err);
  }
};

exports.getPortfolioByUserId = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    
    if (isNaN(user_id)) {
      return res.status(400).json({ msg: 'Invalid user ID' });
    }

    // Check if the authenticated user matches the requested user_id
    if (req.user.user_id !== parseInt(user_id)) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    const portfolio = await selectUserPortfolio(user_id);
    res.status(200).json({ portfolio });
  } catch (err) {
    next(err);
  }
};
