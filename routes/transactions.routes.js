const express = require('express');
const { 
  createTransaction,
  getUserTransactions,
  getTransactionById,
  getPortfolioByUserId,
  processBuyTransaction,
  processSellTransaction,
  selectUserTransactions,
  selectUserPortfolio,
  getUserBalance
} = require('../controllers/transactions.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { selectCoinById } = require('../models/coins.model');

const transactionsRouter = express.Router();

// All transaction routes are protected
transactionsRouter.use(authenticateToken);

// Transaction routes
transactionsRouter.post('/', createTransaction);
transactionsRouter.get('/user/:user_id', async (req, res, next) => {
  try {
    const transactions = await selectUserTransactions(req.params.user_id);
    res.status(200).json(transactions);
  } catch (err) {
    next(err);
  }
});
transactionsRouter.get('/:transaction_id', getTransactionById);

// Portfolio routes (related to transactions)
transactionsRouter.get('/portfolio/:user_id', async (req, res, next) => {
  try {
    const portfolio = await selectUserPortfolio(req.params.user_id);
    res.status(200).json(portfolio);
  } catch (err) {
    next(err);
  }
});

// Buy/Sell routes
transactionsRouter.post('/buy', async (req, res, next) => {
  try {
    const { user_id, coin_id, amount } = req.body;
    
    // Validate input
    if (!user_id || !coin_id || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid input parameters' });
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
});

transactionsRouter.post('/sell', async (req, res, next) => {
  try {
    const { user_id, coin_id, amount } = req.body;
    
    // Validate input
    if (!user_id || !coin_id || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid input parameters' });
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
});

transactionsRouter.get('/balance/:user_id', async (req, res, next) => {
  try {
    const balance = await getUserBalance(req.params.user_id);
    res.status(200).json({ balance });
  } catch (err) {
    next(err);
  }
});

module.exports = { transactionsRouter };
