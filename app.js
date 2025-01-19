const express = require('express');
const cors = require('cors');
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

// 404 handler
app.all('/*', (req, res) => {
  res.status(404).send({ msg: 'Route not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error caught in global error handler:', err);
  if (err.code === '23505') { // Unique violation
    res.status(409).json({ msg: 'Resource already exists' });
  } else if (err.code === '23503') { // Foreign key violation
    res.status(404).json({ msg: 'Referenced resource not found' });
  } else if (err.code === '22P02') { // Invalid text representation
    res.status(400).json({ msg: 'Invalid input syntax' });
  } else {
    res.status(500).json({ msg: 'Internal Server Error', error: err.message });
  }
});

// Start market simulation in production
if (process.env.NODE_ENV === 'production') {
  marketSimulator.start();
}

module.exports = app;
