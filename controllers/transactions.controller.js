const { 
  insertTransaction,
  selectUserTransactions,
  selectTransactionById,
  selectUserPortfolio,
  updatePortfolio,
  processBuyTransaction,
  processSellTransaction
} = require('../models/transactions.model');
const { selectCoinById } = require('../models/coins.model');
const { getUserBalance } = require('../models/users.model');

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

    const transaction = await insertTransaction(user_id, coin_id, type, amount);
    res.status(201).json(transaction);
  } catch (err) {
    next(err);
  }
};

exports.getUserTransactions = async (req, res, next) => {
  try {
    const transactions = await selectUserTransactions(req.params.user_id);
    res.status(200).json(transactions);
  } catch (err) {
    next(err);
  }
};

exports.getTransactionById = async (req, res, next) => {
  try {
    const transaction = await selectTransactionById(req.params.transaction_id);
    if (!transaction) {
      return res.status(404).json({ msg: 'Transaction not found' });
    }
    res.status(200).json(transaction);
  } catch (err) {
    next(err);
  }
};

exports.getPortfolioByUserId = async (req, res, next) => {
  try {
    const portfolio = await selectUserPortfolio(req.params.user_id);
    res.status(200).json(portfolio);
  } catch (err) {
    next(err);
  }
};

// Add new buy transaction controller
exports.processBuyTransaction = async (req, res, next) => {
  try {
    const { user_id, coin_id, amount } = req.body;

    // Validate input
    if (!user_id || !coin_id || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid input parameters' });
    }

    // Check if the authenticated user matches the user_id in the request
    if (req.user.user_id !== parseInt(user_id)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get current coin price
    const coin = await selectCoinById(coin_id);
    if (!coin) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    const transaction = await processBuyTransaction(user_id, coin_id, amount, coin.current_price);
    res.status(201).json(transaction);
  } catch (err) {
    if (err.message === 'Insufficient balance') {
      res.status(400).json({ error: err.message });
    } else {
      next(err);
    }
  }
};

// Add new sell transaction controller
exports.processSellTransaction = async (req, res, next) => {
  try {
    const { user_id, coin_id, amount } = req.body;

    // Validate input
    if (!user_id || !coin_id || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid input parameters' });
    }

    // Check if the authenticated user matches the user_id in the request
    if (req.user.user_id !== parseInt(user_id)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get current coin price
    const coin = await selectCoinById(coin_id);
    if (!coin) {
      return res.status(404).json({ error: 'Coin not found' });
    }

    const transaction = await processSellTransaction(user_id, coin_id, amount, coin.current_price);
    res.status(201).json(transaction);
  } catch (err) {
    if (err.message === 'Insufficient coins in portfolio') {
      res.status(400).json({ error: err.message });
    } else {
      next(err);
    }
  }
};
