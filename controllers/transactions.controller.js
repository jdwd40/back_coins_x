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
      return res.status(400).send({ msg: 'Missing required fields' });
    }

    if (!['buy', 'sell'].includes(type)) {
      return res.status(400).send({ msg: 'Invalid transaction type' });
    }

    // Start a transaction to ensure portfolio is updated atomically
    const transaction = await insertTransaction(
      user_id,
      coin_id,
      type,
      amount,
      price_at_transaction
    );

    // Update portfolio
    await updatePortfolio(user_id, coin_id, type, amount, price_at_transaction);

    res.status(201).send({ transaction });
  } catch (err) {
    if (err.message === 'Insufficient balance') {
      return res.status(400).send({ msg: 'Insufficient balance for this transaction' });
    }
    next(err);
  }
};

exports.getUserTransactions = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    
    if (isNaN(user_id)) {
      return res.status(400).send({ msg: 'Invalid user ID' });
    }

    const transactions = await selectUserTransactions(user_id);
    res.status(200).send({ transactions });
  } catch (err) {
    next(err);
  }
};

exports.getTransactionById = async (req, res, next) => {
  try {
    const { transaction_id } = req.params;
    
    if (isNaN(transaction_id)) {
      return res.status(400).send({ msg: 'Invalid transaction ID' });
    }

    const transaction = await selectTransactionById(transaction_id);
    
    if (!transaction) {
      return res.status(404).send({ msg: 'Transaction not found' });
    }

    res.status(200).send({ transaction });
  } catch (err) {
    next(err);
  }
};

exports.getPortfolioByUserId = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    
    if (isNaN(user_id)) {
      return res.status(400).send({ msg: 'Invalid user ID' });
    }

    const portfolio = await selectUserPortfolio(user_id);
    res.status(200).send({ portfolio });
  } catch (err) {
    next(err);
  }
};
