const express = require('express');
const { 
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
// V2 legacy cleanup (#22): the root POST /api/transactions mutation is
// deliberately REMOVED — it inserted a ledger row from caller-supplied
// price_at_transaction with no authoritative funds/portfolio mutation, so an
// authenticated caller could create phantom/inconsistent financial state.
// Authenticated callers now receive 404 here; the only write paths are the
// authoritative /buy and /sell below.
transactionsRouter.post('/buy', processBuyTransaction);
transactionsRouter.post('/sell', processSellTransaction);
transactionsRouter.get('/user/:user_id', getUserTransactions);
transactionsRouter.get('/:transaction_id', getTransactionById);
transactionsRouter.get('/portfolio/:user_id', getPortfolioByUserId);

module.exports = { transactionsRouter };
