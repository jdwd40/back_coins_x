const { 
  insertTransaction,
  selectUserTransactions,
  selectTransactionById,
  selectUserPortfolio,
  updatePortfolio
} = require('../models/transactions.model');

exports.createTransaction = async (req, res, next) => {
  try {
    const { user_id, coin_id, type, amount, price_at_transaction } = req.body;
    
    if (!user_id || !coin_id || !type || !amount || !price_at_transaction) {
      return res.status(400).json({ msg: 'Missing required fields' });
    }

    // Check if the authenticated user matches the user_id in the request
    if (req.user.user_id !== user_id) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    if (!['buy', 'sell'].includes(type.toLowerCase())) {
      return res.status(400).json({ msg: 'Invalid transaction type' });
    }

    // Start a transaction to ensure portfolio is updated atomically
    const transaction = await insertTransaction(
      user_id,
      coin_id,
      type.toLowerCase(),
      amount,
      price_at_transaction
    );

    // Update portfolio
    await updatePortfolio(user_id, coin_id, type.toLowerCase(), amount, price_at_transaction);

    res.status(201).json({ transaction });
  } catch (err) {
    if (err.message === 'Insufficient balance') {
      return res.status(400).json({ msg: 'Insufficient balance for this transaction' });
    }
    next(err);
  }
};

exports.getUserTransactions = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    
    if (isNaN(user_id)) {
      return res.status(400).json({ msg: 'Invalid user ID' });
    }

    // Check if the authenticated user matches the requested user_id
    if (req.user.user_id !== parseInt(user_id)) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    const transactions = await selectUserTransactions(user_id);
    res.status(200).json({ transactions });
  } catch (err) {
    next(err);
  }
};

exports.getTransactionById = async (req, res, next) => {
  try {
    const { transaction_id } = req.params;
    
    if (isNaN(transaction_id)) {
      return res.status(400).json({ msg: 'Invalid transaction ID' });
    }

    const transaction = await selectTransactionById(transaction_id);
    
    if (!transaction) {
      return res.status(404).json({ msg: 'Transaction not found' });
    }

    // Check if the authenticated user owns this transaction
    if (req.user.user_id !== transaction.user_id) {
      return res.status(401).json({ msg: 'Unauthorized' });
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
