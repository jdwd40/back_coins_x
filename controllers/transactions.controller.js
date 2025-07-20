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
    const { user_id, coin_id, type, amount, price_at_transaction } = req.body;
    
    if (!user_id || !coin_id || !type || !amount || !price_at_transaction) {
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

    // Validate price
    if (price_at_transaction <= 0) {
      return res.status(400).json({ msg: 'Price must be greater than 0' });
    }

    // Check if coin exists
    const coin = await selectCoinById(coin_id);
    if (!coin) {
      return res.status(404).json({ msg: 'Coin not found' });
    }

    // For SELL transactions, check if user has sufficient balance
    if (type.toUpperCase() === 'SELL') {
      const userTransactions = await selectUserTransactions(user_id);
      const coinTransactions = userTransactions.filter(t => t.coin_id === coin_id);
      
      let totalBalance = 0;
      for (const t of coinTransactions) {
        if (t.type === 'BUY') {
          totalBalance += parseFloat(t.quantity);
        } else if (t.type === 'SELL') {
          totalBalance -= parseFloat(t.quantity);
        }
      }
      
      if (totalBalance < amount) {
        return res.status(400).json({ msg: 'Insufficient balance for this transaction' });
      }
    }

    const transaction = await insertTransaction(user_id, coin_id, type, amount, price_at_transaction);
    res.status(201).json({ transaction });
  } catch (err) {
    next(err);
  }
};

exports.getUserTransactions = async (req, res, next) => {
  try {
    // Check if the authenticated user matches the user_id in the request
    if (req.user.user_id !== parseInt(req.params.user_id)) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    const transactions = await selectUserTransactions(req.params.user_id);
    res.status(200).json({ transactions });
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
    // Check if the authenticated user matches the user_id in the request
    if (req.user.user_id !== parseInt(req.params.user_id)) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    const portfolio = await selectUserPortfolio(req.params.user_id);
    res.status(200).json({ portfolio });
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
      return res.status(400).json({ 
        status: 'error',
        message: 'Invalid input parameters. Please provide valid user_id, coin_id, and amount greater than 0.' 
      });
    }

    // Check if the authenticated user matches the user_id in the request
    if (req.user.user_id !== parseInt(user_id)) {
      return res.status(401).json({ 
        status: 'error',
        message: 'Unauthorized. You can only make transactions for your own account.' 
      });
    }

    // Get current coin price and check if coin exists
    const coin = await selectCoinById(coin_id);
    if (!coin) {
      return res.status(404).json({ 
        status: 'error',
        message: 'Coin not found. Please provide a valid coin_id.' 
      });
    }

    try {
      const transaction = await processBuyTransaction(user_id, coin_id, amount, coin.current_price);
      res.status(201).json({
        status: 'success',
        message: 'Buy transaction completed successfully',
        data: transaction
      });
    } catch (err) {
      if (err.message === 'Insufficient funds') {
        return res.status(400).json({
          status: 'error',
          message: `Insufficient funds. You need ${(amount * coin.current_price).toFixed(2)} to complete this purchase.`,
          required_amount: amount * coin.current_price,
          current_price: coin.current_price
        });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
};

// Add new sell transaction controller
exports.processSellTransaction = async (req, res, next) => {
  try {
    const { user_id, coin_id, amount } = req.body;

    // Validate input
    if (!user_id || !coin_id || !amount || amount <= 0) {
      return res.status(400).json({ 
        status: 'error',
        message: 'Invalid input parameters. Please provide valid user_id, coin_id, and amount greater than 0.' 
      });
    }

    // Check if the authenticated user matches the user_id in the request
    if (req.user.user_id !== parseInt(user_id)) {
      return res.status(401).json({ 
        status: 'error',
        message: 'Unauthorized. You can only make transactions for your own account.' 
      });
    }

    // Get current coin price and check if coin exists
    const coin = await selectCoinById(coin_id);
    if (!coin) {
      return res.status(404).json({ 
        status: 'error',
        message: 'Coin not found. Please provide a valid coin_id.' 
      });
    }

    try {
      const transaction = await processSellTransaction(user_id, coin_id, amount, coin.current_price);
      res.status(201).json({
        status: 'success',
        message: 'Sell transaction completed successfully',
        data: transaction
      });
    } catch (err) {
      if (err.message === 'Insufficient coins in portfolio') {
        // Get current portfolio balance
        const portfolio = await selectUserPortfolio(user_id);
        const coinPortfolio = portfolio.find(p => p.coin_id === coin_id);
        const available = coinPortfolio ? coinPortfolio.quantity : 0;

        return res.status(400).json({
          status: 'error',
          message: `Insufficient coins in portfolio. You have ${available} coins available to sell.`,
          available_amount: available,
          requested_amount: amount
        });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
};
