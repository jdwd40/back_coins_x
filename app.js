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
  if (err.status && err.msg) {
    res.status(err.status).send({ msg: err.msg });
  } else {
    console.error(err);
    res.status(500).send({ msg: 'Internal Server Error' });
  }
});

// Start market simulation in production
if (process.env.NODE_ENV === 'production') {
  marketSimulator.start();
}

module.exports = app;
