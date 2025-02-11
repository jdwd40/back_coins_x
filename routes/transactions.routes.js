const express = require('express');
const { 
  createTransaction,
  getUserTransactions,
  getTransactionById,
  getPortfolioByUserId,
  processBuyTransaction,
  processSellTransaction
} = require('../controllers/transactions.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const transactionsRouter = express.Router();

// All transaction routes are protected
transactionsRouter.use(authenticateToken);

// Transaction routes
transactionsRouter.post('/', createTransaction);
transactionsRouter.post('/buy', processBuyTransaction);
transactionsRouter.post('/sell', processSellTransaction);
transactionsRouter.get('/user/:user_id', getUserTransactions);
transactionsRouter.get('/:transaction_id', getTransactionById);
transactionsRouter.get('/portfolio/:user_id', getPortfolioByUserId);

module.exports = { transactionsRouter };
