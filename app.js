const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');
const app = express();

// Import route files (to be created)
const { coinsRouter } = require('./routes/coins.routes');
const { usersRouter } = require('./routes/users.routes');
const { transactionsRouter } = require('./routes/transactions.routes');
const { marketRouter } = require('./routes/market.routes');

const marketSimulator = require('./models/market-simulator');

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/coins', coinsRouter);
app.use('/api/users', usersRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/market', marketRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Error:', err.message);
  logger.error('Stack:', err.stack);

  // Handle database connection errors
  if (err.message === 'Database connection error' || 
      err.message.includes('Connection terminated') ||
      err.message.includes('Connection refused') ||
      err.message.includes('Connection timeout')) {
    return res.status(503).json({ 
      msg: 'Database service unavailable. Please try again later.' 
    });
  }

  // Handle database errors
  if (err.code === '22P02') {
    return res.status(400).json({ msg: 'Invalid input syntax' });
  }

  if (err.code === '22003') {
    return res.status(400).json({ 
      msg: 'Invalid price format. Must be a number or a valid GBP string (e.g., £10.00)' 
    });
  }

  // Handle validation errors
  if (err.message && err.message.includes('Invalid price format')) {
    return res.status(400).json({ 
      msg: 'Invalid price format. Must be a number or a valid GBP string (e.g., £10.00)' 
    });
  }

  // Handle unique violation
  if (err.code === '23505') { 
    return res.status(409).json({ msg: 'Resource already exists' });
  } 

  // Handle foreign key violation
  if (err.code === '23503') { 
    return res.status(404).json({ msg: 'Referenced resource not found' });
  }

  // Handle numeric value out of range
  if (err.code === '22003') {
    return res.status(400).json({ 
      msg: 'Invalid price format. Must be a number or a valid GBP string (e.g., £10.00)' 
    });
  }

  // Handle transaction errors
  if (err.message.includes('ROLLBACK') || err.message.includes('COMMIT')) {
    return res.status(500).json({ 
      msg: 'Transaction failed. Please try again.' 
    });
  }

  // Default error
  res.status(500).json({ msg: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Start market simulation in production
if (process.env.NODE_ENV === 'production') {
  marketSimulator.start();
}

module.exports = app;
