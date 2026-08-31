const { 
  selectUserTransactions,
  selectTransactionById,
  selectUserPortfolio,
  processBuyTransaction,
  processSellTransaction
} = require('../models/transactions.model');
const { selectCoinRawById } = require('../models/coins.model');
const { getUserFunds } = require('../models/users.model');
const { isCoinCollapsed } = require('../game/dynamicCollapseService');

// V2 legacy cleanup (#22): exports.createTransaction (the root POST
// /api/transactions handler) is removed with its route. It trusted
// caller-supplied price_at_transaction and inserted a ledger row without any
// authoritative funds/portfolio mutation — an integrity hole, not a
// compatibility path. The current frontend never called it (only /buy,
// /sell, /portfolio/:user_id and /user/:user_id are used).

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

    const user_id = parseInt(req.params.user_id);
    const [portfolio, userFunds] = await Promise.all([
      selectUserPortfolio(user_id),
      getUserFunds(user_id)
    ]);
    
    res.status(200).json({ 
      portfolio,
      user_funds: userFunds
    });
  } catch (err) {
    next(err);
  }
};

// Add new buy transaction controller
exports.processBuyTransaction = async (req, res, next) => {
  try {
    const { user_id, coin_id, amount } = req.body;
    const numericAmount = Number(amount);

    // Validate input
    if (!user_id || !coin_id || !Number.isFinite(numericAmount) || numericAmount <= 0) {
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
    // Use the unformatted row: selectCoinById returns a GBP display
    // string that is invalid input for numeric SQL parameters.
    const coin = await selectCoinRawById(coin_id);
    if (!coin) {
      return res.status(404).json({
        status: 'error',
        message: 'Coin not found. Please provide a valid coin_id.'
      });
    }

    // Migration 014: a retired coin is preserved history, not catalogue —
    // new purchases are rejected, but its rows, price history and any
    // existing holdings remain readable and sellable.
    if (coin.retired) {
      return res.status(400).json({
        status: 'error',
        message: 'This coin has been retired from the catalogue and cannot be purchased.'
      });
    }

    // Core 3 narrow price-zero compatibility guard: a coin collapsed in the
    // ACTIVE apocalypse cycle is permanently dead for the rest of the cycle
    // (live price exactly £0). Reject new purchases with a clear domain error —
    // buying at £0 would hand out free coins for nothing. Death is read from
    // the persisted collapse schedule execution state, not inferred from the
    // price. Selling an existing dead holding remains possible and cannot
    // create cash: its £0 live price values the sale at exactly £0.
    if (await isCoinCollapsed(coin_id)) {
      return res.status(400).json({
        status: 'error',
        message: 'This coin has collapsed to £0 in the current apocalypse cycle and cannot be purchased.'
      });
    }

    try {
      const transaction = await processBuyTransaction(user_id, coin_id, numericAmount, coin.current_price);
      res.status(201).json({
        status: 'success',
        message: 'Buy transaction completed successfully',
        data: transaction
      });
    } catch (err) {
      if (err.message === 'Insufficient funds') {
        return res.status(400).json({
          status: 'error',
          message: `Insufficient funds. You need ${(numericAmount * coin.current_price).toFixed(2)} to complete this purchase.`,
          required_amount: numericAmount * coin.current_price,
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
    const numericAmount = Number(amount);

    // Validate input
    if (!user_id || !coin_id || !Number.isFinite(numericAmount) || numericAmount <= 0) {
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
    // Use the unformatted row: selectCoinById returns a GBP display
    // string that is invalid input for numeric SQL parameters.
    const coin = await selectCoinRawById(coin_id);
    if (!coin) {
      return res.status(404).json({
        status: 'error',
        message: 'Coin not found. Please provide a valid coin_id.'
      });
    }

    try {
      const transaction = await processSellTransaction(user_id, coin_id, numericAmount, coin.current_price);
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
