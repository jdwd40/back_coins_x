const express = require('express');
const cors = require('cors');
const app = express();

// Import route files (to be created)
const { coinsRouter } = require('./routes/coins.routes');
const { usersRouter } = require('./routes/users.routes');
const { transactionsRouter } = require('./routes/transactions.routes');

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/coins', coinsRouter);
app.use('/api/users', usersRouter);
app.use('/api/transactions', transactionsRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  if (err.status && err.msg) {
    res.status(err.status).send({ msg: err.msg });
  } else {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send({ msg: 'Internal Server Error' });
});

module.exports = app;
