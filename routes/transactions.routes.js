const express = require('express');
const { 
  createTransaction,
  getUserTransactions,
  getTransactionById,
  getPortfolioByUserId
} = require('../controllers/transactions.controller');

const transactionsRouter = express.Router();

// Transaction routes
transactionsRouter.post('/', createTransaction);
transactionsRouter.get('/user/:user_id', getUserTransactions);
transactionsRouter.get('/:transaction_id', getTransactionById);

// Portfolio routes (related to transactions)
transactionsRouter.get('/portfolio/:user_id', getPortfolioByUserId);

module.exports = { transactionsRouter };
